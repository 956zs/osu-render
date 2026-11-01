import type { Timeline } from '../danser-timeline.js';
import type { OptionValue } from './manifest.js';
import type {
  Corner, EncodeRequest, EncodeResult, ToolOptions, ToolResult,
} from './video-utils.js';

/**
 * Plugin API version 1 (docs/plugins.md). A plugin's entry module exports `videoStage` and optionally
 * `available`; everything a plugin gets from the host is in these types.
 */

export interface AvailableContext {
  apiVersion: 1;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The plugin's folder. */
  pluginDir: string;
}

export type AvailableResult = boolean | { available: boolean; reason?: string };

export interface VideoStageContext {
  apiVersion: 1;
  platform: NodeJS.Platform;
  pluginDir: string;
  /** Empty folder for this job's files; the output goes here. Removed after the stage. */
  workDir: string;
  job: {
    id: string;
    /** The uploaded replay (.osr). */
    replayPath: string;
    /** Mod acronyms, e.g. "HDDT". */
    mods: string;
    beatmap: {
      checksum: string | null;
      /** The .osu file danser rendered; null when it is not on disk. */
      osuPath: string | null;
      title: string | null;
      artist: string | null;
      version: string | null;
      creator: string | null;
    };
  };
  /** The video so far (danser's, or the previous plugin's); never write to it, return a new file. */
  video: { path: string; width: number; height: number; fps: number; durationMs: number };
  /** Song time of each video frame (danser-timeline.ts); null with `timelineError` when it could not be derived. */
  timeline: Timeline | null;
  timelineError?: string;
  /** This plugin's options for the job (`enabled` plus the manifest's options, defaults filled in). */
  options: Record<string, OptionValue>;
  encoder: { name: string; speedProfile: string };
  tools: { ffmpeg: string; ffprobe: string; env: NodeJS.ProcessEnv };
  /** Aborted when the render is cancelled or the stage runs out of time; stop and return quickly. */
  signal: AbortSignal;
  /** Appends a line to the job log. */
  log(line: string): void;
  utils: PluginUtils;
}

export interface PluginUtils {
  /** Runs a process (optionally fed by another process's stdout); killed on abort and on the stage time limit. */
  runProcess(command: string, args: string[], options?: Partial<ToolOptions>): Promise<ToolResult>;
  /** Re-encodes the video through a filter_complex with the job's encoder (libx264 fallback), audio copied. */
  encodeVideo(request: EncodeRequest): Promise<EncodeResult>;
  /** filter_complex laying input `input` over the video in a corner, result labelled [v]. */
  overlayFilter(options: { input: string; corner: Corner; opacity: number; marginPercent?: number }): string;
  /** ffmpeg input arguments for raw RGBA frames on stdin (pipe:0). */
  rawVideoInput(size: { width: number; height: number; fps: number }): string[];
  /** Song time at a video time (ms), from ctx.timeline; null without a timeline. */
  songTimeAt(videoMs: number): number | null;
}

export type VideoStageResult =
  | { status: 'applied'; output: string; note?: string }
  | { status: 'skipped'; reason: string };

export interface PluginModule {
  available?(context: AvailableContext): AvailableResult | Promise<AvailableResult>;
  videoStage(context: VideoStageContext): Promise<VideoStageResult>;
}
