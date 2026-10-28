import { rm } from 'node:fs/promises';
import type { RenderDatabase } from './database.js';
import type { Paths } from './types.js';

export function startCleanupScheduler(database: RenderDatabase, paths: Paths, runExtra: () => Promise<void>): NodeJS.Timeout {
  const run = async (): Promise<void> => {
    for (const render of database.expiredRenders(Date.now())) {
      await Promise.all([
        rm(render.replay_path, { force: true }),
        render.video_path ? rm(render.video_path, { force: true }) : Promise.resolve(),
      ]);
    }
    await runExtra();
  };
  const timer = setInterval(() => { void run(); }, 30 * 60 * 1000);
  void run();
  return timer;
}
