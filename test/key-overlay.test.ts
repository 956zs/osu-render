import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KeyOverlay, NO_SESSION_EXIT, compositeArguments, compositeEncoderArgs, danserLeadIn, danserTimeline, modsRate,
  overlayPosition, overlaySize, parseOsuTiming, preemptMs, resolveAulactl, runProcess, type ToolOptions, type ToolRunner,
} from '../src/key-overlay.js';
import type { DanserTools } from '../src/platform.js';
import { parseRenderOptions } from '../src/render-options.js';
import type { RenderRow } from '../src/types.js';

const OSU = `osu file format v14

[Difficulty]
HPDrainRate:5
OverallDifficulty:8
ApproachRate:9

[HitObjects]
256,192,1500,1,0,0:0:0:0:
300,100,2000,1,0,0:0:0:0:
`;

const NO_HOLD = { leadInHoldS: 2, seizureWarning: { enabled: false, durationS: 5 } };

test('osu timing: format version, approach rate and the first object', () => {
  assert.deepEqual(parseOsuTiming(OSU), { formatVersion: 14, approachRate: 9, firstObjectMs: 1500 });
  // no ApproachRate: OD, like danser; objects out of order; CRLF
  const old = 'osu file format v4\r\n[Difficulty]\r\nOverallDifficulty:7\r\n[HitObjects]\r\n1,1,900,1,0\r\n1,1,800,1,0\r\n';
  assert.deepEqual(parseOsuTiming(old), { formatVersion: 4, approachRate: 7, firstObjectMs: 800 });
  // out of range values are clamped
  assert.equal(parseOsuTiming('[Difficulty]\nApproachRate:11\n[HitObjects]\n1,1,5,1\n').approachRate, 10);
  assert.throws(() => parseOsuTiming('osu file format v14\n[HitObjects]\n'), /no hit objects/);
  assert.throws(() => parseOsuTiming(''), /no hit objects/);
});

test('mod rate and preempt follow danser', () => {
  assert.equal(modsRate(''), 1);
  assert.equal(modsRate('HDDT'), 1.5);
  assert.equal(modsRate('NC'), 1.5);
  assert.equal(modsRate('HT'), 0.75);
  assert.equal(preemptMs(9, ''), 600);
  assert.equal(preemptMs(5, ''), 1200);
  assert.equal(preemptMs(0, ''), 1800);
  assert.equal(preemptMs(10, ''), 450);
  // float32 like danser: AR 9.3 is 554, not 555
  assert.equal(preemptMs(9.3, ''), 554);
  assert.equal(preemptMs(9, 'HR'), 450, 'HR caps AR at 10');
  assert.equal(preemptMs(8, 'EZ'), preemptMs(4, ''));
});

test('danser timeline with quickstart (osu-render skipIntro)', () => {
  const timing = parseOsuTiming(OSU);
  // first object 1500 - preempt 600 = 900; 1 s lead-in; frame 0 after the first 1 ms step
  assert.deepEqual(danserTimeline({ timing, mods: '', quickstart: true, ...NO_HOLD }), { startMs: -99, prerollMs: 999, rate: 1 });
  assert.deepEqual(danserTimeline({ timing, mods: 'DT', quickstart: true, ...NO_HOLD }), { startMs: -99, prerollMs: 999, rate: 1.5 });
});

test('danser timeline without skipping, with lead-in hold and seizure warning', () => {
  const timing = parseOsuTiming(OSU);
  // -preempt (-600) - hold 2 s - 1 s
  assert.deepEqual(danserTimeline({ timing, mods: '', quickstart: false, ...NO_HOLD }), { startMs: -3599, prerollMs: 2999, rate: 1 });
  const seizure = { leadInHoldS: 0, seizureWarning: { enabled: true, durationS: 0.5 } };
  // the warning lasts at least 1 s
  assert.deepEqual(danserTimeline({ timing, mods: '', quickstart: false, ...seizure }), { startMs: -2599, prerollMs: 1999, rate: 1 });
});

test('danser timeline: an early first object is not skipped; old maps are 24 ms late', () => {
  const early = { formatVersion: 14, approachRate: 9, firstObjectMs: 400 };
  assert.deepEqual(danserTimeline({ timing: early, mods: '', quickstart: true, ...NO_HOLD }), { startMs: -1599, prerollMs: 999, rate: 1 });
  const old = { formatVersion: 4, approachRate: 9, firstObjectMs: 1500 };
  assert.deepEqual(danserTimeline({ timing: old, mods: '', quickstart: true, ...NO_HOLD }), { startMs: -123, prerollMs: 1023, rate: 1 });
});

test('lead-in settings from the danser settings file', () => {
  assert.deepEqual(danserLeadIn({ Playfield: { LeadInHold: 0.5, SeizureWarning: { Enabled: true, Duration: 3 } } }),
    { leadInHoldS: 0.5, seizureWarning: { enabled: true, durationS: 3 } });
  assert.deepEqual(danserLeadIn({}), { leadInHoldS: 2, seizureWarning: { enabled: false, durationS: 5 } });
  assert.deepEqual(danserLeadIn(null), danserLeadIn({}));
  assert.deepEqual(danserLeadIn({ Playfield: { LeadInHold: 'x', SeizureWarning: [] } }), danserLeadIn({}));
});

test('overlay size and corner position', () => {
  assert.deepEqual(overlaySize(1080, 40), { width: 244, height: 432 });
  assert.deepEqual(overlaySize(720, 20), { width: 82, height: 144 });
  assert.deepEqual(overlaySize(1, 1), { width: 2, height: 2 });
  assert.deepEqual(overlayPosition('top-left', 1000), { x: '20', y: '20' });
  assert.deepEqual(overlayPosition('bottom-right', 1000), { x: 'main_w-overlay_w-20', y: 'main_h-overlay_h-20' });
  assert.deepEqual(overlayPosition('top-right', 720).y, '14');
});

test('composite encoder options mirror danser per encoder family', () => {
  const balanced = { speedProfile: 'balanced' } as const;
  assert.deepEqual(compositeEncoderArgs('libx264', balanced),
    ['-c:v', 'libx264', '-crf', '18', '-profile:v', 'high', '-preset', 'faster', '-pix_fmt', 'yuv420p']);
  assert.deepEqual(compositeEncoderArgs('h264_qsv', balanced),
    ['-c:v', 'h264_qsv', '-global_quality', '20', '-profile:v', 'high', '-preset', 'faster', '-pix_fmt', 'nv12']);
  assert.deepEqual(compositeEncoderArgs('hevc_nvenc', { speedProfile: 'fast' }),
    ['-c:v', 'hevc_nvenc', '-rc', 'vbr', '-b:v', '400M', '-cq', '26', '-preset', 'p1', '-pix_fmt', 'yuv420p']);
  assert.deepEqual(compositeEncoderArgs('h264_amf', { speedProfile: 'quality' }), ['-c:v', 'h264_amf', '-usage', 'transcoding',
    '-rc', 'cqp', '-qp_i', '18', '-qp_p', '18', '-qp_b', '18', '-profile:v', 'high', '-preset:v', 'quality', '-pix_fmt', 'yuv420p']);
});

test('composite arguments keep the audio and place the overlay', () => {
  const args = compositeArguments({
    video: 'in.mp4', overlay: { width: 244, height: 432, fps: 60 }, output: 'out.mp4', corner: 'bottom-left', opacity: 90,
    videoHeight: 1080,
    encoderArgs: ['-c:v', 'libx264'],
  });
  assert.deepEqual(args.slice(-5), ['-c:v', 'libx264', '-movflags', '+faststart', 'out.mp4']);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /colorchannelmixer=aa=0\.90/);
  assert.match(filter, /overlay=x=22:y=main_h-overlay_h-22:eof_action=pass/);
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 6), ['-map', '[v]', '-map', '0:a?', '-c:a', 'copy']);
  assert.equal(args.at(-1), 'out.mp4');
  // the overlay comes in as raw RGBA frames on stdin
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 12),
    ['-i', 'in.mp4', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '244x432', '-r', '60', '-i', 'pipe:0']);
  assert(!args.includes('-nostdin'));
  const clamped = compositeArguments({ video: 'a', overlay: { width: 2, height: 2, fps: 1 }, output: 'c', corner: 'top-left', opacity: 500, videoHeight: 720, encoderArgs: [] });
  assert.match(clamped[clamped.indexOf('-filter_complex') + 1], /aa=1\.00/);
});

test('aulactl lookup: off on Windows or when disabled, explicit path, PATH and ~/.local/bin', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'osu-render-aulactl-'));
  try {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    const exe = path.join(bin, 'aulactl');
    await writeFile(exe, '#!/bin/sh\n');
    await chmod(exe, 0o755);
    assert.equal(resolveAulactl({ PATH: bin }, 'win32'), null);
    assert.equal(resolveAulactl({ PATH: bin, KEY_OVERLAY_AULACTL: 'off' }, 'linux'), null);
    assert.equal(resolveAulactl({ PATH: bin }, 'linux'), exe);
    assert.equal(resolveAulactl({ KEY_OVERLAY_AULACTL: exe, PATH: '' }, 'linux'), exe);
    assert.equal(resolveAulactl({ KEY_OVERLAY_AULACTL: path.join(dir, 'missing'), PATH: bin }, 'linux'), null);
    assert.equal(resolveAulactl({ KEY_OVERLAY_AULACTL: 'aulactl', PATH: bin }, 'linux'), null, 'relative paths are refused');
    const home = path.join(dir, 'home');
    await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    assert.equal(resolveAulactl({ PATH: '', HOME: home }, 'linux'), null);
    await writeFile(path.join(home, '.local', 'bin', 'aulactl'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(resolveAulactl({ PATH: '', HOME: home }, 'linux'), path.join(home, '.local', 'bin', 'aulactl'));
    // not executable
    await chmod(exe, 0o644);
    assert.equal(resolveAulactl({ PATH: bin, HOME: dir }, 'linux'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Call { command: string; args: string[]; options: ToolOptions }
type Result = Awaited<ReturnType<ToolRunner>>;

async function overlayFixture(results: Result[], beatmap: string | null = 'map.osu') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'osu-render-keys-'));
  for (const sub of ['temp', 'logs']) await mkdir(path.join(dir, sub));
  await writeFile(path.join(dir, 'map.osu'), OSU);
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ Playfield: { LeadInHold: 2 } }));
  await writeFile(path.join(dir, 'video.mp4'), 'danser');
  const calls: Call[] = [];
  const queue: Result[] = [{ code: 0, output: '12.5\n' }, ...results];
  const overlay = new KeyOverlay({
    aulactl: '/opt/aulactl',
    findBeatmapFile: async () => (beatmap ? path.join(dir, beatmap) : null),
    danserSettingsPath: path.join(dir, 'settings.json'),
    tempDir: path.join(dir, 'temp'),
    logsDir: path.join(dir, 'logs'),
    platform: 'linux',
    runTool: async (command: string, args: string[], options: ToolOptions) => {
      calls.push({ command, args, options });
      const next = queue.shift() ?? { code: 1, output: 'unexpected' };
      // a successful composite writes its output file
      if (next.code === 0 && command.endsWith('ffmpeg')) await writeFile(args.at(-1) as string, 'composited');
      return next;
    },
  });
  const job = {
    id: 'job1', replay_path: '/r/job1.osr', beatmap_checksum: 'a'.repeat(32), mods: 'HD', encoder: 'h264_qsv',
  } as RenderRow;
  const tools = { ffmpeg: '/d/ffmpeg', ffprobe: '/d/ffprobe', libraryDirs: [] } as unknown as DanserTools;
  return { dir, calls, overlay, job, tools, video: path.join(dir, 'video.mp4') };
}

const ENABLED = parseRenderOptions(JSON.stringify({ keyOverlay: true, resolution: '720p', keyOverlayScale: 50 }));

test('overlay step: aulactl draws the overlay on danser\'s clock and ffmpeg composites it', async () => {
  const f = await overlayFixture([{ code: 0, output: '' }, { code: 0, output: '', producer: { code: 0, output: '' } }]);
  try {
    const result = await f.overlay.apply(f.job, f.video, ENABLED, f.tools);
    assert.equal(result.status, 'applied', result.note);
    assert.equal(await readFile(f.video, 'utf8'), 'composited');
    const [probe, check, ffmpeg] = f.calls;
    assert.equal(probe.command, '/d/ffprobe');
    // the session check, then aulactl's raw frames piped into ffmpeg
    assert.equal(check.command, '/opt/aulactl');
    assert.deepEqual(check.args.slice(0, 6), ['replay', 'overlay', 'auto', '--osr', '/r/job1.osr', '--json-only']);
    const frames = ffmpeg.options.pipeFrom;
    assert(frames);
    assert.equal(frames.command, '/opt/aulactl');
    const value = (flag: string): string | undefined => frames.args[frames.args.indexOf(flag) + 1];
    assert.equal(value('--out'), '-');
    assert.equal(value('--start-ms'), '-99.00');
    assert.equal(value('--preroll-ms'), '999.00');
    assert.equal(value('--duration-ms'), '12500');
    assert.equal(value('--height'), '360');
    assert.equal(value('--width'), '202');
    assert.equal(ffmpeg.command, '/d/ffmpeg');
    assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-s') + 1], '202x360');
    assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-c:v') + 1], 'h264_qsv');
    const log = await readFile(path.join(f.dir, 'logs', 'job1.log'), 'utf8');
    assert.match(log, /keyboard overlay applied: encoder h264_qsv/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('overlay step: no matching session is skipped quietly', async () => {
  const f = await overlayFixture([{ code: NO_SESSION_EXIT, output: 'aulactl: no recorded session lines up with this replay' }]);
  try {
    const result = await f.overlay.apply(f.job, f.video, ENABLED, f.tools);
    assert.equal(result.status, 'skipped');
    assert.equal(await readFile(f.video, 'utf8'), 'danser', 'video untouched');
    assert.equal(f.calls.length, 2);
    assert.match(await readFile(path.join(f.dir, 'logs', 'job1.log'), 'utf8'), /keyboard overlay skipped: no recorded keyboard session/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('overlay step: a failing hardware encoder falls back to libx264', async () => {
  const ok = { code: 0, output: '' };
  const f = await overlayFixture([ok, { code: 1, output: 'qsv init failed', producer: ok }, { ...ok, producer: ok }]);
  try {
    const result = await f.overlay.apply(f.job, f.video, ENABLED, f.tools);
    assert.equal(result.status, 'applied');
    assert.match(result.note, /libx264/);
    assert.equal(f.calls[3].args[f.calls[3].args.indexOf('-c:v') + 1], 'libx264');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('overlay step failures keep danser\'s video', async () => {
  const f = await overlayFixture([{ code: 1, output: 'boom\naulactl: bad things' }]);
  try {
    const result = await f.overlay.apply(f.job, f.video, ENABLED, f.tools);
    assert.equal(result.status, 'failed');
    assert.match(result.note, /aulactl exited with 1: aulactl: bad things/);
    assert.equal(await readFile(f.video, 'utf8'), 'danser');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
  const both = await overlayFixture([{ code: 0, output: '' }, { code: 1, output: 'x' }, { code: 1, output: 'y' }]);
  const producerFails = await overlayFixture([{ code: 0, output: '' },
    { code: 0, output: '', producer: { code: 1, output: 'aulactl: font missing' } }]);
  try {
    const result = await producerFails.overlay.apply(producerFails.job, producerFails.video, ENABLED, producerFails.tools);
    assert.deepEqual(result, { status: 'failed', note: 'aulactl exited with 1: aulactl: font missing' });
    assert.equal(producerFails.calls.length, 3, 'no encoder retry when aulactl failed');
    assert.equal(await readFile(producerFails.video, 'utf8'), 'danser', 'a partial overlay is not kept');
  } finally {
    await rm(producerFails.dir, { recursive: true, force: true });
  }
  try {
    const result = await both.overlay.apply(both.job, both.video, ENABLED, both.tools);
    assert.equal(result.status, 'failed');
    assert.match(result.note, /libx264/);
    assert.equal(await readFile(both.video, 'utf8'), 'danser');
  } finally {
    await rm(both.dir, { recursive: true, force: true });
  }
  const noMap = await overlayFixture([], null);
  try {
    assert.deepEqual(await noMap.overlay.apply(noMap.job, noMap.video, ENABLED, noMap.tools),
      { status: 'skipped', note: 'beatmap file not found' });
    assert.equal(noMap.calls.length, 0);
  } finally {
    await rm(noMap.dir, { recursive: true, force: true });
  }
  const badProbe = await overlayFixture([]);
  try {
    badProbe.calls.length = 0;
    const result = await new KeyOverlay({
      aulactl: '/opt/aulactl', findBeatmapFile: async () => path.join(badProbe.dir, 'map.osu'),
      danserSettingsPath: path.join(badProbe.dir, 'settings.json'), tempDir: path.join(badProbe.dir, 'temp'),
      logsDir: path.join(badProbe.dir, 'logs'), platform: 'linux',
      runTool: async () => ({ code: 0, output: 'N/A' }),
    }).apply(badProbe.job, badProbe.video, ENABLED, badProbe.tools);
    assert.deepEqual(result, { status: 'failed', note: 'could not read the video length' });
  } finally {
    await rm(badProbe.dir, { recursive: true, force: true });
  }
});

test('overlay step: cancelling rejects instead of keeping a half-done video', async () => {
  const f = await overlayFixture([]);
  try {
    const abort = new AbortController();
    const overlay = new KeyOverlay({
      aulactl: '/opt/aulactl', findBeatmapFile: async () => path.join(f.dir, 'map.osu'),
      danserSettingsPath: path.join(f.dir, 'settings.json'), tempDir: path.join(f.dir, 'temp'), logsDir: path.join(f.dir, 'logs'),
      platform: 'linux',
      runTool: async () => { abort.abort(); throw new Error('cancelled'); },
    });
    await assert.rejects(overlay.apply(f.job, f.video, ENABLED, f.tools, abort.signal), /cancelled/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('keyboard overlay render options are validated', () => {
  const defaults = parseRenderOptions(undefined);
  assert.equal(defaults.keyOverlay, false);
  assert.equal(defaults.keyOverlayCorner, 'bottom-right');
  assert.equal(defaults.keyOverlayScale, 40);
  assert.equal(defaults.keyOverlayOpacity, 90);
  const set = parseRenderOptions(JSON.stringify({ keyOverlay: true, keyOverlayCorner: 'top-right', keyOverlayScale: 80, keyOverlayOpacity: 20 }));
  assert.deepEqual([set.keyOverlay, set.keyOverlayCorner, set.keyOverlayScale, set.keyOverlayOpacity], [true, 'top-right', 80, 20]);
  assert.throws(() => parseRenderOptions('{"keyOverlayCorner":"middle"}'), /keyOverlayCorner/);
  assert.throws(() => parseRenderOptions('{"keyOverlayScale":81}'), /keyOverlayScale/);
  assert.throws(() => parseRenderOptions('{"keyOverlayOpacity":19}'), /keyOverlayOpacity/);
  assert.throws(() => parseRenderOptions('{"keyOverlay":"yes"}'), /keyOverlay/);
});

test('runProcess pipes a producer into the tool and reports both', async () => {
  const node = process.execPath;
  const piped = await runProcess(node, ['-e', 'process.stdin.pipe(process.stdout)'], {
    timeoutMs: 10_000, captureStdout: true,
    pipeFrom: { command: node, args: ['-e', "process.stdout.write('frames'); console.error('made'); process.exitCode = 0"] },
  });
  assert.deepEqual(piped, { code: 0, output: 'frames', producer: { code: 0, output: 'made\n' } });
  const failing = await runProcess(node, ['-e', 'process.exitCode = 4'], { timeoutMs: 10_000 });
  assert.equal(failing.code, 4);
  assert.equal(failing.producer, undefined);
  // killed on timeout
  const slow = await runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
  assert.equal(slow.code, null);
  // aborted: rejects
  const abort = new AbortController();
  const pending = runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 10_000, signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(runProcess('/nonexistent/tool', [], { timeoutMs: 1000 }), /ENOENT/);
});
