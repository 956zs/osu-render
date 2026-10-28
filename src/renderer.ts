import { spawn, type ChildProcess } from 'node:child_process';
import { access, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';
import { libraryEnvironment } from './preflight.js';
import type { Paths, RenderRow } from './types.js';
import { buildDanserPatch, parseRenderOptions } from './render-options.js';

const execFileAsync = promisify(execFile);
const PROGRESS_PATTERN = /Progress:\s*(\d+)%/g;
const TERMINATE_GRACE_MS = 10_000;

export interface RendererOptions {
  danserBin: string;
  danserDir: string;
  paths: Paths;
  timeoutMs: number;
}

export class DanserRenderer {
  private active: { jobId: string; process: ChildProcess } | null = null;
  private progressBuffers = { stdout: '', stderr: '' };

  constructor(private readonly options: RendererOptions) {}

  async render(job: RenderRow, onProgress: (progress: number) => void): Promise<string> {
    const outputBase = path.join(this.options.paths.danserOutput, job.id);
    const danserOutput = `${outputBase}.mp4`;
    const partOutput = path.join(this.options.paths.videos, `${job.id}.mp4.part`);
    const finalOutput = path.join(this.options.paths.videos, `${job.id}.mp4`);
    await this.cleanupOutputs(job.id);
    const args = buildDanserArguments(job);
    try {
      await this.runDanser(job.id, args, onProgress);
      await access(danserOutput);
      await rename(danserOutput, partOutput);
      await this.validateVideo(partOutput);
      await rename(partOutput, finalOutput);
      return finalOutput;
    } catch (error) {
      await this.cleanupOutputs(job.id);
      throw error;
    }
  }

  async cancel(jobId: string): Promise<void> {
    if (!this.active || this.active.jobId !== jobId) return;
    const child = this.active.process;
    const exited = child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), TERMINATE_GRACE_MS);
    await exited;
    clearTimeout(force);
    await this.cleanupOutputs(jobId);
  }

  private async runDanser(jobId: string, args: string[], onProgress: (value: number) => void): Promise<void> {
    const ffmpegDir = path.join(this.options.danserDir, 'ffmpeg');
    const child = spawn(this.options.danserBin, args, {
      cwd: this.options.danserDir, shell: false, env: libraryEnvironment(ffmpegDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.active = { jobId, process: child };
    this.progressBuffers = { stdout: '', stderr: '' };
    child.stdout?.on('data', (chunk: Buffer) => this.consumeProgress('stdout', chunk.toString(), onProgress));
    child.stderr?.on('data', (chunk: Buffer) => this.consumeProgress('stderr', chunk.toString(), onProgress));
    const timeout = setTimeout(() => child.kill('SIGKILL'), this.options.timeoutMs);
    try { await waitForProcess(child); } finally { clearTimeout(timeout); this.active = null; }
  }

  private consumeProgress(stream: 'stdout' | 'stderr', output: string, onProgress: (value: number) => void): void {
    const lines = `${this.progressBuffers[stream]}${output}`.split(/\r?\n/);
    this.progressBuffers[stream] = lines.pop() ?? '';
    for (const line of lines) {
      for (const match of line.matchAll(PROGRESS_PATTERN)) onProgress(Math.min(100, Number(match[1])));
    }
  }

  private async validateVideo(videoPath: string): Promise<void> {
    const ffmpegDir = path.join(this.options.danserDir, 'ffmpeg');
    const ffprobe = path.join(ffmpegDir, 'ffprobe');
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', videoPath,
    ], { timeout: 30_000, env: libraryEnvironment(ffmpegDir), maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
    const types = new Set(result.streams?.map((stream) => stream.codec_type));
    if (!types.has('video') || !types.has('audio')) throw new AppError('RENDER_FAILED', 'Output video validation failed.', 500);
  }

  private async cleanupOutputs(jobId: string): Promise<void> {
    await Promise.all([
      rm(path.join(this.options.paths.danserOutput, `${jobId}.mp4`), { force: true }),
      rm(path.join(this.options.paths.danserOutput, `${jobId}_temp`), { recursive: true, force: true }),
      rm(path.join(this.options.paths.videos, `${jobId}.mp4.part`), { force: true }),
    ]);
  }
}

export function buildDanserArguments(job: RenderRow): string[] {
  const options = parseRenderOptions(job.options_json);
  const argumentsList = [
    '-settings=service',
    `-replay=${job.replay_path}`,
    `-out=${job.id}`,
    '-preciseprogress',
    '-noupdatecheck',
  ];
  if (options.skipIntro) argumentsList.push('-quickstart');
  argumentsList.push(`-sPatch=${JSON.stringify(buildDanserPatch(options))}`);
  return argumentsList;
}

function waitForProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new AppError(signal === 'SIGKILL' ? 'RENDER_TIMEOUT' : 'RENDER_FAILED',
        `danser exited with ${signal ?? `code ${code}`}.`, 500));
    });
  });
}
