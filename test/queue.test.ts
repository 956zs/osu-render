import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RenderDatabase } from '../src/database.js';
import { AppError } from '../src/errors.js';
import { RenderQueue } from '../src/queue.js';
import type { RenderFinishedEvent, RenderReporter, RenderRow, ReplayMetadata } from '../src/types.js';

const REPLAY: ReplayMetadata = {
  playMode: 0, osuVersion: 1, beatmapChecksum: 'checksum', playerName: 'player', replayChecksum: 'r', score: 1,
  maxCombo: 1, mods: '', timestamp: 0, compressedReplayBytes: 1,
};

type RenderBehavior = 'ok' | 'fail' | 'timeout' | 'cancel' | 'resolveFail' | 'crash' | 'resolveCrash' | 'internal';

type StatsObserver = (phase: 'during' | 'after', stats: ReturnType<RenderQueue['liveStats']>) => void;

async function runJob(
  behavior: RenderBehavior, reporter: RenderReporter | undefined, observe?: StatsObserver, inspect?: (row: RenderRow | undefined) => void,
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-queue-'));
  const database = new RenderDatabase(path.join(directory, 'test.db'));
  const id = `job-${behavior}`;
  let queue!: RenderQueue;
  try {
    const renderer = {
      render: async (_job: unknown, onProgress: (progress: number, detail: { speed: number | null; eta: string | null }) => void) => {
        onProgress(40, { speed: 1.5, eta: '0:41' });
        observe?.('during', queue.liveStats(id));
        if (behavior === 'fail') throw new AppError('RENDER_FAILED', 'danser failed', 500);
        if (behavior === 'timeout') throw new AppError('RENDER_TIMEOUT', 'too slow', 500);
        if (behavior === 'crash') throw new TypeError(`Cannot read properties of undefined (reading 'x') at ${path.join(directory, 'secret', 'file.ts')}`);
        if (behavior === 'internal') throw new AppError('INTERNAL_ERROR', 'Render job was not found.', 404);
        if (behavior === 'cancel') {
          await queue.cancel(id);
          throw new AppError('RENDER_FAILED', 'killed', 500);
        }
        return { path: path.join(directory, 'out.mp4'), speed: { avg: 1.5, last: 1.5, frames: 100 } };
      },
      cancel: async () => undefined,
    };
    const resolver = {
      resolve: async () => {
        if (behavior === 'resolveFail') throw new AppError('BEATMAP_NOT_FOUND', 'missing', 404);
        if (behavior === 'resolveCrash') throw new RangeError('x'.repeat(900));
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
    observe?.('after', queue.liveStats(id));
    inspect?.(database.getRender(id));
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

test('queue keeps render speed and ETA only while the render runs', async () => {
  for (const behavior of ['ok', 'fail', 'cancel'] as const) {
    const seen: Array<[string, unknown]> = [];
    await runJob(behavior, undefined, (phase, stats) => seen.push([phase, stats]));
    assert.deepEqual(seen, [['during', { speed: 1.5, eta: '0:41' }], ['after', undefined]], behavior);
  }
});

test('unexpected failures store a short redacted detail; expected ones do not', async () => {
  const rows = new Map<RenderBehavior, RenderRow | undefined>();
  for (const behavior of ['crash', 'resolveCrash', 'internal', 'fail', 'resolveFail', 'ok'] as const) {
    await runJob(behavior, undefined, undefined, (row) => rows.set(behavior, row));
  }
  const crash = rows.get('crash');
  assert.equal(crash?.status, 'failed');
  assert.equal(crash?.error_code, 'INTERNAL_ERROR');
  assert.equal(crash?.error_message, 'The render service encountered an internal error.');
  assert.equal(crash?.error_detail, "TypeError: Cannot read properties of undefined (reading 'x') at …/file.ts");
  const resolveCrash = rows.get('resolveCrash');
  assert.equal(resolveCrash?.error_code, 'INTERNAL_ERROR');
  assert.equal(resolveCrash?.error_detail?.length, 500);
  assert.match(resolveCrash?.error_detail ?? '', /^RangeError: x+…$/);
  assert.equal(rows.get('internal')?.error_detail, 'AppError: Render job was not found.');
  assert.equal(rows.get('fail')?.error_detail, null);
  assert.equal(rows.get('resolveFail')?.error_detail, null);
  assert.equal(rows.get('ok')?.error_detail, null);
});

test('completed renders store the average speed the renderer reported', async () => {
  let row: RenderRow | undefined;
  assert.equal(await runJob('ok', undefined, undefined, (value) => { row = value; }), 'completed');
  assert.equal(row?.avg_speed, 1.5);
  await runJob('fail', undefined, undefined, (value) => { row = value; });
  assert.equal(row?.avg_speed, null);
});
