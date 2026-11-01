import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { appendFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appConfig } from './app-config.js';
import { encoderFamily, isHardwareEncoder, isSupportedEncoder, type VideoEncoder } from './encoders.js';
import { libraryEnvironment, redactText, renameWithRetry, terminateProcessTree, type DanserTools } from './platform.js';
import { RESOLUTION_DIMENSIONS, buildEncoderPatch, type RenderOptions } from './render-options.js';
import type { RenderRow } from './types.js';
import type { KeyOverlayCorner } from './key-overlay-options.js';

/**
 * Keyboard overlay: after danser rendered a replay, `aulactl replay overlay auto` draws the owner's recorded
 * keyboard (analog key travel, presses, KPS/BPM, KeyOverlay-style bars) as a transparent video on the replay's
 * song clock, and ffmpeg lays it over danser's video. The song time each video frame shows is derived from
 * the danser settings osu-render uses (danserTimeline). Linux only (aulactl is a Linux tool).
 */

export { KEY_OVERLAY_CORNERS, type KeyOverlayCorner } from './key-overlay-options.js';

/** aulactl's exit code when no recorded session lines up with the replay. */
export const NO_SESSION_EXIT = 3;
/** danser (record mode) advances its clock in 1 ms steps and captures frame 0 after the first step. */
const DANSER_UPDATE_MS = 1;
/** danser record mode forces LeadInTime 0 and waits max(LeadInTime, 1 s) before the map starts. */
const DANSER_MIN_LEAD_IN_MS = 1000;
/** Overlay canvas aspect (width / height). */
const OVERLAY_ASPECT = 9 / 16;
const STDERR_TAIL_BYTES = 4096;

/**
 * Where aulactl is: KEY_OVERLAY_AULACTL (a path, or "off"), else `aulactl` on PATH or in ~/.local/bin.
 * null = the feature is unavailable (always on Windows).
 */
export function resolveAulactl(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  const configured = env.KEY_OVERLAY_AULACTL?.trim();
  if (configured && ['off', 'false', '0', 'no'].includes(configured.toLowerCase())) return null;
  const candidates = configured
    ? [configured]
    : [...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'aulactl')),
      path.join(env.HOME ?? os.homedir(), '.local', 'bin', 'aulactl')];
  return candidates.find((file) => path.isAbsolute(file) && isExecutable(file)) ?? null;
}

function isExecutable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/** What danser's start time depends on in a .osu file. */
export interface OsuTiming {
  formatVersion: number;
  approachRate: number;
  /** Earliest hit object (ms). */
  firstObjectMs: number;
}

/** Reads the format version, approach rate (OD when the map has none, like danser) and first hit object. */
export function parseOsuTiming(text: string): OsuTiming {
  let formatVersion = 0;
  let ar: number | undefined;
  let od: number | undefined;
  let firstObjectMs = Number.POSITIVE_INFINITY;
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (formatVersion === 0) {
      const version = /^osu file format v(\d+)/.exec(line);
      if (version) { formatVersion = Number(version[1]); continue; }
    }
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    if (section === 'Difficulty') {
      const [key, value] = line.split(':', 2).map((part) => part.trim());
      const parsed = Number(value);
      if (key === 'ApproachRate' && Number.isFinite(parsed)) ar = clamp(parsed, 0, 10);
      if (key === 'OverallDifficulty' && Number.isFinite(parsed)) od = clamp(parsed, 0, 10);
    } else if (section === 'HitObjects' && line) {
      const time = Number(line.split(',')[2]);
      if (Number.isFinite(time)) firstObjectMs = Math.min(firstObjectMs, time);
    }
  }
  if (!Number.isFinite(firstObjectMs)) throw new Error('beatmap has no hit objects');
  return { formatVersion, approachRate: ar ?? od ?? 5, firstObjectMs };
}

/** Song speed of the replay's mods: DT/NC 1.5, HT 0.75. */
export function modsRate(mods: string): number {
  if (/DT|NC/.test(mods)) return 1.5;
  if (/HT/.test(mods)) return 0.75;
  return 1;
}

/** Approach preempt (ms) as danser computes it: AR with HR (×1.4, max 10) / EZ (÷2), float32 like danser. */
export function preemptMs(approachRate: number, mods: string): number {
  let ar = approachRate;
  if (mods.includes('HR')) ar = Math.min(ar * 1.4, 10);
  if (mods.includes('EZ')) ar /= 2;
  ar = Math.fround(ar);
  const value = ar > 5 ? 1200 + (450 - 1200) * (ar - 5) / 5 : ar < 5 ? 1200 - (1200 - 1800) * (5 - ar) / 5 : 1200;
  return Math.floor(value);
}

export interface DanserTimingInput {
  timing: OsuTiming;
  mods: string;
  /** -quickstart (osu-render's skipIntro): skip to the first object, lead-in hold 0. */
  quickstart: boolean;
  /** Playfield.LeadInHold (s) of the settings danser runs with. */
  leadInHoldS: number;
  /** Playfield.SeizureWarning of the settings danser runs with. */
  seizureWarning: { enabled: boolean; durationS: number };
}

/** Song time of video frame 0, real-time video ms before the song clock runs at the mod rate, and that rate. */
export interface OverlayTimeline {
  startMs: number;
  prerollMs: number;
  rate: number;
}

/**
 * The song time danser's video shows (danser-go app/states/player.go, record mode): the clock starts at
 * startPointE − LeadInHold − seizure warning − max(LeadInTime, 1 s) (record mode forces LeadInTime 0),
 * runs at speed 1 until startPointE and at the mod rate after it; startPointE = first object − preempt
 * (preempt = min(1800, AR preempt)) when skipping and that is > 0, else −preempt. Song time = clock − 24 ms
 * for maps older than format v5. Frame 0 is captured after the first 1 ms step.
 */
export function danserTimeline(input: DanserTimingInput): OverlayTimeline {
  const rate = modsRate(input.mods);
  const preempt = Math.min(1800, preemptMs(input.timing.approachRate, input.mods));
  const skipTime = input.timing.firstObjectMs - preempt;
  const startPointE = input.quickstart && Math.max(0, skipTime) > 0.01 ? skipTime : -preempt;
  const holdMs = input.quickstart ? 0 : Math.max(0, input.leadInHoldS) * 1000;
  const seizureMs = input.seizureWarning.enabled ? Math.max(1000, input.seizureWarning.durationS * 1000) : 0;
  const clockStart = startPointE - holdMs - seizureMs - DANSER_MIN_LEAD_IN_MS;
  const oldOffset = input.timing.formatVersion < 5 ? 24 : 0;
  const frame0 = clockStart + DANSER_UPDATE_MS;
  return {
    startMs: frame0 - oldOffset,
    // the clock speeds up once song time (clock − oldOffset) reaches startPointE
    prerollMs: Math.max(0, startPointE + oldOffset - frame0),
    rate,
  };
}

/** LeadInHold and SeizureWarning from a danser settings file (danser's defaults when missing). */
export function danserLeadIn(settings: unknown): { leadInHoldS: number; seizureWarning: { enabled: boolean; durationS: number } } {
  const playfield = isRecord(settings) && isRecord(settings.Playfield) ? settings.Playfield : {};
  const hold = typeof playfield.LeadInHold === 'number' && Number.isFinite(playfield.LeadInHold) ? playfield.LeadInHold : 2;
  const seizure = isRecord(playfield.SeizureWarning) ? playfield.SeizureWarning : {};
  return {
    leadInHoldS: hold,
    seizureWarning: {
      enabled: seizure.Enabled === true,
      durationS: typeof seizure.Duration === 'number' && Number.isFinite(seizure.Duration) ? seizure.Duration : 5,
    },
  };
}

/** Overlay size in px for a video height and the scale option (% of the video height); both even. */
export function overlaySize(videoHeight: number, scalePercent: number): { width: number; height: number } {
  const height = even(videoHeight * scalePercent / 100);
  return { width: even(height * OVERLAY_ASPECT), height };
}

/** ffmpeg overlay position for a corner (margin = 2 % of the video height). */
export function overlayPosition(corner: KeyOverlayCorner, videoHeight: number): { x: string; y: string } {
  const margin = Math.round(videoHeight * 0.02);
  return {
    x: corner.endsWith('left') ? String(margin) : `main_w-overlay_w-${margin}`,
    y: corner.startsWith('top') ? String(margin) : `main_h-overlay_h-${margin}`,
  };
}

/** Video encoder options, mirroring what danser passes for the same Recording.<encoder> block (rate control, quality, preset). */
export function compositeEncoderArgs(encoder: VideoEncoder, options: Pick<RenderOptions, 'speedProfile'>): string[] {
  const patch = buildEncoderPatch(encoder, options.speedProfile);
  const family = encoderFamily(encoder);
  const quality = String(patch[appConfig.speedProfiles.families[family].qualityKey]);
  const preset = patch.Preset;
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
  args.push(family === 'amf' ? '-preset:v' : '-preset', preset);
  args.push('-pix_fmt', family === 'qsv' ? 'nv12' : 'yuv420p');
  return args;
}

/** ffmpeg arguments that lay the overlay (raw RGBA frames on stdin) over `video` (audio copied) into `output`. */
export function compositeArguments(input: {
  video: string; overlay: { width: number; height: number; fps: number }; output: string; corner: KeyOverlayCorner;
  opacity: number; videoHeight: number; encoderArgs: string[];
}): string[] {
  const { x, y } = overlayPosition(input.corner, input.videoHeight);
  const alpha = (Math.min(100, Math.max(0, input.opacity)) / 100).toFixed(2);
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input.video,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${input.overlay.width}x${input.overlay.height}`,
    '-r', String(input.overlay.fps), '-i', 'pipe:0',
    '-filter_complex',
    `[1:v]format=rgba,colorchannelmixer=aa=${alpha}[keys];[0:v][keys]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[v]`,
    '-map', '[v]', '-map', '0:a?', '-c:a', 'copy',
    ...input.encoderArgs,
    '-movflags', '+faststart',
    input.output,
  ];
}

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
  code: number | null;
  /** Tail of stderr (and stdout with captureStdout). */
  output: string;
  producer?: { code: number | null; output: string };
}

export type ToolRunner = (command: string, args: string[], options: ToolOptions) => Promise<ToolResult>;

export interface KeyOverlayDependencies {
  aulactl: string;
  /** The .osu file of a beatmap checksum, null when it is not on disk. */
  findBeatmapFile: (checksum: string) => Promise<string | null>;
  /** danser settings file the renders use (LeadInHold, SeizureWarning). */
  danserSettingsPath: string;
  tempDir: string;
  logsDir: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runTool?: ToolRunner;
}

export interface KeyOverlayResult {
  status: 'applied' | 'skipped' | 'failed';
  note: string;
}

export class KeyOverlay {
  private readonly runTool: ToolRunner;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly dependencies: KeyOverlayDependencies) {
    this.runTool = dependencies.runTool ?? runProcess;
    this.platform = dependencies.platform ?? process.platform;
  }

  /**
   * Lays the keyboard overlay over `video` in place. Never throws for overlay problems: the job keeps
   * danser's video and the job log gets a note ("[osu-render] keyboard overlay: ...").
   */
  async apply(job: RenderRow, video: string, options: Readonly<RenderOptions>, tools: DanserTools, signal?: AbortSignal): Promise<KeyOverlayResult> {
    const checkFile = path.join(this.dependencies.tempDir, `${job.id}-keys.json`);
    const composite = path.join(this.dependencies.tempDir, `${job.id}-keys.mp4`);
    let result: KeyOverlayResult;
    try {
      result = await this.run(job, video, options, tools, checkFile, composite, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      result = { status: 'failed', note: error instanceof Error ? error.message : String(error) };
    } finally {
      await Promise.all([rm(checkFile, { force: true }), rm(composite, { force: true })]);
    }
    await appendFile(path.join(this.dependencies.logsDir, `${job.id}.log`),
      `[osu-render] keyboard overlay ${result.status}: ${redactText(result.note)}\n`, { mode: 0o600 }).catch(() => undefined);
    return result;
  }

  private async run(job: RenderRow, video: string, options: Readonly<RenderOptions>, tools: DanserTools,
    checkFile: string, composite: string, signal?: AbortSignal): Promise<KeyOverlayResult> {
    if (!job.beatmap_checksum) return { status: 'skipped', note: 'the replay has no beatmap' };
    const osu = await this.dependencies.findBeatmapFile(job.beatmap_checksum);
    if (!osu) return { status: 'skipped', note: 'beatmap file not found' };
    const timing = parseOsuTiming(await readFile(osu, 'utf8'));
    const settings: unknown = JSON.parse(await readFile(this.dependencies.danserSettingsPath, 'utf8'));
    const timeline = danserTimeline({ timing, mods: job.mods ?? '', quickstart: options.skipIntro, ...danserLeadIn(settings) });
    const env = libraryEnvironment(tools.libraryDirs, process.env, this.platform);
    const timeoutMs = this.dependencies.timeoutMs ?? appConfig.keyOverlay.timeoutMs;
    const durationMs = await this.videoDurationMs(tools, video, env, signal);
    const videoHeight = RESOLUTION_DIMENSIONS[options.resolution].height;
    const size = overlaySize(videoHeight, options.keyOverlayScale);
    const fps = appConfig.keyOverlay.fps;
    // finding the session first: no matching session is a quiet skip, not a failed composite
    const check = await this.runTool(this.dependencies.aulactl,
      ['replay', 'overlay', 'auto', '--osr', job.replay_path, '--json-only', '--out', checkFile], { env, timeoutMs, signal });
    if (check.code === NO_SESSION_EXIT) return { status: 'skipped', note: 'no recorded keyboard session matches this replay' };
    if (check.code !== 0) return { status: 'failed', note: `aulactl exited with ${check.code}: ${lastLine(check.output)}` };
    const frames = {
      command: this.dependencies.aulactl,
      args: ['replay', 'overlay', 'auto', '--osr', job.replay_path, '--out', '-',
        '--width', String(size.width), '--height', String(size.height), '--fps', String(fps),
        '--start-ms', timeline.startMs.toFixed(2), '--duration-ms', durationMs.toFixed(0),
        '--preroll-ms', timeline.prerollMs.toFixed(2)],
    };
    const encoders: VideoEncoder[] = isSupportedEncoder(job.encoder)
      ? [...new Set<VideoEncoder>([job.encoder, ...(isHardwareEncoder(job.encoder) ? ['libx264' as const] : [])])]
      : ['libx264'];
    let failure = '';
    for (const encoder of encoders) {
      const args = compositeArguments({
        video, overlay: { ...size, fps }, output: composite, corner: options.keyOverlayCorner,
        opacity: options.keyOverlayOpacity, videoHeight, encoderArgs: compositeEncoderArgs(encoder, options),
      });
      const done = await this.runTool(tools.ffmpeg, args, { env, timeoutMs, signal, pipeFrom: frames });
      const drawn = done.producer?.code === 0;
      // ffmpeg finishing on a cut-off stream (aulactl failed midway) would leave a partial overlay
      if (done.code === 0 && !drawn) {
        return { status: 'failed', note: `aulactl exited with ${done.producer?.code}: ${lastLine(done.producer?.output ?? '')}` };
      }
      if (done.code === 0) {
        await renameWithRetry(composite, video);
        return {
          status: 'applied',
          note: `encoder ${encoder}, song ${timeline.startMs.toFixed(0)} ms at frame 0, pre-roll ${timeline.prerollMs.toFixed(0)} ms, rate ${timeline.rate}`,
        };
      }
      // a failing encoder closes the pipe early, so aulactl failing too is expected here
      failure = `ffmpeg (${encoder}) exited with ${done.code}: ${lastLine(done.output)}`;
    }
    return { status: 'failed', note: failure };
  }

  private async videoDurationMs(tools: DanserTools, video: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<number> {
    const probe = await this.runTool(tools.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video,
    ], { env, timeoutMs: 30_000, signal, captureStdout: true });
    const seconds = Number(probe.output.trim().split(/\s+/)[0]);
    if (probe.code !== 0 || !(seconds > 0)) throw new Error('could not read the video length');
    return seconds * 1000;
  }
}

/**
 * Runs a tool hidden; resolves with its exit code and output tail (stderr, plus stdout with captureStdout).
 * With pipeFrom, a producer process is started too and its stdout feeds the tool's stdin; both are killed on
 * timeout or abort, and the result waits for both.
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
    const keep = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-STDERR_TAIL_BYTES); };
    if (keepStdout) child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, output }));
    });
    return { child, result };
  }
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 300) || 'no output';
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
