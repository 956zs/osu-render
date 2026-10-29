import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { appConfig } from './app-config.js';
import { AppError } from './errors.js';
import {
  libraryEnvironment, redactText, renameWithRetry, resolveDanserTools, terminateProcessTree, type DanserTools,
} from './platform.js';
import type { Paths, RenderRow } from './types.js';
import { buildDanserPatch, parseRenderOptions } from './render-options.js';

const execFileAsync = promisify(execFile);
const PROGRESS_PATTERN = /Progress:\s*(\d+)%,\s*Speed:\s*([\d.]+)?x?(?:,\s*ETA:\s*([^,]*))?/g;
/** ffmpeg status lines (danser prints them with ShowFFmpegLogs); the final mux pass reports the total. */
const FRAME_PATTERN = /\bframe=\s*(\d+)/g;
const TERMINATE_GRACE_MS = 10_000;
const STDIO_DRAIN_MS = 2_000;
const RM_RETRY = { force: true, recursive: true, maxRetries: 5, retryDelay: 200 } as const;

/** Render speed (1 = real time) and danser's ETA text, from the latest progress line. */
export interface ProgressDetail {
  speed: number | null;
  eta: string | null;
}

/** Speeds danser reported for one render; avg is the harmonic mean (each progress line covers the same share of frames). */
export interface SpeedSummary {
  avg: number | null;
  last: number | null;
  frames: number | null;
}

export interface RenderResult {
  path: string;
  speed: SpeedSummary;
}

export type ProgressListener = (progress: number, detail: ProgressDetail) => void;

export type ProcessSpawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RendererOptions {
  danserDir: string;
  danserBin?: string;
  settingsName?: string;
  paths: Paths;
  timeoutMs: number;
  /** Kill danser when it prints nothing for this long; defaults to appConfig.render.stallTimeoutMs. */
  stallTimeoutMs?: number;
  platform?: NodeJS.Platform;
  logTailBytes?: number;
  terminateGraceMs?: number;
  spawnProcess?: ProcessSpawner;
}

interface ActiveRender {
  jobId: string;
  process: ChildProcess;
  cancelled: boolean;
}

type Outcome = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'stalled';

export class DanserRenderer {
  private active: ActiveRender | null = null;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: RendererOptions) {
    this.platform = options.platform ?? process.platform;
  }

  async render(job: RenderRow, onProgress: ProgressListener): Promise<RenderResult> {
    const danserOutput = path.join(this.options.paths.danserOutput, `${job.id}.mp4`);
    const partOutput = path.join(this.options.paths.videos, `${job.id}.mp4.part`);
    const finalOutput = path.join(this.options.paths.videos, `${job.id}.mp4`);
    await this.cleanupOutputs(job.id);
    const tools = await resolveDanserTools(this.options.danserDir, this.options.danserBin, this.platform);
    const args = buildDanserArguments(job, this.options.settingsName);
    try {
      const speed = await this.runDanser(job.id, tools, args, onProgress);
      await access(danserOutput);
      await renameWithRetry(danserOutput, partOutput);
      await this.validateVideo(tools, partOutput);
      await renameWithRetry(partOutput, finalOutput);
      return { path: finalOutput, speed };
    } catch (error) {
      await this.cleanupOutputs(job.id).catch(() => undefined);
      throw error;
    }
  }

  async cancel(jobId: string): Promise<void> {
    const active = this.active;
    if (!active || active.jobId !== jobId) return;
    active.cancelled = true;
    const child = active.process;
    const exited = hasExited(child) ? Promise.resolve() : new Promise<void>((resolve) => child.once('exit', () => resolve()));
    terminateProcessTree(child, false, this.platform);
    const force = setTimeout(() => terminateProcessTree(child, true, this.platform),
      this.options.terminateGraceMs ?? TERMINATE_GRACE_MS);
    await exited;
    clearTimeout(force);
    await this.cleanupOutputs(jobId).catch(() => undefined);
  }

  private async runDanser(
    jobId: string,
    tools: DanserTools,
    args: string[],
    onProgress: ProgressListener,
  ): Promise<SpeedSummary> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(tools.danserCli, args, {
      cwd: this.options.danserDir, shell: false, windowsHide: true,
      env: libraryEnvironment(tools.libraryDirs, process.env, this.platform),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const active: ActiveRender = { jobId, process: child, cancelled: false };
    this.active = active;
    const tail = new OutputTail(this.options.logTailBytes ?? appConfig.diagnostics.logTailBytes);
    const speed = new SpeedTracker();
    const listener: ProgressListener = (progress, detail) => { speed.record(detail.speed); onProgress(progress, detail); };
    const parsers = { stdout: createProgressParser(listener), stderr: createProgressParser(listener) };
    // danser can sit silently while loading a big map or storyboard, so any output counts as activity.
    let stalled = false;
    const stallTimeoutMs = this.options.stallTimeoutMs ?? appConfig.render.stallTimeoutMs;
    const watchdog = setTimeout(() => {
      stalled = true;
      terminateProcessTree(child, true, this.platform);
    }, stallTimeoutMs);
    const onOutput = (parse: (text: string) => void) => (chunk: Buffer): void => {
      if (!stalled) watchdog.refresh();
      tail.push(chunk);
      const text = chunk.toString();
      parse(text);
      speed.observe(text);
    };
    child.stdout?.on('data', onOutput(parsers.stdout));
    child.stderr?.on('data', onOutput(parsers.stderr));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, true, this.platform);
    }, this.options.timeoutMs);
    let outcome: Outcome = 'failed';
    let exitText = 'did not start';
    try {
      const exit = await waitForProcess(child);
      exitText = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      outcome = active.cancelled ? 'cancelled' : timedOut ? 'timeout' : stalled ? 'stalled' : exit.code === 0 ? 'completed' : 'failed';
      if (outcome === 'timeout') throw new AppError('RENDER_TIMEOUT', `danser exceeded the render time limit (${exitText}).`, 500);
      if (outcome === 'stalled') {
        throw new AppError('RENDER_STALLED', `danser stopped responding: no output for ${Math.round(stallTimeoutMs / 1000)} s (${exitText}).`, 500);
      }
      if (outcome !== 'completed') throw new AppError('RENDER_FAILED', `danser exited with ${exitText}.`, 500);
      return speed.summary();
    } finally {
      clearTimeout(timeout);
      clearTimeout(watchdog);
      if (this.active === active) this.active = null;
      await this.writeLog(jobId, tail, `${outcome} (${exitText})`);
    }
  }

  private async writeLog(jobId: string, tail: OutputTail, outcome: string): Promise<void> {
    const file = path.join(this.options.paths.logs, `${jobId}.log`);
    const text = `${redactText(tail.text())}\n[osu-render] danser ${outcome}\n`;
    await mkdir(this.options.paths.logs, { recursive: true })
      .then(() => writeFile(file, text, { mode: 0o600 }))
      .catch(() => undefined);
  }

  private async validateVideo(tools: DanserTools, videoPath: string): Promise<void> {
    const { stdout } = await execFileAsync(tools.ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', videoPath,
    ], {
      timeout: 30_000, env: libraryEnvironment(tools.libraryDirs, process.env, this.platform),
      maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const result = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
    const types = new Set(result.streams?.map((stream) => stream.codec_type));
    if (!types.has('video') || !types.has('audio')) throw new AppError('RENDER_FAILED', 'Output video validation failed.', 500);
  }

  private async cleanupOutputs(jobId: string): Promise<void> {
    await Promise.all([
      rm(path.join(this.options.paths.danserOutput, `${jobId}.mp4`), RM_RETRY),
      rm(path.join(this.options.paths.danserOutput, `${jobId}_temp`), RM_RETRY),
      rm(path.join(this.options.paths.videos, `${jobId}.mp4.part`), RM_RETRY),
    ]);
  }
}

export function buildDanserArguments(job: RenderRow, settingsName = 'service'): string[] {
  const options = parseRenderOptions(job.options_json);
  const argumentsList = [
    `-settings=${settingsName}`,
    `-replay=${job.replay_path}`,
    `-out=${job.id}`,
    '-preciseprogress',
    '-noupdatecheck',
  ];
  if (options.skipIntro) argumentsList.push('-quickstart');
  argumentsList.push(`-sPatch=${JSON.stringify(buildDanserPatch(options, job.encoder))}`);
  return argumentsList;
}

export function createProgressParser(onProgress: ProgressListener): (output: string) => void {
  let pending = '';
  return (output) => {
    const lines = `${pending}${output}`.split(/\r\n|\r|\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      for (const match of line.matchAll(PROGRESS_PATTERN)) {
        const speed = match[2] === undefined ? Number.NaN : Number(match[2]);
        const eta = match[3]?.trim();
        onProgress(Math.min(100, Number(match[1])), { speed: Number.isFinite(speed) ? speed : null, eta: eta ? eta : null });
      }
    }
  };
}

export class SpeedTracker {
  private inverseSum = 0;
  private samples = 0;
  private last: number | null = null;
  private frames: number | null = null;

  record(speed: number | null): void {
    if (speed === null || !(speed > 0)) return;
    this.inverseSum += 1 / speed;
    this.samples += 1;
    this.last = speed;
  }

  /** Picks up ffmpeg frame counters from raw output. */
  observe(output: string): void {
    for (const match of output.matchAll(FRAME_PATTERN)) {
      const frames = Number(match[1]);
      if (Number.isSafeInteger(frames) && frames > (this.frames ?? -1)) this.frames = frames;
    }
  }

  summary(): SpeedSummary {
    const avg = this.samples > 0 ? Math.round((this.samples / this.inverseSum) * 100) / 100 : null;
    return { avg, last: this.last, frames: this.frames };
  }
}

export class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.limit) {
      this.size -= this.chunks.shift()?.length ?? 0;
      this.truncated = true;
    }
  }

  text(): string {
    const all = Buffer.concat(this.chunks);
    const start = Math.max(0, all.length - this.limit);
    const text = all.subarray(start).toString('utf8');
    if (!this.truncated && start === 0) return text;
    const firstLineEnd = text.indexOf('\n');
    return firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : text;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcess(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const done = (): void => { clearTimeout(timer); resolve({ code, signal }); };
      const timer = setTimeout(done, STDIO_DRAIN_MS);
      child.once('close', done);
    });
  });
}
