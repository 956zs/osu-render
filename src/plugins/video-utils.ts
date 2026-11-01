import { spawn, type ChildProcess } from 'node:child_process';
import { appConfig } from '../app-config.js';
import { encoderFamily, isHardwareEncoder, isSupportedEncoder, type VideoEncoder } from '../encoders.js';
import { terminateProcessTree } from '../platform.js';
import type { SpeedProfile } from '../app-config.js';
import { buildEncoderPatch } from '../render-options.js';

/** Helpers the host gives plugins (ctx.utils): processes, ffmpeg filters and re-encoding with the job's encoder. */

const OUTPUT_TAIL_BYTES = 4096;

export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type Corner = typeof CORNERS[number];

export interface ToolOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Keep stdout in `output` too (stderr always). */
  captureStdout?: boolean;
  /** Feed stdin from this process's stdout (its result comes back as `producer`). */
  pipeFrom?: { command: string; args: string[] };
}

export interface ToolResult {
  /** Exit code; null when killed by a signal. */
  code: number | null;
  /** Tail of stderr (and stdout with captureStdout). */
  output: string;
  producer?: { code: number | null; output: string };
}

export type ToolRunner = (command: string, args: string[], options: ToolOptions) => Promise<ToolResult>;

/**
 * Runs a tool hidden; resolves with its exit code and output tail. With pipeFrom, a producer process is started
 * too and its stdout feeds the tool's stdin; both are killed on timeout or abort (then it rejects with
 * "cancelled"), and the result waits for both.
 */
export async function runProcess(command: string, args: string[], options: ToolOptions): Promise<ToolResult> {
  if (options.signal?.aborted) throw new Error('cancelled');
  const children: ChildProcess[] = [];
  const kill = (): void => { for (const child of children) terminateProcessTree(child, true); };
  const timer = setTimeout(kill, options.timeoutMs);
  options.signal?.addEventListener('abort', kill, { once: true });
  try {
    const producer = options.pipeFrom ? start(options.pipeFrom.command, options.pipeFrom.args, 'ignore', 'pipe', false) : undefined;
    const consumer = start(command, args, producer ? 'pipe' : 'ignore',
      options.captureStdout ? 'pipe' : 'ignore', options.captureStdout === true);
    if (producer && consumer.child.stdin && producer.child.stdout) {
      // a consumer that quits early closes the pipe; the producer then fails with EPIPE, which is expected
      consumer.child.stdin.on('error', () => undefined);
      producer.child.stdout.pipe(consumer.child.stdin);
    }
    const [made, done] = await Promise.all([producer?.result, consumer.result]);
    if (options.signal?.aborted) throw new Error('cancelled');
    return made ? { ...done, producer: made } : done;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', kill);
  }

  /** keepStdout: stdout goes into `output` (a producer's piped stdout does not). */
  function start(file: string, argv: string[], stdin: 'ignore' | 'pipe', stdout: 'ignore' | 'pipe', keepStdout: boolean):
    { child: ChildProcess; result: Promise<{ code: number | null; output: string }> } {
    const child = spawn(file, argv, { env: options.env, shell: false, windowsHide: true, stdio: [stdin, stdout, 'pipe'] });
    children.push(child);
    let output = '';
    const keep = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-OUTPUT_TAIL_BYTES); };
    if (keepStdout) child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, output }));
    });
    return { child, result };
  }
}

/** ffmpeg input arguments for raw RGBA frames on stdin. */
export function rawVideoInput(size: { width: number; height: number; fps: number }): string[] {
  return ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${size.height}`, '-r', String(size.fps), '-i', 'pipe:0'];
}

/** overlay filter position for a corner; the margin is a share of the video height. */
export function overlayPosition(corner: Corner, videoHeight: number, marginPercent = 2): { x: string; y: string } {
  const margin = Math.round(videoHeight * marginPercent / 100);
  return {
    x: corner.endsWith('left') ? String(margin) : `main_w-overlay_w-${margin}`,
    y: corner.startsWith('top') ? String(margin) : `main_h-overlay_h-${margin}`,
  };
}

/**
 * filter_complex that lays input `input` (e.g. "1:v", with alpha) over the video (input 0) in a corner with an
 * opacity (0..100) and labels the result [v], as encodeVideo expects.
 */
export function overlayFilter(options: { input: string; corner: Corner; opacity: number; videoHeight: number; marginPercent?: number }): string {
  const { x, y } = overlayPosition(options.corner, options.videoHeight, options.marginPercent);
  const alpha = (Math.min(100, Math.max(0, options.opacity)) / 100).toFixed(2);
  return `[${options.input}]format=rgba,colorchannelmixer=aa=${alpha}[ovl];[0:v][ovl]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[v]`;
}

/** Encoder options mirroring what danser passes for the same Recording.<encoder> block (rate control, quality, preset). */
export function encoderArgs(encoder: VideoEncoder, profile: SpeedProfile): string[] {
  const patch = buildEncoderPatch(encoder, profile);
  const family = encoderFamily(encoder);
  const quality = String(patch[appConfig.speedProfiles.families[family].qualityKey]);
  const h264 = encoder.startsWith('h264_') || encoder === 'libx264';
  const args = ['-c:v', encoder];
  switch (family) {
    case 'x264': args.push('-crf', quality); break;
    case 'nvenc': args.push('-rc', 'vbr', '-b:v', '400M', '-cq', quality); break;
    case 'qsv': args.push('-global_quality', quality); break;
    case 'amf': args.push('-usage', 'transcoding', '-rc', 'cqp', '-qp_i', quality, '-qp_p', quality,
      ...(h264 ? ['-qp_b', quality] : [])); break;
  }
  if (h264) args.push('-profile:v', 'high');
  args.push(family === 'amf' ? '-preset:v' : '-preset', patch.Preset);
  args.push('-pix_fmt', family === 'qsv' ? 'nv12' : 'yuv420p');
  return args;
}

/** The job's encoder first, libx264 after a hardware encoder (it may fail on this input), or libx264 alone. */
export function encoderOrder(encoder: string): VideoEncoder[] {
  if (!isSupportedEncoder(encoder)) return ['libx264'];
  return [...new Set<VideoEncoder>([encoder, ...(isHardwareEncoder(encoder) ? ['libx264' as const] : [])])];
}

export interface EncodeRequest {
  /** filter_complex; input 0 is the job's video, the result must be labelled [v]. */
  filter: string;
  /** More ffmpeg inputs (e.g. rawVideoInput(...) or ['-i', 'image.png']). */
  inputs?: string[];
  /** A process whose stdout feeds ffmpeg's stdin (for a pipe:0 input). */
  stdinFrom?: { command: string; args: string[] };
  output: string;
}

export interface EncodeResult {
  encoder: VideoEncoder;
}

/** Context the host binds encodeVideo to. */
export interface EncodeContext {
  video: string;
  ffmpeg: string;
  env: NodeJS.ProcessEnv;
  encoder: string;
  speedProfile: SpeedProfile;
  timeoutMs: number;
  signal?: AbortSignal;
  runTool?: ToolRunner;
}

/**
 * Re-encodes the job's video through `filter` with the job's encoder settings, falling back to libx264 when a
 * hardware encoder fails; the audio is copied. Throws with ffmpeg's last line when every encoder failed, or
 * when the stdin producer failed (a cut-off stream would leave a partial result).
 */
export async function encodeVideo(context: EncodeContext, request: EncodeRequest): Promise<EncodeResult> {
  const run = context.runTool ?? runProcess;
  let failure = 'no encoder';
  for (const encoder of encoderOrder(context.encoder)) {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', context.video, ...(request.inputs ?? []),
      '-filter_complex', request.filter, '-map', '[v]', '-map', '0:a?', '-c:a', 'copy',
      ...encoderArgs(encoder, context.speedProfile), '-movflags', '+faststart', request.output,
    ];
    const done = await run(context.ffmpeg, args, {
      env: context.env, timeoutMs: context.timeoutMs, signal: context.signal,
      ...(request.stdinFrom ? { pipeFrom: request.stdinFrom } : {}),
    });
    const fed = !done.producer || done.producer.code === 0;
    if (done.code === 0 && !fed) {
      throw new Error(`${request.stdinFrom?.command} exited with ${done.producer?.code}: ${lastLine(done.producer?.output ?? '')}`);
    }
    if (done.code === 0) return { encoder };
    // a failing encoder closes the pipe early, so the producer failing too is expected here
    failure = `ffmpeg (${encoder}) exited with ${done.code}: ${lastLine(done.output)}`;
  }
  throw new Error(failure);
}

export function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 300) || 'no output';
}
