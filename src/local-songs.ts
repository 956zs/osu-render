import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { validateArchiveEntryName } from './archive.js';
import { log } from './logger.js';

/** One indexed .osu file from an osu!stable Songs folder. */
export interface LocalBeatmap {
  md5: string;
  osu_path: string;
  set_dir: string;
  size: number;
  mtime: number;
  beatmap_id: number | null;
  beatmapset_id: number | null;
  title: string | null;
  artist: string | null;
  version: string | null;
  length_ms: number | null;
}

export interface OsuFileMetadata {
  beatmapId: number | null;
  beatmapsetId: number | null;
  title: string | null;
  artist: string | null;
  version: string | null;
  /** End time of the last hit object; null when the file has none. */
  lengthMs: number | null;
}

export interface LocalSongsStatus {
  state: 'disabled' | 'idle' | 'scanning' | 'ready' | 'failed';
  dirs: number;
  filesSeen: number;
  hashed: number;
  indexed: number;
  skippedLinks: number;
  truncated: boolean;
  durationMs?: number;
  error?: string;
}

export interface LocalSongsOptions {
  maxFiles: number;
  progressEvery: number;
}

export interface CopyLimits {
  maxEntries: number;
  maxExtractedBytes: number;
}

/**
 * OSU_SONGS_DIRS (separated like PATH) wins. Without it, Windows uses %LOCALAPPDATA%\osu!\Songs when that folder
 * exists and auto-detection is on. osu!lazer stores files by hash, so it is not supported.
 */
export function resolveSongsDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  autoDetect: boolean,
  exists: (directory: string) => boolean = existsSync,
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const raw = env.OSU_SONGS_DIRS?.trim();
  if (raw) {
    return [...new Set(raw.split(pathApi.delimiter).map((entry) => entry.trim()).filter(Boolean)
      .map((entry) => pathApi.resolve(entry)))];
  }
  const localAppData = env.LOCALAPPDATA?.trim();
  if (platform !== 'win32' || !autoDetect || !localAppData) return [];
  const detected = pathApi.join(localAppData, 'osu!', 'Songs');
  return exists(detected) ? [detected] : [];
}

export function parseOsuMetadata(text: string): OsuFileMetadata {
  const result: OsuFileMetadata = { beatmapId: null, beatmapsetId: null, title: null, artist: null, version: null, lengthMs: null };
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) { section = header[1]; continue; }
    if (section === 'Metadata') {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === 'Title') result.title = value || null;
      else if (key === 'Artist') result.artist = value || null;
      else if (key === 'Version') result.version = value || null;
      else if (key === 'BeatmapID') result.beatmapId = onlineId(value);
      else if (key === 'BeatmapSetID') result.beatmapsetId = onlineId(value);
    } else if (section === 'HitObjects') {
      const end = hitObjectEnd(line);
      if (end !== null) result.lengthMs = Math.max(result.lengthMs ?? 0, end);
    }
  }
  return result;
}

export class LocalSongsIndex {
  private current: LocalSongsStatus;
  private scanning: Promise<void> | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly dirs: readonly string[],
    private readonly options: LocalSongsOptions,
  ) {
    this.current = {
      state: dirs.length === 0 ? 'disabled' : 'idle', dirs: dirs.length,
      filesSeen: 0, hashed: 0, indexed: this.count(), skippedLinks: 0, truncated: false,
    };
  }

  status(): LocalSongsStatus {
    return { ...this.current };
  }

  /** Starts a background scan; resolves when it ends. Never rejects. */
  scan(): Promise<void> {
    if (this.dirs.length === 0) return Promise.resolve();
    this.scanning ??= this.runScan().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  /** Index row for the checksum, re-checked against the file on disk; stale rows are dropped. */
  async lookup(md5: string): Promise<LocalBeatmap | null> {
    if (this.dirs.length === 0) return null;
    const row = this.db.prepare('SELECT * FROM local_beatmaps WHERE md5 = ?').get(md5) as LocalBeatmap | undefined;
    if (!row) return null;
    try {
      const info = await lstat(row.osu_path);
      if (!info.isFile()) throw new Error('not a regular file');
      if (info.size === row.size && Math.floor(info.mtimeMs) === row.mtime) return row;
      if (md5Hex(await readFile(row.osu_path)) !== md5) throw new Error('file changed');
      this.db.prepare('UPDATE local_beatmaps SET size = ?, mtime = ? WHERE md5 = ?').run(info.size, Math.floor(info.mtimeMs), md5);
      return { ...row, size: info.size, mtime: Math.floor(info.mtimeMs) };
    } catch {
      this.db.prepare('DELETE FROM local_beatmaps WHERE md5 = ?').run(md5);
      return null;
    }
  }

  private async runScan(): Promise<void> {
    const started = Date.now();
    this.current = { ...this.current, state: 'scanning', filesSeen: 0, hashed: 0, skippedLinks: 0, truncated: false };
    delete this.current.error;
    log('info', 'local_songs_scan_started', { component: 'local-songs', dirs: this.dirs.length });
    try {
      const known = new Map((this.db.prepare('SELECT osu_path, size, mtime FROM local_beatmaps').all() as
        Array<{ osu_path: string; size: number; mtime: number }>).map((row) => [row.osu_path, row]));
      const seen = new Set<string>();
      for (const root of this.dirs) {
        if (this.current.truncated) break;
        await this.scanRoot(root, known, seen);
      }
      if (!this.current.truncated) {
        const remove = this.db.prepare('DELETE FROM local_beatmaps WHERE osu_path = ?');
        this.db.transaction(() => { for (const file of known.keys()) if (!seen.has(file)) remove.run(file); })();
      }
      this.current = { ...this.current, state: 'ready', indexed: this.count(), durationMs: Date.now() - started };
      log('info', 'local_songs_scan_finished', { component: 'local-songs', ...this.current });
    } catch (error) {
      this.current = {
        ...this.current, state: 'failed', indexed: this.count(), durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
      log('warn', 'local_songs_scan_failed', { component: 'local-songs', ...this.current });
    }
  }

  private async scanRoot(root: string, known: Map<string, { size: number; mtime: number }>, seen: Set<string>): Promise<void> {
    let sets;
    try {
      if (!(await stat(root)).isDirectory()) return;
      sets = await readdir(root, { withFileTypes: true });
    } catch { return; }
    const upsert = this.db.prepare(`INSERT INTO local_beatmaps
      (md5, osu_path, set_dir, size, mtime, beatmap_id, beatmapset_id, title, artist, version, length_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(md5) DO UPDATE SET osu_path=excluded.osu_path, set_dir=excluded.set_dir, size=excluded.size,
      mtime=excluded.mtime, beatmap_id=excluded.beatmap_id, beatmapset_id=excluded.beatmapset_id,
      title=excluded.title, artist=excluded.artist, version=excluded.version, length_ms=excluded.length_ms`);
    const removeByPath = this.db.prepare('DELETE FROM local_beatmaps WHERE osu_path = ?');
    for (const set of sets) {
      // Dirent types come from lstat semantics: symlinks and Windows junctions are never isDirectory().
      if (set.isSymbolicLink()) { this.current.skippedLinks += 1; continue; }
      if (!set.isDirectory()) continue;
      const setDir = path.join(root, set.name);
      let files;
      try { files = await readdir(setDir, { withFileTypes: true }); } catch { continue; }
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.osu')) continue;
        if (file.isSymbolicLink()) { this.current.skippedLinks += 1; continue; }
        if (!file.isFile()) continue;
        if (this.current.filesSeen >= this.options.maxFiles) {
          this.current.truncated = true;
          log('warn', 'local_songs_scan_truncated', { component: 'local-songs', maxFiles: this.options.maxFiles });
          return;
        }
        this.current.filesSeen += 1;
        if (this.current.filesSeen % this.options.progressEvery === 0) {
          log('info', 'local_songs_scan_progress', { component: 'local-songs', filesSeen: this.current.filesSeen, hashed: this.current.hashed });
        }
        const osuPath = path.join(setDir, file.name);
        seen.add(osuPath);
        try {
          const info = await lstat(osuPath);
          if (!info.isFile()) continue;
          const mtime = Math.floor(info.mtimeMs);
          const previous = known.get(osuPath);
          if (previous && previous.size === info.size && previous.mtime === mtime) continue;
          const content = await readFile(osuPath);
          const metadata = parseOsuMetadata(content.toString('utf8'));
          removeByPath.run(osuPath);
          upsert.run(md5Hex(content), osuPath, setDir, info.size, mtime, metadata.beatmapId, metadata.beatmapsetId,
            metadata.title, metadata.artist, metadata.version, metadata.lengthMs);
          this.current.hashed += 1;
        } catch { /* unreadable file: skip it, the next scan tries again */ }
      }
    }
  }

  private count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM local_beatmaps').get() as { count: number }).count;
  }
}

/**
 * Copies a beatmap set folder: regular files and real directories only (links are skipped), names checked with the
 * archive validator, and the same entry and size limits as an extracted .osz.
 */
export async function copySetFolder(source: string, destination: string, limits: CopyLimits): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const totals = { entries: 0, bytes: 0 };
  try {
    await copyDirectory(source, destination, '', limits, totals);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function copyDirectory(source: string, destination: string, relative: string, limits: CopyLimits,
  totals: { entries: number; bytes: number }): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    validateArchiveEntryName(name);
    totals.entries += 1;
    if (totals.entries > limits.maxEntries) throw new Error('set folder has too many files');
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to);
      await copyDirectory(from, to, name, limits, totals);
      continue;
    }
    const info = await lstat(from);
    if (!info.isFile()) continue;
    totals.bytes += info.size;
    if (totals.bytes > limits.maxExtractedBytes) throw new Error('set folder is too large');
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }
}

function hitObjectEnd(line: string): number | null {
  const fields = line.split(',');
  if (fields.length < 4) return null;
  const time = Number(fields[2]);
  const type = Number(fields[3]);
  if (!Number.isFinite(time) || !Number.isInteger(type)) return null;
  // Spinners (8) and mania holds (128) carry an end time in field 6; sliders are counted from their start.
  if ((type & 8 || type & 128) && fields[5] !== undefined) {
    const end = Number(fields[5].split(':')[0]);
    if (Number.isFinite(end)) return Math.max(time, end);
  }
  return time;
}

function onlineId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function md5Hex(content: Buffer): string {
  return createHash('md5').update(content).digest('hex');
}
