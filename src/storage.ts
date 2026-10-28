import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { StorageLowError } from './errors.js';
import type { RenderDatabase } from './database.js';
import type { Paths, RenderRow } from './types.js';

const STALE_TEMP_MS = 60 * 60 * 1000;

export class StorageManager {
  constructor(
    private readonly paths: Paths,
    private readonly database: RenderDatabase,
    private readonly softMinimum: number,
    private readonly hardMinimum: number,
  ) {}

  async freeBytes(): Promise<number> {
    const info = await statfs(this.paths.data);
    return info.bavail * info.bsize;
  }

  async guardNewRender(): Promise<void> {
    if (await this.freeBytes() >= this.softMinimum) return;
    await this.cleanupExpired();
    await this.cleanupTemp();
    await this.evictBeatmaps();
    if (await this.freeBytes() < this.hardMinimum) throw new StorageLowError();
  }

  async cleanupExpired(): Promise<void> {
    for (const render of this.database.expiredRenders(Date.now())) await removeRenderFiles(render, this.paths);
  }

  async cleanupTemp(): Promise<void> {
    const now = Date.now();
    for (const entry of await readdir(this.paths.temp, { withFileTypes: true })) {
      const target = path.join(this.paths.temp, entry.name);
      const details = await stat(target);
      if (now - details.mtimeMs > STALE_TEMP_MS) await rm(target, { recursive: true, force: true });
    }
  }

  async evictBeatmaps(): Promise<void> {
    const protectedSets = this.database.activeBeatmapsetIds();
    for (const beatmap of this.database.listBeatmapsLru()) {
      if (await this.freeBytes() >= this.softMinimum) return;
      if (protectedSets.has(beatmap.beatmapset_id)) continue;
      await rm(beatmap.map_path, { recursive: true, force: true });
      this.database.deleteBeatmap(beatmap.checksum);
    }
  }
}

export async function removeRenderFiles(render: RenderRow, paths: Pick<Paths, 'logs'>): Promise<void> {
  await Promise.all([
    rm(render.replay_path, { force: true }),
    render.video_path ? rm(render.video_path, { force: true }) : Promise.resolve(),
    rm(path.join(paths.logs, `${path.basename(render.id)}.log`), { force: true }),
  ]);
}
