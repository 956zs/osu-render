import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PreflightService, PreflightState, type CommandOptions, type CommandRunner, type PreflightResult,
} from '../src/preflight.js';

interface Call { file: string; args: string[]; options: CommandOptions }

function fakeRunner(calls: Call[], passing: string[], glxinfo: string | Error = 'OpenGL renderer\nAccelerated: yes\n'): CommandRunner {
  return async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'glxinfo') {
      if (glxinfo instanceof Error) throw glxinfo;
      return { stdout: glxinfo, stderr: '' };
    }
    const encoder = args[args.indexOf('-c:v') + 1];
    if (passing.includes(encoder)) return { stdout: '', stderr: '' };
    throw Object.assign(new Error('Command failed'), { stderr: `${os.homedir()}/x: ${encoder} init failed\n` });
  };
}

async function withDanser(files: string[], run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-preflight-'));
  try {
    for (const file of files) {
      const target = path.join(directory, ...file.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '');
      await chmod(target, 0o755);
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const LINUX_011 = ['danser-cli', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe'];
const DISPLAY_ENV = { DISPLAY: ':0', PATH: process.env.PATH };

test('preflight state refreshes a failed startup check when the session becomes ready', async () => {
  const initial: PreflightResult = {
    renderer: true, display: false, encoder: 'libx264', reason: 'display_unavailable', probes: [],
  };
  const ready: PreflightResult = { renderer: true, display: true, encoder: 'h264_qsv', probes: [] };
  let calls = 0;
  let changedTo: PreflightResult | undefined;
  const state = new PreflightState({
    run: async () => { calls += 1; return ready; },
  }, initial, { onChange: async (result) => { changedTo = result; } });

  assert.deepEqual(await state.refreshIfNeeded(), ready);
  assert.equal(calls, 1);
  assert.equal(changedTo, ready);
  assert.deepEqual(await state.refreshIfNeeded(), ready);
  assert.equal(calls, 1);
});

test('software fallback re-probes on the slow interval, other reasons on the fast one', async () => {
  const fallback: PreflightResult = {
    renderer: true, display: true, encoder: 'libx264', reason: 'hardware_encoder_unavailable', probes: [],
  };
  const noDisplay: PreflightResult = { ...fallback, display: false, reason: 'display_unavailable' };
  const broken: PreflightResult = { ...fallback, encoder: 'unknown', reason: 'encoder_unavailable' };
  for (const [result, expectedCalls] of [[fallback, 1], [broken, 1], [noDisplay, 3]] as const) {
    let calls = 0;
    const state = new PreflightState({ run: async () => { calls += 1; return result; } }, result, {
      retryIntervalMs: 0, softwareFallbackRetryMs: 60_000,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) await state.refreshIfNeeded();
    assert.equal(calls, expectedCalls, result.reason);
  }
});

test('auto mode on linux stops at the first passing encoder', async () => {
  await withDanser(LINUX_011, async (directory) => {
    const calls: Call[] = [];
    const service = new PreflightService({
      danserDir: directory, platform: 'linux', env: DISPLAY_ENV, runCommand: fakeRunner(calls, ['h264_qsv', 'libx264']),
    });
    const result = await service.run();
    assert.equal(result.encoder, 'h264_qsv');
    assert.equal(result.reason, undefined);
    assert.equal(result.renderer, true);
    assert.equal(result.display, true);
    assert.deepEqual(result.probes.map((probe) => [probe.encoder, probe.ok]), [['h264_nvenc', false], ['h264_qsv', true]]);
    assert.match(result.probes[0].error ?? '', /^~\/x: h264_nvenc init failed/);
    const probe = calls.find((call) => call.file !== 'glxinfo');
    assert(probe);
    assert.equal(probe.file, path.join(directory, 'ffmpeg', 'ffmpeg'));
    assert.deepEqual(probe.args, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=240x144:r=1',
      '-frames:v', '1', '-an', '-vf', 'format=nv12', '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ]);
    assert.equal(probe.options.env.LD_LIBRARY_PATH?.split(':')[0], path.join(directory, 'ffmpeg'));
    assert.equal(probe.options.timeoutMs, 20000);
  });
});

test('cpu-only machines degrade to libx264 with a capped error tail', async () => {
  await withDanser(LINUX_011, async (directory) => {
    const runner: CommandRunner = async (file, args) => {
      if (file === 'glxinfo') return { stdout: 'OpenGL\nAccelerated: yes', stderr: '' };
      if (args.includes('libx264')) return { stdout: '', stderr: '' };
      throw Object.assign(new Error('failed'), { stderr: `${'x'.repeat(3000)}END` });
    };
    const service = new PreflightService({ danserDir: directory, platform: 'linux', env: DISPLAY_ENV, runCommand: runner });
    const result = await service.run();
    assert.equal(result.encoder, 'libx264');
    assert.equal(result.reason, 'hardware_encoder_unavailable');
    assert.equal(result.probes.length, 4);
    assert.equal(result.probes[0].error?.length, 1500);
    assert.match(result.probes[0].error ?? '', /END$/);
  });
});

test('forced encoders report encoder_unavailable only when they fail', async () => {
  await withDanser(LINUX_011, async (directory) => {
    const forced = (passing: string[]) => new PreflightService({
      danserDir: directory, platform: 'linux', env: DISPLAY_ENV, renderEncoder: 'h264_nvenc',
      runCommand: fakeRunner([], passing),
    }).run();
    const failed = await forced(['libx264']);
    assert.equal(failed.encoder, 'libx264');
    assert.equal(failed.reason, 'encoder_unavailable');
    const passed = await forced(['h264_nvenc']);
    assert.equal(passed.encoder, 'h264_nvenc');
    assert.equal(passed.reason, undefined);
    const forcedSoftware = await new PreflightService({
      danserDir: directory, platform: 'linux', env: DISPLAY_ENV, renderEncoder: 'libx264', runCommand: fakeRunner([], ['libx264']),
    }).run();
    assert.equal(forcedSoftware.reason, undefined);
  });
});

test('nothing working yields unknown, and renderer problems take precedence', async () => {
  await withDanser(['ffmpeg/ffmpeg'], async (directory) => {
    const service = new PreflightService({ danserDir: directory, platform: 'linux', env: DISPLAY_ENV, runCommand: fakeRunner([], []) });
    const result = await service.run();
    assert.equal(result.encoder, 'unknown');
    assert.equal(result.renderer, false);
    assert.equal(result.reason, 'renderer_unavailable');
  });
  await withDanser(LINUX_011, async (directory) => {
    const service = new PreflightService({ danserDir: directory, platform: 'linux', env: DISPLAY_ENV, runCommand: fakeRunner([], []) });
    assert.equal((await service.run()).reason, 'encoder_unavailable');
  });
});

test('display detection is platform aware', async () => {
  await withDanser(LINUX_011, async (directory) => {
    const display = async (options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; glxinfo?: string | Error }) => {
      const calls: Call[] = [];
      const result = await new PreflightService({
        danserDir: directory, platform: options.platform, env: options.env,
        runCommand: fakeRunner(calls, ['libx264'], options.glxinfo),
      }).run();
      return { ...result, glxinfoCalls: calls.filter((call) => call.file === 'glxinfo').length };
    };
    const windows = await display({ platform: 'win32', env: {} });
    assert.equal(windows.display, true);
    assert.equal(windows.displayDetail, 'win32 interactive session required');
    assert.equal(windows.glxinfoCalls, 0);
    const headless = await display({ platform: 'linux', env: {} });
    assert.equal(headless.display, false);
    assert.equal(headless.reason, 'display_unavailable');
    const noGlxinfo = await display({ platform: 'linux', env: DISPLAY_ENV, glxinfo: Object.assign(new Error('spawn glxinfo ENOENT'), { code: 'ENOENT' }) });
    assert.equal(noGlxinfo.display, true);
    assert.equal(noGlxinfo.displayDetail, 'glxinfo not installed');
    const software = await display({ platform: 'linux', env: DISPLAY_ENV, glxinfo: 'OpenGL\nAccelerated: no\n' });
    assert.equal(software.display, false);
  });
  await withDanser([...LINUX_011, 'libSDL3.so'], async (directory) => {
    const calls: Call[] = [];
    const result = await new PreflightService({
      danserDir: directory, platform: 'linux', env: {}, runCommand: fakeRunner(calls, ['h264_qsv']),
    }).run();
    assert.equal(result.display, true);
    assert.equal(result.displayDetail, 'offscreen (danser ≥0.12)');
    assert.equal(calls.some((call) => call.file === 'glxinfo'), false);
  });
});

test('probeAll covers every supported encoder and health reports the encoder kind', async () => {
  await withDanser(LINUX_011, async (directory) => {
    const service = new PreflightService({ danserDir: directory, platform: 'linux', env: DISPLAY_ENV, runCommand: fakeRunner([], ['h264_qsv']) });
    const probes = await service.probeAll();
    assert.deepEqual(probes.map((probe) => probe.encoder),
      ['h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv', 'hevc_qsv', 'libx264']);
    assert.deepEqual(probes.filter((probe) => probe.ok).map((probe) => probe.encoder), ['h264_qsv']);
    const ready: PreflightResult = { renderer: true, display: true, encoder: 'h264_qsv', probes: [] };
    assert.deepEqual(await service.health(ready, 2, 100, 10), {
      status: 'ok', renderer: true, display: true, encoder: 'h264_qsv', encoderKind: 'hardware', platform: 'linux',
      queue: 2, freeDiskBytes: 100, reason: undefined,
    });
    const low = await service.health(ready, 0, 5, 10);
    assert.equal(low.status, 'degraded');
    assert.equal(low.reason, 'storage_low');
    const none = await service.health({ ...ready, encoder: 'unknown', reason: 'encoder_unavailable' }, 0, 100, 10);
    assert.equal(none.encoderKind, 'none');
    assert.equal(none.status, 'degraded');
  });
});

test('windows tools resolve to .exe files without library paths', async () => {
  await withDanser(['danser-cli.exe', 'ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe'], async (directory) => {
    const calls: Call[] = [];
    const service = new PreflightService({ danserDir: directory, platform: 'win32', env: {}, runCommand: fakeRunner(calls, ['h264_amf', 'libx264']) });
    const result = await service.run();
    assert.equal(result.encoder, 'h264_amf');
    assert.deepEqual(result.probes.map((probe) => probe.encoder), ['h264_nvenc', 'h264_amf']);
    assert.equal(calls[0].file, path.join(directory, 'ffmpeg', 'ffmpeg.exe'));
    assert.equal(calls[0].options.env.LD_LIBRARY_PATH, undefined);
    assert.equal((await service.tools()).danserCli, path.join(directory, 'danser-cli.exe'));
  });
});

test('a failing settings rewrite keeps the old result without throwing', async () => {
  const initial: PreflightResult = { renderer: true, display: false, encoder: 'libx264', reason: 'display_unavailable', probes: [] };
  const ready: PreflightResult = { renderer: true, display: true, encoder: 'h264_qsv', probes: [] };
  let calls = 0;
  let attempts = 0;
  const state = new PreflightState({ run: async () => { calls += 1; return ready; } }, initial, {
    retryIntervalMs: 60_000,
    onChange: async () => { attempts += 1; if (attempts === 1) throw new Error('EBUSY'); },
  });
  assert.deepEqual(await state.refreshIfNeeded(), initial);
  assert.equal(state.current(), initial);
  assert.deepEqual(await state.refreshIfNeeded(), initial);
  assert.equal(calls, 1);
  assert.deepEqual(await state.refreshIfNeeded(true), ready);
  assert.equal(state.current(), ready);
  assert.equal(attempts, 2);
});
