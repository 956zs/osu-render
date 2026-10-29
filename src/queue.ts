import { rm } from 'node:fs/promises';
import { AppError, internalErrorDetail, publicError } from './errors.js';
import type { RenderDatabase } from './database.js';
import type { BeatmapResolver } from './beatmap-resolver.js';
import type { DanserRenderer, ProgressDetail } from './renderer.js';
import type { StorageManager } from './storage.js';
import type { RenderFinishedEvent, RenderReporter, ReplayMetadata, RenderRow } from './types.js';
import { log } from './logger.js';
import { limits } from './config.js';

export class RenderQueue {
  private running = false;
  private currentJobId: string | null = null;
  /** Speed and ETA of rendering jobs; memory only, dropped when the render ends. */
  private readonly stats = new Map<string, ProgressDetail>();

  constructor(private readonly dependencies: {
    database: RenderDatabase;
    resolver: BeatmapResolver;
    renderer: DanserRenderer;
    storage: StorageManager;
    reporter?: RenderReporter;
  }) {}

  private get database(): RenderDatabase { return this.dependencies.database; }
  private get resolver(): BeatmapResolver { return this.dependencies.resolver; }
  private get renderer(): DanserRenderer { return this.dependencies.renderer; }
  private get storage(): StorageManager { return this.dependencies.storage; }

  start(): void {
    void this.pump();
  }

  async enqueue(id: string, replay: ReplayMetadata): Promise<void> {
    this.database.updateReplay(id, replay);
    void this.prepare(id, replay);
  }

  async recover(row: RenderRow): Promise<void> {
    const replay = await import('./replay.js').then((module) => module.parseReplayFile(row.replay_path));
    this.database.updateReplay(row.id, replay);
    void this.prepare(row.id, replay);
  }

  liveStats(id: string): ProgressDetail | undefined {
    return this.stats.get(id);
  }

  async cancel(id: string): Promise<void> {
    const row = this.database.getRender(id);
    if (!row) throw new AppError('INTERNAL_ERROR', 'Render job was not found.', 404);
    if (['completed', 'failed', 'cancelled'].includes(row.status)) {
      throw new AppError('RENDER_FAILED', 'Render job has already finished.', 409);
    }
    this.database.cancel(id);
    this.stats.delete(id);
    if (row.status === 'rendering') await this.renderer.cancel(id);
    await removeReplay(row);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const next = this.database.nextQueued();
        if (!next) return;
        await this.process(next);
      }
    } finally {
      this.running = false;
      this.currentJobId = null;
    }
  }

  private async process(job: RenderRow): Promise<void> {
    this.currentJobId = job.id;
    try {
      await this.storage.guardNewRender();
      if (!this.database.markRendering(job.id)) return;
      const { path: output, speed } = await this.renderer.render(this.database.getRender(job.id) as RenderRow,
        (progress, detail) => {
          this.database.setProgress(job.id, progress);
          this.stats.set(job.id, detail);
        });
      this.stats.delete(job.id);
      if (this.database.getRender(job.id)?.status === 'cancelled') {
        await rm(output, { force: true });
        return;
      }
      this.database.setStatus(job.id, 'finalizing', 100);
      if (!this.database.markCompleted(job.id, output, Date.now() + limits.videoRetentionMs, speed.avg)) {
        await rm(output, { force: true });
        return;
      }
      log('info', 'render_completed', {
        component: 'worker', jobId: job.id, ...renderStats(this.database.getRender(job.id)),
        avgSpeed: speed.avg, lastSpeed: speed.last, frames: speed.frames,
      });
      this.report(job.id, 'completed');
    } catch (error) {
      this.stats.delete(job.id);
      if (this.database.getRender(job.id)?.status === 'cancelled') return;
      const safe = publicError(error);
      this.database.markFailed(job.id, safe.code, safe.publicMessage, internalErrorDetail(error));
      await removeReplay(this.database.getRender(job.id));
      log('error', 'render_failed', {
        component: 'worker', jobId: job.id, code: safe.code, message: safe.message,
        ...renderStats(this.database.getRender(job.id)), ...debugError(error),
      });
      this.report(job.id, safe.code === 'RENDER_TIMEOUT' ? 'timeout' : 'failed');
    }
  }

  private async prepare(id: string, replay: ReplayMetadata): Promise<void> {
    try {
      const resolved = await this.resolver.resolve(replay.beatmapChecksum,
        () => this.database.setStatus(id, 'downloading'));
      if (this.database.getRender(id)?.status === 'cancelled') return;
      this.database.updateBeatmap(id, resolved.metadata);
      this.database.setStatus(id, 'queued');
      await this.pump();
    } catch (error) {
      if (this.database.getRender(id)?.status === 'cancelled') return;
      const safe = publicError(error);
      this.database.markFailed(id, safe.code, safe.publicMessage, internalErrorDetail(error));
      await removeReplay(this.database.getRender(id));
      log('error', 'beatmap_resolution_failed', {
        component: 'resolver', jobId: id, code: safe.code, ...debugError(error),
      });
      this.report(id, 'failed');
    }
  }

  private report(id: string, outcome: RenderFinishedEvent['outcome']): void {
    try {
      this.dependencies.reporter?.renderFinished({ id, outcome });
    } catch (error) {
      log('warn', 'report_hook_failed', { component: 'worker', jobId: id, ...debugError(error) });
    }
  }
}

function renderStats(row: RenderRow | undefined): { encoder?: string; renderMs?: number } {
  if (!row) return {};
  const renderMs = row.started_at !== null && row.completed_at !== null ? row.completed_at - row.started_at : undefined;
  return { encoder: row.encoder, ...(renderMs !== undefined ? { renderMs } : {}) };
}

function debugError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack ?? '',
    };
  }
  return { errorName: typeof error, errorMessage: String(error) };
}

async function removeReplay(row: RenderRow | undefined): Promise<void> {
  if (row?.replay_path) await rm(row.replay_path, { force: true });
}
