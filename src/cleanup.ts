import type { RenderDatabase } from './database.js';
import { removeRenderFiles } from './storage.js';
import type { Paths } from './types.js';

export function startCleanupScheduler(database: RenderDatabase, paths: Paths, runExtra: () => Promise<void>): NodeJS.Timeout {
  const run = async (): Promise<void> => {
    for (const render of database.expiredRenders(Date.now())) {
      await removeRenderFiles(render, paths);
      database.markFilesDeleted(render.id);
    }
    await runExtra();
  };
  const timer = setInterval(() => { void run(); }, 30 * 60 * 1000);
  void run();
  return timer;
}
