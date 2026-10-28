import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HealthSnapshot, Paths } from './types.js';

const execFileAsync = promisify(execFile);

export interface PreflightResult {
  renderer: boolean;
  display: boolean;
  encoder: 'h264_qsv' | 'libx264' | 'unknown';
  reason?: string;
}

export interface PreflightRunner {
  run(): Promise<PreflightResult>;
}

export interface PreflightStateOptions {
  retryIntervalMs?: number;
  onChange?: (result: PreflightResult) => Promise<void>;
}

export const PREFLIGHT_RETRY_INTERVAL_MS = 5_000;

export class PreflightState {
  private checkedAt = 0;
  private refreshPromise: Promise<PreflightResult> | undefined;
  private readonly retryIntervalMs: number;
  private readonly onChange: ((result: PreflightResult) => Promise<void>) | undefined;

  constructor(
    private readonly service: PreflightRunner,
    private result: PreflightResult,
    options: PreflightStateOptions = {},
  ) {
    this.retryIntervalMs = options.retryIntervalMs ?? PREFLIGHT_RETRY_INTERVAL_MS;
    this.onChange = options.onChange;
  }

  current(): PreflightResult {
    return this.result;
  }

  async refreshIfNeeded(force = false): Promise<PreflightResult> {
    const elapsed = Date.now() - this.checkedAt;
    if (!force && (!this.result.reason || elapsed < this.retryIntervalMs)) return this.result;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.service.run()
      .then(async (result) => {
        const encoderChanged = result.encoder !== this.result.encoder;
        this.result = result;
        this.checkedAt = Date.now();
        if (encoderChanged && this.onChange) await this.onChange(result);
        return result;
      })
      .finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
}

export function isPreflightReady(result: PreflightResult): boolean {
  return result.renderer && result.display && result.encoder !== 'unknown';
}

export class PreflightService {
  constructor(private readonly danserBin: string, private readonly danserDir: string, private readonly paths: Paths) {}

  async run(): Promise<PreflightResult> {
    const renderer = await this.rendererAvailable();
    const display = await this.displayAvailable();
    const qsv = await this.encoderAvailable('h264_qsv');
    if (renderer && display && qsv) return { renderer, display, encoder: 'h264_qsv' };
    const software = await this.encoderAvailable('libx264');
    const reason = !renderer ? 'renderer_unavailable' : !display ? 'display_unavailable' : 'qsv_unavailable';
    return { renderer, display, encoder: software ? 'libx264' : 'unknown', reason };
  }

  async health(base: PreflightResult, queue: number, freeDiskBytes: number, hardMinimum: number): Promise<HealthSnapshot> {
    const storageLow = freeDiskBytes < hardMinimum;
    const degraded = storageLow || Boolean(base.reason) || base.encoder === 'unknown';
    return {
      status: degraded ? 'degraded' : 'ok', renderer: base.renderer, display: base.display,
      encoder: base.encoder, queue, freeDiskBytes,
      reason: storageLow ? 'storage_low' : base.reason,
    };
  }

  private async rendererAvailable(): Promise<boolean> {
    try { await access(this.danserBin, constants.X_OK); return true; } catch { return false; }
  }

  private async displayAvailable(): Promise<boolean> {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    try {
      const { stdout } = await execFileAsync('glxinfo', ['-B'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      return stdout.includes('Accelerated: yes') && stdout.includes('OpenGL');
    } catch { return false; }
  }

  private async encoderAvailable(encoder: 'h264_qsv' | 'libx264'): Promise<boolean> {
    const ffmpegDir = path.join(this.danserDir, 'ffmpeg');
    const ffmpeg = path.join(ffmpegDir, 'ffmpeg');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=1',
      '-frames:v', '1', '-vf', 'format=nv12', '-c:v', encoder, '-f', 'null', '-',
    ];
    try {
      await execFileAsync(ffmpeg, args, { timeout: 20_000, env: libraryEnvironment(ffmpegDir), maxBuffer: 1024 * 1024 });
      return true;
    } catch { return false; }
  }
}

export function libraryEnvironment(ffmpegDir: string): NodeJS.ProcessEnv {
  const current = process.env.LD_LIBRARY_PATH;
  return { ...process.env, LD_LIBRARY_PATH: current ? `${ffmpegDir}:${current}` : ffmpegDir };
}
