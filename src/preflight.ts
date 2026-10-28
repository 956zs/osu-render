import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { appConfig } from './app-config.js';
import {
  SUPPORTED_ENCODERS, encoderCandidates, encoderKind, isAutoEncoder, isHardwareEncoder,
  type EncoderSetting, type VideoEncoder,
} from './encoders.js';
import { libraryEnvironment, redactText, resolveDanserTools, type DanserTools } from './platform.js';
import type { EncoderProbe, HealthSnapshot, PreflightReason, PreflightResult } from './types.js';

export type { EncoderProbe, PreflightReason, PreflightResult } from './types.js';
export { libraryEnvironment } from './platform.js';

const execFileAsync = promisify(execFile);
const PROBE_ERROR_CHARS = 1500;

export interface CommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type CommandRunner = (file: string, args: string[], options: CommandOptions) => Promise<{ stdout: string; stderr: string }>;

export interface PreflightRunner {
  run(): Promise<PreflightResult>;
}

export interface PreflightStateOptions {
  retryIntervalMs?: number;
  softwareFallbackRetryMs?: number;
  onChange?: (result: PreflightResult) => Promise<void>;
}

export class PreflightState {
  private checkedAt = 0;
  private refreshPromise: Promise<PreflightResult> | undefined;
  private readonly retryIntervalMs: number;
  private readonly softwareFallbackRetryMs: number;
  private readonly onChange: ((result: PreflightResult) => Promise<void>) | undefined;

  constructor(
    private readonly service: PreflightRunner,
    private result: PreflightResult,
    options: PreflightStateOptions = {},
  ) {
    this.retryIntervalMs = options.retryIntervalMs ?? appConfig.preflight.retryIntervalMs;
    this.softwareFallbackRetryMs = options.softwareFallbackRetryMs ?? appConfig.preflight.softwareFallbackRetryMs;
    this.onChange = options.onChange;
  }

  current(): PreflightResult {
    return this.result;
  }

  async refreshIfNeeded(force = false): Promise<PreflightResult> {
    const elapsed = Date.now() - this.checkedAt;
    const interval = this.result.reason === 'hardware_encoder_unavailable'
      ? this.softwareFallbackRetryMs : this.retryIntervalMs;
    if (!force && (!this.result.reason || elapsed < interval)) return this.result;
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

export interface PreflightServiceOptions {
  danserDir: string;
  danserBin?: string;
  renderEncoder?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
}

export class PreflightService {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly renderEncoder: string;
  private readonly runCommand: CommandRunner;
  private readonly candidates: VideoEncoder[];

  constructor(private readonly options: PreflightServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.renderEncoder = options.renderEncoder ?? 'auto';
    this.runCommand = options.runCommand ?? runCommand;
    this.candidates = encoderCandidates(this.renderEncoder, this.platform);
  }

  tools(): Promise<DanserTools> {
    return resolveDanserTools(this.options.danserDir, this.options.danserBin, this.platform);
  }

  async run(): Promise<PreflightResult> {
    const tools = await this.tools();
    const renderer = await this.rendererAvailable(tools);
    const { display, detail } = await this.displayStatus(tools);
    const probes: EncoderProbe[] = [];
    for (const candidate of this.candidates) {
      const probe = await this.probe(tools, candidate);
      probes.push(probe);
      if (probe.ok) break;
    }
    const encoder: EncoderSetting = probes.find((probe) => probe.ok)?.encoder ?? 'unknown';
    const reason = !renderer ? 'renderer_unavailable' : !display ? 'display_unavailable' : this.encoderReason(encoder);
    return {
      renderer, display, encoder, probes,
      ...(reason ? { reason } : {}), ...(detail ? { displayDetail: detail } : {}),
    };
  }

  async probeAll(): Promise<EncoderProbe[]> {
    const tools = await this.tools();
    const probes: EncoderProbe[] = [];
    for (const encoder of SUPPORTED_ENCODERS) probes.push(await this.probe(tools, encoder));
    return probes;
  }

  async health(base: PreflightResult, queue: number, freeDiskBytes: number, hardMinimum: number): Promise<HealthSnapshot> {
    const storageLow = freeDiskBytes < hardMinimum;
    const degraded = storageLow || Boolean(base.reason) || base.encoder === 'unknown';
    return {
      status: degraded ? 'degraded' : 'ok', renderer: base.renderer, display: base.display,
      encoder: base.encoder, encoderKind: encoderKind(base.encoder), platform: this.platform,
      queue, freeDiskBytes,
      reason: storageLow ? 'storage_low' : base.reason,
    };
  }

  private encoderReason(encoder: EncoderSetting): PreflightReason | undefined {
    if (encoder === 'unknown') return 'encoder_unavailable';
    if (!isAutoEncoder(this.renderEncoder)) return encoder === this.candidates[0] ? undefined : 'encoder_unavailable';
    return !isHardwareEncoder(encoder) && this.candidates.some(isHardwareEncoder) ? 'hardware_encoder_unavailable' : undefined;
  }

  private async rendererAvailable(tools: DanserTools): Promise<boolean> {
    try { await access(tools.danserCli, constants.X_OK); return true; } catch { return false; }
  }

  private async displayStatus(tools: DanserTools): Promise<{ display: boolean; detail?: string }> {
    if (this.platform === 'win32') return { display: true, detail: 'win32 interactive session required' };
    if (tools.offscreenCapable) return { display: true, detail: 'offscreen (danser ≥0.12)' };
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) return { display: false, detail: 'DISPLAY and WAYLAND_DISPLAY are not set' };
    try {
      const { stdout } = await this.runCommand('glxinfo', ['-B'], { env: this.env, timeoutMs: 10_000 });
      if (stdout.includes('Accelerated: yes') && stdout.includes('OpenGL')) return { display: true };
      return { display: false, detail: 'OpenGL is not hardware accelerated' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { display: true, detail: 'glxinfo not installed' };
      return { display: false, detail: failureText(error) };
    }
  }

  private async probe(tools: DanserTools, encoder: VideoEncoder): Promise<EncoderProbe> {
    const { width, height, timeoutMs } = appConfig.encoders.selfTest;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=1`,
      '-frames:v', '1', '-an', '-vf', 'format=nv12', '-c:v', encoder, '-f', 'null', '-',
    ];
    const started = performance.now();
    try {
      await this.runCommand(tools.ffmpeg, args, {
        env: libraryEnvironment(tools.libraryDirs, this.env, this.platform), timeoutMs,
      });
      return { encoder, ok: true, durationMs: elapsedSince(started) };
    } catch (error) {
      return { encoder, ok: false, durationMs: elapsedSince(started), error: failureText(error) };
    }
  }
}

async function runCommand(file: string, args: string[], options: CommandOptions): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    env: options.env, timeout: options.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

function failureText(error: unknown): string {
  const failure = error as { stderr?: unknown; killed?: boolean; signal?: string; message?: string };
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  const text = stderr || (failure.killed ? `timed out (${failure.signal ?? 'killed'})` : String(failure.message ?? error));
  return redactText(text).slice(-PROBE_ERROR_CHARS);
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}
