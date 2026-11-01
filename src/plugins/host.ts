import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../app-config.js';
import { danserLeadIn, danserTimeline, parseOsuTiming, songTimeAt, type Timeline } from '../danser-timeline.js';
import { libraryEnvironment, redactText, renameWithRetry, type DanserTools } from '../platform.js';
import { RESOLUTION_DIMENSIONS, type RenderOptions } from '../render-options.js';
import type { RenderRow } from '../types.js';
import { ENABLED_KEY, ManifestError, normalizePluginOptions, type OptionValue, type PluginManifest } from './manifest.js';
import type { PluginRecord } from './loader.js';
import type { AvailableResult, VideoStageContext, VideoStageResult } from './types.js';
import { encodeVideo, overlayFilter, rawVideoInput, runProcess, type ToolRunner } from './video-utils.js';

/** What /api/plugins and the settings UI see of a plugin. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  options: PluginManifest['options'];
  i18n: PluginManifest['i18n'];
  available: boolean;
  /** Why it is unavailable (or broken). */
  reason?: string;
}

export interface StageReport {
  id: string;
  status: 'applied' | 'skipped' | 'failed';
  note: string;
}

export interface PluginHostDependencies {
  /** The .osu file of a beatmap checksum, null when it is not on disk. */
  findBeatmapFile: (checksum: string) => Promise<string | null>;
  /** danser settings file renders use (LeadInHold, SeizureWarning). */
  danserSettingsPath: string;
  /** Per-job work folders go under <tempDir>/plugins. */
  tempDir: string;
  logsDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stageTimeoutMs?: number;
  availableTimeoutMs?: number;
  availabilityTtlMs?: number;
  runTool?: ToolRunner;
}

interface Availability { available: boolean; reason?: string; at: number }

/** Plugins with a loaded module, their availability and the video-stage hook. */
export class PluginHost {
  private readonly availability = new Map<string, Availability>();
  private readonly platform: NodeJS.Platform;
  private readonly runTool: ToolRunner;

  constructor(private readonly records: PluginRecord[], private readonly deps: PluginHostDependencies) {
    this.platform = deps.platform ?? process.platform;
    this.runTool = deps.runTool ?? runProcess;
  }

  /** Runs every plugin's available() check (time-limited; a throwing check means unavailable). */
  async refresh(force = false): Promise<void> {
    const ttl = this.deps.availabilityTtlMs ?? appConfig.plugins.availabilityTtlMs;
    await Promise.all(this.records.map(async (record) => {
      const id = record.manifest?.id;
      if (!id || !record.module) return;
      const cached = this.availability.get(id);
      if (!force && cached && Date.now() - cached.at < ttl) return;
      this.availability.set(id, { ...(await this.check(record)), at: Date.now() });
    }));
  }

  private async check(record: PluginRecord): Promise<{ available: boolean; reason?: string }> {
    const check = record.module?.available;
    if (!check) return { available: true };
    const timeoutMs = this.deps.availableTimeoutMs ?? appConfig.plugins.availableTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result: AvailableResult = await Promise.race([
        Promise.resolve().then(() => check({ apiVersion: 1, platform: this.platform, env: { ...this.env() }, pluginDir: record.dir })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs); }),
      ]);
      if (typeof result === 'boolean') return { available: result };
      if (result && typeof result === 'object' && typeof result.available === 'boolean') {
        return { available: result.available, ...(typeof result.reason === 'string' ? { reason: result.reason.slice(0, 300) } : {}) };
      }
      return { available: false, reason: 'available() returned something unexpected' };
    } catch (error) {
      return { available: false, reason: `available() failed: ${message(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Installed plugins (broken ones included, with the reason), for the API and the UI. */
  list(): PluginInfo[] {
    return this.records.filter((record) => record.manifest).map((record) => {
      const manifest = record.manifest as PluginManifest;
      const state = record.module ? this.availability.get(manifest.id) : undefined;
      const available = record.module !== undefined && state?.available === true;
      const reason = record.error ?? (state ? state.reason : 'not checked yet');
      return {
        id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description,
        options: manifest.options, i18n: manifest.i18n, available,
        ...(!available && reason ? { reason } : {}),
      };
    });
  }

  /** Broken plugin folders (no valid manifest), for logs and the CLI. */
  broken(): Array<{ dir: string; error: string }> {
    return this.records.filter((record) => !record.manifest).map((record) => ({ dir: record.dir, error: record.error ?? 'unknown' }));
  }

  /**
   * Per-job plugin options from a render request, checked against the manifests (defaults filled in). Options
   * of plugins that are not installed are dropped (a saved preset may name a removed plugin).
   */
  normalize(input: Readonly<Record<string, Readonly<Record<string, OptionValue>>>>): Record<string, Record<string, OptionValue>> {
    const out: Record<string, Record<string, OptionValue>> = {};
    for (const [id, options] of Object.entries(input)) {
      const manifest = this.records.find((record) => record.manifest?.id === id)?.manifest;
      if (manifest) out[id] = normalizePluginOptions(manifest, options);
    }
    return out;
  }

  /** Whether any installed plugin is enabled in these options. */
  wants(options: Readonly<RenderOptions>): boolean {
    return Object.values(options.plugins).some((values) => values[ENABLED_KEY] === true);
  }

  /**
   * The post-render video stage: every enabled, available plugin in id order gets the video so far and may
   * return a new file, which replaces it. A plugin that throws, times out or returns something wrong is
   * logged and skipped; the video stays as it was. Cancelling (`signal`) rejects.
   */
  async runVideoStage(job: RenderRow, video: string, options: Readonly<RenderOptions>, tools: DanserTools, signal?: AbortSignal): Promise<StageReport[]> {
    const chosen = this.records.filter((record) => record.manifest && record.module
      && options.plugins[record.manifest.id]?.[ENABLED_KEY] === true);
    if (chosen.length === 0) return [];
    await this.refresh();
    const env = libraryEnvironment(tools.libraryDirs, this.env(), this.platform);
    const shared = await this.jobContext(job, video, options, tools, env, signal);
    const reports: StageReport[] = [];
    for (const record of chosen) {
      if (signal?.aborted) throw new Error('cancelled');
      const manifest = record.manifest as PluginManifest;
      const state = this.availability.get(manifest.id);
      let report: StageReport;
      if (!state?.available) {
        report = { id: manifest.id, status: 'skipped', note: `unavailable: ${state?.reason ?? 'unknown'}` };
      } else {
        report = await this.runOne(record, manifest, job, video, options, tools, env, shared, signal);
      }
      reports.push(report);
      await this.log(job.id, `[osu-render] plugin ${manifest.id} ${report.status}: ${report.note}`);
    }
    return reports;
  }

  private async jobContext(job: RenderRow, video: string, options: Readonly<RenderOptions>, tools: DanserTools,
    env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ osuPath: string | null; timeline: Timeline | null; timelineError?: string; durationMs: number }> {
    const osuPath = job.beatmap_checksum ? await this.deps.findBeatmapFile(job.beatmap_checksum).catch(() => null) : null;
    let timeline: Timeline | null = null;
    let timelineError: string | undefined;
    try {
      if (!osuPath) throw new Error('the beatmap file is not on disk');
      const timing = parseOsuTiming(await readFile(osuPath, 'utf8'));
      const settings: unknown = JSON.parse(await readFile(this.deps.danserSettingsPath, 'utf8'));
      timeline = danserTimeline({ timing, mods: job.mods ?? '', quickstart: options.skipIntro, ...danserLeadIn(settings) });
    } catch (error) {
      timelineError = message(error);
    }
    const probe = await this.runTool(tools.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video,
    ], { env, timeoutMs: 30_000, signal, captureStdout: true });
    const seconds = Number(probe.output.trim().split(/\s+/)[0]);
    return { osuPath, timeline, ...(timelineError ? { timelineError } : {}), durationMs: probe.code === 0 && seconds > 0 ? seconds * 1000 : 0 };
  }

  private async runOne(record: PluginRecord, manifest: PluginManifest, job: RenderRow, video: string,
    options: Readonly<RenderOptions>, tools: DanserTools, env: NodeJS.ProcessEnv,
    shared: { osuPath: string | null; timeline: Timeline | null; timelineError?: string; durationMs: number },
    signal?: AbortSignal): Promise<StageReport> {
    const workDir = path.join(this.deps.tempDir, 'plugins', job.id, manifest.id);
    const timeoutMs = this.deps.stageTimeoutMs ?? appConfig.plugins.stageTimeoutMs;
    const abort = new AbortController();
    const onCancel = (): void => abort.abort();
    signal?.addEventListener('abort', onCancel, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const fail = (note: string): StageReport => ({ id: manifest.id, status: 'failed', note });
    try {
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      const size = RESOLUTION_DIMENSIONS[options.resolution];
      const timeline = shared.timeline;
      const context: VideoStageContext = {
        apiVersion: 1,
        platform: this.platform,
        pluginDir: record.dir,
        workDir,
        job: {
          id: job.id, replayPath: job.replay_path, mods: job.mods ?? '',
          beatmap: {
            checksum: job.beatmap_checksum, osuPath: shared.osuPath, title: job.beatmap_title ?? null,
            artist: job.beatmap_artist ?? null, version: job.beatmap_version ?? null, creator: job.beatmap_creator ?? null,
          },
        },
        video: { path: video, width: size.width, height: size.height, fps: job.fps || 60, durationMs: shared.durationMs },
        timeline,
        ...(shared.timelineError ? { timelineError: shared.timelineError } : {}),
        options: { ...options.plugins[manifest.id] },
        encoder: { name: job.encoder, speedProfile: options.speedProfile },
        tools: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, env: { ...env } },
        signal: abort.signal,
        log: (line) => { void this.log(job.id, `[plugin ${manifest.id}] ${String(line).slice(0, 2000)}`); },
        utils: {
          runProcess: (command, args, extra = {}) => this.runTool(command, args, {
            env, timeoutMs, ...extra, signal: abort.signal,
          }),
          encodeVideo: (request) => encodeVideo({
            video, ffmpeg: tools.ffmpeg, env, encoder: job.encoder, speedProfile: options.speedProfile,
            timeoutMs, signal: abort.signal, runTool: this.runTool,
          }, request),
          overlayFilter: (filter) => overlayFilter({ ...filter, videoHeight: size.height }),
          rawVideoInput,
          songTimeAt: (videoMs) => (timeline ? songTimeAt(timeline, videoMs) : null),
        },
      };
      const result: unknown = await Promise.race([
        Promise.resolve().then(() => (record.module as NonNullable<PluginRecord['module']>).videoStage(context)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(new Error(`took longer than ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
        }),
      ]);
      if (signal?.aborted) throw new Error('cancelled');
      return await this.accept(manifest.id, result, workDir, video);
    } catch (error) {
      if (signal?.aborted) throw new Error('cancelled');
      return fail(message(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
      abort.abort();
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Checks a stage result; an applied output (a file inside the work folder) replaces the video. */
  private async accept(id: string, result: unknown, workDir: string, video: string): Promise<StageReport> {
    const value = result as Partial<VideoStageResult> & { output?: unknown; reason?: unknown; note?: unknown } | null;
    if (value?.status === 'skipped') return { id, status: 'skipped', note: typeof value.reason === 'string' ? value.reason.slice(0, 300) : 'no reason given' };
    if (value?.status !== 'applied' || typeof value.output !== 'string') {
      return { id, status: 'failed', note: 'videoStage() must return { status: "applied", output } or { status: "skipped", reason }' };
    }
    const output = path.resolve(value.output);
    if (!output.startsWith(path.resolve(workDir) + path.sep)) return { id, status: 'failed', note: 'the output must be a file inside ctx.workDir' };
    const info = await stat(output).catch(() => null);
    if (!info?.isFile() || info.size === 0) return { id, status: 'failed', note: 'the output file is missing or empty' };
    await renameWithRetry(output, video);
    return { id, status: 'applied', note: typeof value.note === 'string' ? value.note.slice(0, 300) : 'video replaced' };
  }

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private async log(jobId: string, line: string): Promise<void> {
    await mkdir(this.deps.logsDir, { recursive: true }).catch(() => undefined);
    await appendFile(path.join(this.deps.logsDir, `${jobId}.log`), `${redactText(line)}\n`, { mode: 0o600 }).catch(() => undefined);
  }
}

/** Message of a plugin options problem for the API (400). */
export function isPluginOptionsError(error: unknown): error is ManifestError {
  return error instanceof ManifestError;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
