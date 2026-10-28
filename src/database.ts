import Database from 'better-sqlite3';
import type { BeatmapRow, JobStatus, RenderRow, ReplayMetadata } from './types.js';
import { DEFAULT_RENDER_OPTIONS, RESOLUTION_DIMENSIONS, type RenderOptions } from './render-options.js';
import { limits } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  replay_path TEXT NOT NULL,
  video_path TEXT,
  client_key TEXT NOT NULL,
  player_name TEXT,
  beatmap_checksum TEXT,
  beatmap_id INTEGER,
  beatmapset_id INTEGER,
  mods TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  fps INTEGER NOT NULL,
  encoder TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS renders_queue_idx ON renders(status, created_at);
CREATE INDEX IF NOT EXISTS renders_client_idx ON renders(client_key, status);
CREATE TABLE IF NOT EXISTS beatmaps (
  checksum TEXT PRIMARY KEY,
  beatmap_id INTEGER NOT NULL,
  beatmapset_id INTEGER NOT NULL,
  map_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
`;

const ACTIVE_STATUSES = "'uploaded','resolving','downloading','queued','rendering','finalizing'";

export class RenderDatabase {
  readonly db: Database.Database;

  constructor(databasePath: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(databasePath, { readonly: true, fileMustExist: true });
      this.db.pragma('busy_timeout = 2000');
      return;
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.migrateSchema();
  }

  createRender(input: {
    id: string;
    replayPath: string;
    clientKey: string;
    encoder: string;
    options?: Readonly<RenderOptions>;
  }): void {
    const now = Date.now();
    const options = input.options ?? DEFAULT_RENDER_OPTIONS;
    const dimensions = RESOLUTION_DIMENSIONS[options.resolution];
    this.db.prepare(`INSERT INTO renders (
      id, created_at, updated_at, status, replay_path, client_key, width, height, fps, encoder, options_json
    ) VALUES (?, ?, ?, 'uploaded', ?, ?, ?, ?, 60, ?, ?)`)
      .run(input.id, now, now, input.replayPath, input.clientKey, dimensions.width, dimensions.height,
        input.encoder, JSON.stringify(options));
  }

  private migrateSchema(): void {
    const columns = this.db.pragma('table_info(renders)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'options_json')) {
      this.db.exec("ALTER TABLE renders ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  getRender(id: string): RenderRow | undefined {
    return this.db.prepare('SELECT * FROM renders WHERE id = ?').get(id) as RenderRow | undefined;
  }

  listQueued(): RenderRow[] {
    return this.db.prepare("SELECT * FROM renders WHERE status = 'queued' ORDER BY created_at ASC")
      .all() as RenderRow[];
  }

  nextQueued(): RenderRow | undefined {
    const oldest = this.db.prepare(`SELECT * FROM renders WHERE status IN (${ACTIVE_STATUSES})
      ORDER BY created_at ASC LIMIT 1`).get() as RenderRow | undefined;
    return oldest?.status === 'queued' ? oldest : undefined;
  }

  queuedCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM renders WHERE status = 'queued'").get() as { count: number };
    return row.count;
  }

  activeCountForClient(clientKey: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM renders
      WHERE client_key = ? AND status IN (${ACTIVE_STATUSES})`).get(clientKey) as { count: number };
    return row.count;
  }

  activeCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM renders
      WHERE status IN (${ACTIVE_STATUSES})`).get() as { count: number };
    return row.count;
  }

  updateReplay(id: string, replay: ReplayMetadata): void {
    this.db.prepare(`UPDATE renders SET
      updated_at = ?, player_name = ?, beatmap_checksum = ?, mods = ?, status = 'resolving'
      WHERE id = ?`).run(Date.now(), replay.playerName, replay.beatmapChecksum, replay.mods, id);
  }

  updateBeatmap(id: string, beatmapId: number, beatmapsetId: number): void {
    this.db.prepare(`UPDATE renders SET updated_at = ?, beatmap_id = ?, beatmapset_id = ? WHERE id = ?`)
      .run(Date.now(), beatmapId, beatmapsetId, id);
  }

  setStatus(id: string, status: JobStatus, progress?: number): void {
    const nextProgress = progress ?? this.getRender(id)?.progress ?? 0;
    this.db.prepare('UPDATE renders SET status = ?, progress = ?, updated_at = ? WHERE id = ?')
      .run(status, nextProgress, Date.now(), id);
  }

  setProgress(id: string, progress: number): void {
    this.db.prepare("UPDATE renders SET progress = ?, updated_at = ? WHERE id = ? AND status = 'rendering'")
      .run(progress, Date.now(), id);
  }

  markRendering(id: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`UPDATE renders SET status = 'rendering', progress = 0,
      started_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
      WHERE id = ? AND status = 'queued'`).run(now, now, id);
    return result.changes === 1;
  }

  markCompleted(id: string, videoPath: string, expiresAt: number): boolean {
    const now = Date.now();
    const result = this.db.prepare(`UPDATE renders SET status = 'completed', progress = 100, video_path = ?,
      completed_at = ?, expires_at = ?, updated_at = ? WHERE id = ? AND status = 'finalizing'`)
      .run(videoPath, now, expiresAt, now, id);
    return result.changes === 1;
  }

  markFailed(id: string, code: string, message: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE renders SET status = 'failed', error_code = ?, error_message = ?,
      completed_at = ?, updated_at = ?, expires_at = ? WHERE id = ?`)
      .run(code, message, now, now, now + limits.videoRetentionMs, id);
  }

  cancel(id: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE renders SET status = 'cancelled', completed_at = ?, updated_at = ?, expires_at = ?
      WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`).run(now, now, now + limits.videoRetentionMs, id);
  }

  queuePosition(id: string): number | null {
    const current = this.getRender(id);
    if (!current || current.status !== 'queued') return null;
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM renders
      WHERE status = 'queued' AND created_at < ?`).get(current.created_at) as { count: number };
    return row.count + 1;
  }

  recoverInterrupted(): RenderRow[] {
    const rows = this.db.prepare(`SELECT * FROM renders WHERE status IN
      ('uploaded','resolving','downloading','rendering','finalizing')`).all() as RenderRow[];
    this.db.prepare(`UPDATE renders SET status = 'resolving', progress = 0, started_at = NULL,
      updated_at = ? WHERE status IN ('uploaded','resolving','downloading','rendering','finalizing')`).run(Date.now());
    return rows;
  }

  findBeatmap(checksum: string): BeatmapRow | undefined {
    return this.db.prepare('SELECT * FROM beatmaps WHERE checksum = ?').get(checksum) as BeatmapRow | undefined;
  }

  findBeatmapset(beatmapsetId: number): BeatmapRow | undefined {
    return this.db.prepare('SELECT * FROM beatmaps WHERE beatmapset_id = ? ORDER BY last_used_at DESC LIMIT 1')
      .get(beatmapsetId) as BeatmapRow | undefined;
  }

  saveBeatmap(row: Omit<BeatmapRow, 'created_at' | 'last_used_at'>): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO beatmaps
      (checksum, beatmap_id, beatmapset_id, map_path, size_bytes, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checksum) DO UPDATE SET beatmap_id=excluded.beatmap_id,
      beatmapset_id=excluded.beatmapset_id, map_path=excluded.map_path,
      size_bytes=excluded.size_bytes, last_used_at=excluded.last_used_at`)
      .run(row.checksum, row.beatmap_id, row.beatmapset_id, row.map_path, row.size_bytes, now, now);
  }

  touchBeatmap(checksum: string): void {
    this.db.prepare('UPDATE beatmaps SET last_used_at = ? WHERE checksum = ?').run(Date.now(), checksum);
  }

  listBeatmapsLru(): BeatmapRow[] {
    return this.db.prepare('SELECT * FROM beatmaps ORDER BY last_used_at ASC').all() as BeatmapRow[];
  }

  deleteBeatmap(checksum: string): void {
    this.db.prepare('DELETE FROM beatmaps WHERE checksum = ?').run(checksum);
  }

  activeBeatmapsetIds(): Set<number> {
    const rows = this.db.prepare(`SELECT DISTINCT beatmapset_id FROM renders
      WHERE status IN (${ACTIVE_STATUSES}) AND beatmapset_id IS NOT NULL`).all() as Array<{ beatmapset_id: number }>;
    return new Set(rows.map((row) => row.beatmapset_id));
  }

  expiredRenders(now: number): RenderRow[] {
    return this.db.prepare(`SELECT * FROM renders WHERE expires_at IS NOT NULL AND expires_at < ?
      AND status IN ('completed','failed','cancelled')`).all(now) as RenderRow[];
  }

  recentRenders(limit: number): RenderRow[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    return this.db.prepare('SELECT * FROM renders ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as RenderRow[];
  }

  close(): void {
    this.db.close();
  }
}
