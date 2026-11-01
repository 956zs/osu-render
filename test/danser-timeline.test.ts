import assert from 'node:assert/strict';
import test from 'node:test';
import {
  danserLeadIn, danserTimeline, modsRate, parseOsuTiming, preemptMs, songTimeAt,
} from '../src/danser-timeline.js';
import {
  encodeVideo, encoderArgs, encoderOrder, overlayFilter, overlayPosition, rawVideoInput, runProcess, type ToolOptions, type ToolResult,
} from '../src/plugins/video-utils.js';

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

test('encoder options mirror danser per encoder family', () => {
  assert.deepEqual(encoderArgs('libx264', 'balanced'),
    ['-c:v', 'libx264', '-crf', '18', '-profile:v', 'high', '-preset', 'faster', '-pix_fmt', 'yuv420p']);
  assert.deepEqual(encoderArgs('h264_qsv', 'balanced'),
    ['-c:v', 'h264_qsv', '-global_quality', '20', '-profile:v', 'high', '-preset', 'faster', '-pix_fmt', 'nv12']);
  assert.deepEqual(encoderArgs('hevc_nvenc', 'fast'),
    ['-c:v', 'hevc_nvenc', '-rc', 'vbr', '-b:v', '400M', '-cq', '26', '-preset', 'p1', '-pix_fmt', 'yuv420p']);
  assert.deepEqual(encoderArgs('h264_amf', 'quality'), ['-c:v', 'h264_amf', '-usage', 'transcoding',
    '-rc', 'cqp', '-qp_i', '18', '-qp_p', '18', '-qp_b', '18', '-profile:v', 'high', '-preset:v', 'quality', '-pix_fmt', 'yuv420p']);
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
  // killed on timeout (a signal on Linux, taskkill's exit code 1 on Windows)
  const slow = await runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
  assert.notEqual(slow.code, 0);
  // aborted: rejects
  const abort = new AbortController();
  const pending = runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 10_000, signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(runProcess('/nonexistent/tool', [], { timeoutMs: 1000 }), /ENOENT/);
});

test('song time at a video time follows the pre-roll, then the rate', () => {
  const timeline = { startMs: -99, prerollMs: 999, rate: 1.5 };
  assert.equal(songTimeAt(timeline, 0), -99);
  assert.equal(songTimeAt(timeline, 500), 401);
  assert.equal(songTimeAt(timeline, 1999), -99 + 999 + 1500);
});

test('overlay filter, position and raw input arguments', () => {
  assert.deepEqual(overlayPosition('top-left', 1000), { x: '20', y: '20' });
  assert.deepEqual(overlayPosition('bottom-right', 1000, 5), { x: 'main_w-overlay_w-50', y: 'main_h-overlay_h-50' });
  const filter = overlayFilter({ input: '1:v', corner: 'bottom-left', opacity: 90, videoHeight: 1080 });
  assert.equal(filter, '[1:v]format=rgba,colorchannelmixer=aa=0.90[ovl];[0:v][ovl]overlay=x=22:y=main_h-overlay_h-22:eof_action=pass:format=auto[v]');
  assert.match(overlayFilter({ input: '2:v', corner: 'top-right', opacity: 500, videoHeight: 720 }), /aa=1\.00/);
  assert.deepEqual(rawVideoInput({ width: 244, height: 432, fps: 60 }),
    ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '244x432', '-r', '60', '-i', 'pipe:0']);
  assert.deepEqual(encoderOrder('h264_qsv'), ['h264_qsv', 'libx264']);
  assert.deepEqual(encoderOrder('libx264'), ['libx264']);
  assert.deepEqual(encoderOrder('unknown'), ['libx264']);
});

function fakeRunner(results: ToolResult[]) {
  const calls: Array<{ command: string; args: string[]; options: ToolOptions }> = [];
  const runTool = async (command: string, args: string[], options: ToolOptions): Promise<ToolResult> => {
    calls.push({ command, args, options });
    return results.shift() ?? { code: 1, output: 'unexpected' };
  };
  return { calls, runTool };
}

const ENCODE = { video: 'in.mp4', ffmpeg: '/d/ffmpeg', env: {}, encoder: 'h264_qsv', speedProfile: 'balanced' as const, timeoutMs: 1000 };

test('encodeVideo uses the job encoder, copies audio and falls back to libx264', async () => {
  const ok = fakeRunner([{ code: 0, output: '' }]);
  assert.deepEqual(await encodeVideo({ ...ENCODE, runTool: ok.runTool }, { filter: '[0:v]null[v]', output: 'out.mp4' }), { encoder: 'h264_qsv' });
  const args = ok.calls[0].args;
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 6), ['-map', '[v]', '-map', '0:a?', '-c:a', 'copy']);
  assert.equal(args.at(-1), 'out.mp4');
  assert.equal(args[args.indexOf('-i') + 1], 'in.mp4');
  const fallback = fakeRunner([{ code: 1, output: 'qsv init failed' }, { code: 0, output: '' }]);
  assert.deepEqual(await encodeVideo({ ...ENCODE, runTool: fallback.runTool }, { filter: 'f', output: 'o' }), { encoder: 'libx264' });
  const none = fakeRunner([{ code: 1, output: 'a' }, { code: 1, output: 'x\nlast words' }]);
  await assert.rejects(encodeVideo({ ...ENCODE, runTool: none.runTool }, { filter: 'f', output: 'o' }), /ffmpeg \(libx264\) exited with 1: last words/);
});

test('encodeVideo refuses a result fed by a failed producer', async () => {
  const stdinFrom = { command: '/opt/tool', args: ['--frames'] };
  const cut = fakeRunner([{ code: 0, output: '', producer: { code: 2, output: 'tool: font missing' } }]);
  await assert.rejects(encodeVideo({ ...ENCODE, runTool: cut.runTool }, { filter: 'f', inputs: ['-i', 'pipe:0'], stdinFrom, output: 'o' }),
    /\/opt\/tool exited with 2: tool: font missing/);
  assert.equal(cut.calls.length, 1, 'no retry');
  assert.deepEqual(cut.calls[0].options.pipeFrom, stdinFrom);
  // the encoder failing first (closing the pipe) still retries
  const retry = fakeRunner([{ code: 1, output: 'x', producer: { code: 1, output: 'EPIPE' } }, { code: 0, output: '', producer: { code: 0, output: '' } }]);
  assert.deepEqual(await encodeVideo({ ...ENCODE, runTool: retry.runTool }, { filter: 'f', stdinFrom, output: 'o' }), { encoder: 'libx264' });
});
