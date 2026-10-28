import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RenderDatabase } from '../src/database.js';
import { AppError } from '../src/errors.js';
import { RenderQueue } from '../src/queue.js';
import type { RenderFinishedEvent, RenderReporter, ReplayMetadata } from '../src/types.js';

const REPLAY: ReplayMetadata = {
  playMode: 0, osuVersion: 1, beatmapChecksum: 'checksum', playerName: 'player', replayChecksum: 'r', score: 1,
  maxCombo: 1, mods: '', timestamp: 0, compressedReplayBytes: 1,
};

type RenderBehavior = 'ok' | 'fail' | 'timeout' | 'cancel' | 'resolveFail';

async function runJob(behavior: RenderBehavior, reporter: RenderReporter | undefined): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-queue-'));
  const database = new RenderDatabase(path.join(directory, 'test.db'));
  const id = `job-${behavior}`;
  let queue!: RenderQueue;
  try {
    const renderer = {
      render: async () => {
        if (behavior === 'fail') throw new AppError('RENDER_FAILED', 'danser failed', 500);
        if (behavior === 'timeout') throw new AppError('RENDER_TIMEOUT', 'too slow', 500);
        if (behavior === 'cancel') {
          await queue.cancel(id);
          throw new AppError('RENDER_FAILED', 'killed', 500);
        }
        return path.join(directory, 'out.mp4');
      },
      cancel: async () => undefined,
    };
    const resolver = {
      resolve: async () => {
        if (behavior === 'resolveFail') throw new AppError('BEATMAP_NOT_FOUND', 'missing', 404);
        return { metadata: { id: 1, beatmapsetId: 2 } };
      },
    };
    queue = new RenderQueue({
      database, renderer, resolver, reporter,
      storage: { guardNewRender: async () => undefined },
    } as unknown as ConstructorParameters<typeof RenderQueue>[0]);
    database.createRender({ id, replayPath: path.join(directory, 'missing.osr'), clientKey: 'c', encoder: 'libx264' });
    await queue.enqueue(id, REPLAY);
    for (let i = 0; i < 200; i += 1) {
      const status = database.getRender(id)?.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return database.getRender(id)?.status ?? 'missing';
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('queue notifies the reporter when a render ends, except when cancelled', async () => {
  const events: RenderFinishedEvent[] = [];
  const reporter: RenderReporter = { renderFinished: (event) => { events.push(event); } };
  assert.equal(await runJob('ok', reporter), 'completed');
  assert.equal(await runJob('fail', reporter), 'failed');
  assert.equal(await runJob('timeout', reporter), 'failed');
  assert.equal(await runJob('resolveFail', reporter), 'failed');
  assert.equal(await runJob('cancel', reporter), 'cancelled');
  assert.deepEqual(events, [
    { id: 'job-ok', outcome: 'completed' },
    { id: 'job-fail', outcome: 'failed' },
    { id: 'job-timeout', outcome: 'timeout' },
    { id: 'job-resolveFail', outcome: 'failed' },
  ]);
});

test('a throwing reporter never changes the job result', async () => {
  const throwing: RenderReporter = { renderFinished: () => { throw new Error('reporter exploded'); } };
  assert.equal(await runJob('ok', throwing), 'completed');
  assert.equal(await runJob('fail', throwing), 'failed');
  assert.equal(await runJob('ok', undefined), 'completed');
});
