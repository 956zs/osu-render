import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { appConfig } from './app-config.js';
import { AppError } from './errors.js';
import { libraryEnvironment, redactText, resolveDanserTools, terminateProcessTree, type DanserTools } from './platform.js';
import type { Paths, RenderRow } from './types.js';
import { buildDanserPatch, parseRenderOptions } from './render-options.js';

const execFileAsync = promisify(execFile);
const PROGRESS_PATTERN = /Progress:\s*(\d+)%,\s*Speed:/g;
const TERMINATE_GRACE_MS = 10_000;
const STDIO_DRAIN_MS = 2_000;
const RM_RETRY = { force: true, recursive: true, maxRetries: 5, retryDelay: 200 } as const;

export type ProcessSpawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RendererOptions {
  danserDir: string;
  danserBin?: string;
  settingsName?: string;
  paths: Paths;
  timeoutMs: number;
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

type Outcome = 'completed' | 'failed' | 'cancelled' | 'timeout';

export class DanserRenderer {
  private active: ActiveRender | null = null;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: RendererOptions) {
    this.platform = options.platform ?? process.platform;
  }

  async render(job: RenderRow, onProgress: (progress: number) => void): Promise<string> {
    const danserOutput = path.join(this.options.paths.danserOutput, `${job.id}.mp4`);
    const partOutput = path.join(this.options.paths.videos, `${job.id}.mp4.part`);
    const finalOutput = path.join(this.options.paths.videos, `${job.id}.mp4`);
    await this.cleanupOutputs(job.id);
    const tools = await resolveDanserTools(this.options.danserDir, this.options.danserBin, this.platform);
    const args = buildDanserArguments(job, this.options.settingsName);
    try {
      await this.runDanser(job.id, tools, args, onProgress);
      await access(danserOutput);
      await rename(danserOutput, partOutput);
      await this.validateVideo(tools, partOutput);
      await rename(partOutput, finalOutput);
      return finalOutput;
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
    await this.cleanupOutputs(jobId);
  }

  private async runDanser(
    jobId: string,
    tools: DanserTools,
    args: string[],
    onProgress: (value: number) => void,
  ): Promise<void> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(tools.danserCli, args, {
      cwd: this.options.danserDir, shell: false, windowsHide: true,
      env: libraryEnvironment(tools.libraryDirs, process.env, this.platform),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const active: ActiveRender = { jobId, process: child, cancelled: false };
    this.active = active;
    const tail = new OutputTail(this.options.logTailBytes ?? appConfig.diagnostics.logTailBytes);
    const parsers = { stdout: createProgressParser(onProgress), stderr: createProgressParser(onProgress) };
    child.stdout?.on('data', (chunk: Buffer) => { tail.push(chunk); parsers.stdout(chunk.toString()); });
    child.stderr?.on('data', (chunk: Buffer) => { tail.push(chunk); parsers.stderr(chunk.toString()); });
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
      outcome = active.cancelled ? 'cancelled' : timedOut ? 'timeout' : exit.code === 0 ? 'completed' : 'failed';
      if (outcome === 'timeout') throw new AppError('RENDER_TIMEOUT', `danser exceeded the render time limit (${exitText}).`, 500);
      if (outcome !== 'completed') throw new AppError('RENDER_FAILED', `danser exited with ${exitText}.`, 500);
    } finally {
      clearTimeout(timeout);
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
  argumentsList.push(`-sPatch=${JSON.stringify(buildDanserPatch(options))}`);
  return argumentsList;
}

export function createProgressParser(onProgress: (value: number) => void): (output: string) => void {
  let pending = '';
  return (output) => {
    const lines = `${pending}${output}`.split(/\r\n|\r|\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      for (const match of line.matchAll(PROGRESS_PATTERN)) onProgress(Math.min(100, Number(match[1])));
    }
  };
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
