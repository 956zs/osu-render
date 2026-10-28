import type { EncoderKind, EncoderSetting, VideoEncoder } from './encoders.js';

export const JOB_STATUSES = [
  'uploaded', 'resolving', 'downloading', 'queued', 'rendering',
  'finalizing', 'completed', 'failed', 'cancelled',
] as const;

export type JobStatus = typeof JOB_STATUSES[number];

export interface ReplayMetadata {
  playMode: number;
  osuVersion: number;
  beatmapChecksum: string;
  playerName: string;
  replayChecksum: string;
  score: number;
  maxCombo: number;
  mods: string;
  timestamp: number;
  compressedReplayBytes: number;
}

export interface BeatmapMetadata {
  id: number;
  beatmapsetId: number;
  artist?: string;
  title?: string;
  version?: string;
  creator?: string;
  checksum?: string;
  totalLength?: number;
}

export interface RenderRow {
  id: string;
  created_at: number;
  updated_at: number;
  status: JobStatus;
  progress: number;
  replay_path: string;
  video_path: string | null;
  client_key: string;
  player_name: string | null;
  beatmap_checksum: string | null;
  beatmap_id: number | null;
  beatmapset_id: number | null;
  mods: string | null;
  width: number;
  height: number;
  fps: number;
  encoder: string;
  options_json: string;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number | null;
}

export interface BeatmapRow {
  checksum: string;
  beatmap_id: number;
  beatmapset_id: number;
  map_path: string;
  size_bytes: number;
  created_at: number;
  last_used_at: number;
}

export interface Paths {
  root: string;
  data: string;
  db: string;
  replays: string;
  temp: string;
  videos: string;
  songs: string;
  skins: string;
  danserOutput: string;
  danserSettings: string;
  logs: string;
  diagnostics: string;
}

export interface EncoderProbe {
  encoder: VideoEncoder;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export type PreflightReason =
  | 'renderer_unavailable' | 'display_unavailable' | 'hardware_encoder_unavailable' | 'encoder_unavailable';

export interface PreflightResult {
  renderer: boolean;
  display: boolean;
  encoder: EncoderSetting;
  reason?: PreflightReason;
  probes: EncoderProbe[];
  displayDetail?: string;
}

export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  renderer: boolean;
  display: boolean;
  encoder: EncoderSetting;
  encoderKind: EncoderKind;
  platform: NodeJS.Platform;
  queue: number;
  freeDiskBytes: number;
  reason?: string;
}
