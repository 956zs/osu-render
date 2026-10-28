import { randomUUID } from 'node:crypto';
import { access, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { directorySize, extractOsz, installExtracted, md5File } from './archive.js';
import type { RenderDatabase } from './database.js';
import type { MirrorChain } from './mirrors.js';
import type { OsuApiClient } from './osu-api.js';
import { copySetFolder, type LocalBeatmap } from './local-songs.js';
import { log } from './logger.js';
import type { BeatmapMetadata, BeatmapRow, Paths } from './types.js';

const MAX_BEATMAP_SECONDS = 15 * 60;

interface ResolverLimits {
  maxCompressedBytes: number;
  maxExtractedBytes: number;
  maxEntries: number;
}

/** Local osu!stable Songs index; see LocalSongsIndex. */
export interface LocalBeatmapSource {
  lookup(md5: string): Promise<LocalBeatmap | null>;
}

interface ResolvedBeatmap {
  metadata: BeatmapMetadata;
  cache: BeatmapRow;
}

export class BeatmapResolver {
  private readonly downloads = new Map<number, Promise<string>>();

  constructor(
    private readonly paths: Paths,
    private readonly database: RenderDatabase,
    private readonly osuApi: OsuApiClient,
    private readonly mirrors: MirrorChain,
    private readonly limits: ResolverLimits,
    private readonly localSongs?: LocalBeatmapSource,
  ) {}

  async resolve(checksum: string, onDownloading: () => void): Promise<ResolvedBeatmap> {
    const cached = await this.findCached(checksum);
    if (cached) return {
      metadata: {
        id: cached.beatmap_id, beatmapsetId: cached.beatmapset_id, checksum,
        title: cached.title ?? undefined, artist: cached.artist ?? undefined, version: cached.version ?? undefined,
      },
      cache: cached,
    };
    const local = await this.resolveLocal(checksum);
    if (local) return local;
    const metadata = await this.osuApi.lookupBeatmap(checksum);
    if ((metadata.totalLength ?? 0) > MAX_BEATMAP_SECONDS) {
      throw new AppError('RENDER_FAILED', 'Beatmap duration exceeds the 15 minute limit.', 422);
    }
    const cachedSet = this.database.findBeatmapset(metadata.beatmapsetId);
    if (cachedSet && await exists(cachedSet.map_path) && await findMatchingOsu(cachedSet.map_path, checksum)) {
      const cache = await this.saveCacheRecord(metadata, checksum, cachedSet.map_path);
      return { metadata, cache };
    }
    onDownloading();
    const mapPath = await this.withDownloadLock(metadata);
    const matchingFile = await findMatchingOsu(mapPath, checksum);
    if (!matchingFile) throw new AppError('BEATMAP_CHECKSUM_MISMATCH', 'Downloaded beatmap does not match replay.', 422);
    const cache = await this.saveCacheRecord(metadata, checksum, mapPath);
    return { metadata, cache };
  }

  /** Copies the set from a local osu!stable Songs folder; any failure falls back to the API and mirrors. */
  private async resolveLocal(checksum: string): Promise<ResolvedBeatmap | null> {
    const local = await this.localSongs?.lookup(checksum).catch(() => null);
    if (!local) return null;
    const metadata: BeatmapMetadata = {
      id: local.beatmap_id ?? 0, beatmapsetId: local.beatmapset_id ?? 0, checksum,
      title: local.title ?? undefined, artist: local.artist ?? undefined, version: local.version ?? undefined,
      ...(local.length_ms !== null ? { totalLength: Math.ceil(local.length_ms / 1000) } : {}),
    };
    if ((metadata.totalLength ?? 0) > MAX_BEATMAP_SECONDS) {
      throw new AppError('RENDER_FAILED', 'Beatmap duration exceeds the 15 minute limit.', 422);
    }
    const token = randomUUID();
    const copying = path.join(this.paths.temp, `local-${token}.copying`);
    const destination = path.join(this.paths.songs, `${metadata.beatmapsetId > 0 ? metadata.beatmapsetId : 'local'}-${token}`);
    try {
      await copySetFolder(local.set_dir, copying, { maxEntries: this.limits.maxEntries, maxExtractedBytes: this.limits.maxExtractedBytes });
      await installExtracted(copying, destination);
      if (!await findMatchingOsu(destination, checksum)) throw new Error('copied set does not contain the replay beatmap');
      const cache = await this.saveCacheRecord(metadata, checksum, destination);
      log('info', 'local_beatmap_used', { component: 'resolver', beatmapsetId: metadata.beatmapsetId });
      return { metadata, cache };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      log('warn', 'local_beatmap_failed', {
        component: 'resolver', detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      await rm(copying, { recursive: true, force: true });
    }
  }

  private async saveCacheRecord(metadata: BeatmapMetadata, checksum: string, mapPath: string): Promise<BeatmapRow> {
    const cache: BeatmapRow = {
      checksum,
      beatmap_id: Math.max(0, metadata.id),
      beatmapset_id: Math.max(0, metadata.beatmapsetId),
      title: metadata.title ?? null, artist: metadata.artist ?? null, version: metadata.version ?? null,
      map_path: mapPath, size_bytes: await directorySize(mapPath),
      created_at: Date.now(),
      last_used_at: Date.now(),
    };
    this.database.saveBeatmap(cache);
    return cache;
  }

  private async findCached(checksum: string): Promise<BeatmapRow | undefined> {
    const cached = this.database.findBeatmap(checksum);
    if (cached && await exists(cached.map_path)) {
      this.database.touchBeatmap(checksum);
      return cached;
    }
    return undefined;
  }

  private async withDownloadLock(metadata: BeatmapMetadata): Promise<string> {
    const current = this.downloads.get(metadata.beatmapsetId);
    if (current) return current;
    const pending = this.downloadAndInstall(metadata)
      .finally(() => this.downloads.delete(metadata.beatmapsetId));
    this.downloads.set(metadata.beatmapsetId, pending);
    return pending;
  }

  private async downloadAndInstall(metadata: BeatmapMetadata): Promise<string> {
    const token = randomUUID();
    const archive = path.join(this.paths.temp, `${metadata.beatmapsetId}-${token}.osz`);
    const extracted = path.join(this.paths.temp, `${metadata.beatmapsetId}-${token}.extracting`);
    const destination = path.join(this.paths.songs, `${metadata.beatmapsetId}-${token}`);
    try {
      await this.mirrors.download(metadata.beatmapsetId, archive, this.limits.maxCompressedBytes);
      await extractOsz(archive, extracted, {
        maxEntries: this.limits.maxEntries,
        maxExtractedBytes: this.limits.maxExtractedBytes,
      });
      await installExtracted(extracted, destination);
      return destination;
    } finally {
      await rm(archive, { force: true });
      await rm(extracted, { recursive: true, force: true });
    }
  }
}

async function findMatchingOsu(root: string, checksum: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const match = await findMatchingOsu(current, checksum);
      if (match) return match;
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.osu')) {
      if (await md5File(current) === checksum) return current;
    }
  }
  return null;
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}
