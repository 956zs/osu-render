import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DanserRenderer, OutputTail, SpeedTracker, buildDanserArguments, createProgressParser } from '../src/renderer.js';
import type { Paths, RenderRow } from '../src/types.js';
import { parseRenderOptions } from '../src/render-options.js';

test('danser checks its map database before rendering', () => {
  const job = {
    id: 'job-id',
    replay_path: '/srv/replays/job-id.osr',
    options_json: JSON.stringify(parseRenderOptions('{"backgroundDim":55,"showKeyOverlay":false}')),
  } as RenderRow;
  const argumentsList = buildDanserArguments(job);
  assert.deepEqual(argumentsList.slice(0, 5), [
    '-settings=service',
    '-replay=/srv/replays/job-id.osr',
    '-out=job-id',
    '-preciseprogress',
    '-noupdatecheck',
  ]);
  const patchArgument = argumentsList.find((argument) => argument.startsWith('-sPatch='));
  assert(patchArgument);
  const patch = JSON.parse(patchArgument.slice('-sPatch='.length));
  assert.deepEqual(patch.Recording, { FrameWidth: 1920, FrameHeight: 1080 });
  assert.equal(patch.Playfield.Background.Dim.Normal, 0.55);
  assert.equal(patch.Gameplay.KeyOverlay.Show, false);
  assert(argumentsList.includes('-quickstart'));
  assert(!argumentsList.includes('-nodbcheck'));
});

test('danser keeps the full intro when requested', () => {
  const job = {
    id: 'full-intro', replay_path: '/srv/replays/full-intro.osr',
    options_json: JSON.stringify(parseRenderOptions('{"skipIntro":false}')),
  } as RenderRow;
  assert(!buildDanserArguments(job).includes('-quickstart'));
});

test('danser uses the configured settings name', () => {
  const job = { id: 'named', replay_path: 'r.osr', options_json: JSON.stringify(parseRenderOptions(undefined)) } as RenderRow;
  assert.equal(buildDanserArguments(job, 'osu_render-2')[0], '-settings=osu_render-2');
});

test('progress parser only counts danser render progress lines', () => {
  const values: number[] = [];
  const parse = createProgressParser((value) => { values.push(value); });
  parse('Progress: 40%\n');
  parse('Progress: 41%, Speed: 1.20x, ETA: 1m');
  assert.deepEqual(values, []);
  parse('\rProgress: 42%,  Speed: 1.30x, ETA: 50s\r\nnoise Progress: 150%, Speed: 9x\n');
  parse('');
  assert.deepEqual(values, [41, 42, 100]);
});

test('progress parser captures render speed and ETA', () => {
  const seen: Array<[number, { speed: number | null; eta: string | null }]> = [];
  const parse = createProgressParser((value, detail) => { seen.push([value, detail]); });
  parse('Progress: 12%\nProgress: 13%, Speed: 1.23x, ETA: 0:41\n');
  parse('Progress: 14%, Speed: 0.98x\nProgress: 15%, Speed: 2x, ETA: 1m5s  \r');
  parse('Progress: 16%, Speed: x, ETA: \n');
  assert.deepEqual(seen, [
    [13, { speed: 1.23, eta: '0:41' }],
    [14, { speed: 0.98, eta: null }],
    [15, { speed: 2, eta: '1m5s' }],
    [16, { speed: null, eta: null }],
  ]);
});

test('output tail keeps the newest bytes and drops a cut first line', () => {
  const tail = new OutputTail(16);
  assert.equal(tail.text(), '');
  tail.push(Buffer.from('first line\n'));
  assert.equal(tail.text(), 'first line\n');
  tail.push(Buffer.from('second line\nthird\n'));
  assert.equal(tail.text(), 'third\n');
  const exact = new OutputTail(4);
  exact.push(Buffer.from('ab\ncd'));
  assert.equal(exact.text(), 'cd');
});

function job(id: string): RenderRow {
  return { id, replay_path: 'replay.osr', options_json: JSON.stringify(parseRenderOptions(undefined)) } as RenderRow;
}

async function withRenderer(
  script: string,
  options: { timeoutMs?: number; stallTimeoutMs?: number },
  run: (renderer: DanserRenderer, paths: Paths) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osu-render-renderer-'));
  const data = path.join(root, 'data');
  const paths: Paths = {
    root, data, db: path.join(data, 'render.db'), replays: path.join(data, 'replays'), temp: path.join(data, 'temp'),
    videos: path.join(data, 'videos'), songs: path.join(data, 'songs'), skins: path.join(data, 'skins'),
    danserOutput: path.join(data, 'temp', 'danser-output'), danserSettings: path.join(root, 'service.json'),
    logs: path.join(data, 'logs'), diagnostics: path.join(data, 'diagnostics'),
  };
  const renderer = new DanserRenderer({
    danserDir: root, paths, timeoutMs: options.timeoutMs ?? 30_000, stallTimeoutMs: options.stallTimeoutMs,
    terminateGraceMs: 200, logTailBytes: 4096,
    spawnProcess: (_command, _args, spawnOptions) => spawn(process.execPath, ['-e', script], spawnOptions),
  });
  try { await run(renderer, paths); } finally { await rm(root, { recursive: true, force: true }); }
}

test('failed renders keep a redacted log and only real progress', async () => {
  const script = `process.stdout.write('Progress: 40%\\nProgress: 55%, Speed: 2.00x, ETA: 1s\\n');`
    + `process.stderr.write(${JSON.stringify(`${os.homedir()}${path.sep}danser boom\n`)});process.exitCode = 3;`;
  await withRenderer(script, {}, async (renderer, paths) => {
    const progress: number[] = [];
    await assert.rejects(renderer.render(job('failed-job'), (value) => progress.push(value)), { code: 'RENDER_FAILED' });
    assert.deepEqual(progress, [55]);
    const log = await readFile(path.join(paths.logs, 'failed-job.log'), 'utf8');
    assert.match(log, /~[\\/]danser boom/);
    assert(!log.includes(os.homedir()));
    assert.match(log, /\[osu-render\] danser failed \(code 3\)/);
  });
});

test('timed out renders are killed and reported as RENDER_TIMEOUT', async () => {
  await withRenderer(`console.log('started'); setInterval(() => {}, 1000);`, { timeoutMs: 1500 }, async (renderer, paths) => {
    await assert.rejects(renderer.render(job('slow-job'), () => undefined), { code: 'RENDER_TIMEOUT' });
    const log = await readFile(path.join(paths.logs, 'slow-job.log'), 'utf8');
    assert.match(log, /started/);
    assert.match(log, /danser timeout/);
  });
});

test('a silent danser is killed by the watchdog and reported as RENDER_STALLED', async () => {
  const script = `console.log('Progress: 5%, Speed: 1.00x, ETA: 9s'); setInterval(() => {}, 1000);`;
  await withRenderer(script, { stallTimeoutMs: 600 }, async (renderer, paths) => {
    const started = Date.now();
    await assert.rejects(renderer.render(job('stalled-job'), () => undefined),
      (error: Error & { code?: string }) => error.code === 'RENDER_STALLED' && /no output for 1 s/.test(error.message));
    assert.ok(Date.now() - started < 10_000);
    const log = await readFile(path.join(paths.logs, 'stalled-job.log'), 'utf8');
    assert.match(log, /Progress: 5%/);
    assert.match(log, /\[osu-render\] danser stalled \(signal SIGKILL\)/);
  });
});

test('any output line keeps the watchdog from firing', async () => {
  // Loads silently for longer than the stall timeout in total, but prints a non-progress line in between.
  const script = `let n = 0; const timer = setInterval(() => { console.log('loading storyboard ' + n);`
    + ` if (++n === 6) { clearInterval(timer); process.exitCode = 3; } }, 200);`;
  await withRenderer(script, { stallTimeoutMs: 700 }, async (renderer, paths) => {
    await assert.rejects(renderer.render(job('busy-job'), () => undefined), { code: 'RENDER_FAILED' });
    assert.match(await readFile(path.join(paths.logs, 'busy-job.log'), 'utf8'), /danser failed \(code 3\)/);
  });
});

test('speed tracker reports the harmonic mean, the last speed and the ffmpeg frame total', () => {
  const tracker = new SpeedTracker();
  assert.deepEqual(tracker.summary(), { avg: null, last: null, frames: null });
  for (const speed of [2, null, 0, 4, 4]) tracker.record(speed);
  tracker.observe('frame=  120 fps=60\rframe=  240 fps=61\n');
  tracker.observe('frame=12041 fps=0.0 q=-1.0 Lsize=  444979KiB speed= 990x\nframe=5\n');
  // 3 equal-work samples at 2x, 4x, 4x: 3 / (1/2 + 1/4 + 1/4) = 3x.
  assert.deepEqual(tracker.summary(), { avg: 3, last: 4, frames: 12041 });
  const rounded = new SpeedTracker();
  rounded.record(1.234);
  rounded.record(2.5);
  assert.deepEqual(rounded.summary(), { avg: 1.65, last: 2.5, frames: null });
});

test('cancelled renders stop the process tree and log the cancellation', async () => {
  const script = `console.log('Progress: 1%, Speed: 1.00x, ETA: 9s'); setInterval(() => {}, 1000);`;
  await withRenderer(script, {}, async (renderer, paths) => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const outcome = assert.rejects(renderer.render(job('cancel-job'), () => started()), { code: 'RENDER_FAILED' });
    await running;
    await renderer.cancel('cancel-job');
    await outcome;
    assert.match(await readFile(path.join(paths.logs, 'cancel-job.log'), 'utf8'), /danser cancelled/);
  });
});
