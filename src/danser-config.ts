import { readFile, rename, writeFile } from 'node:fs/promises';
import type { Paths } from './types.js';

interface DanserSettings {
  General: Record<string, unknown>;
  Graphics: Record<string, unknown>;
  Skin: Record<string, unknown>;
  Recording: Record<string, unknown> & { MotionBlur?: Record<string, unknown> };
}

interface DanserSettingsOptions {
  paths: Paths;
  encoder: 'h264_qsv' | 'libx264' | 'unknown';
  baseSettingsPath: string;
  skinsDir: string;
}

export async function writeDanserSettings(options: DanserSettingsOptions): Promise<void> {
  const { paths, encoder, baseSettingsPath, skinsDir } = options;
  if (encoder === 'unknown') return;
  const config = JSON.parse(await readFile(baseSettingsPath, 'utf8')) as DanserSettings;
  config.General.OsuSongsDir = paths.songs;
  config.General.OsuSkinsDir = skinsDir;
  config.General.OsuReplaysDir = paths.replays;
  config.General.DiscordPresenceOn = false;
  config.General.UnpackOszFiles = false;
  config.Graphics.Fullscreen = false;
  config.Skin.CurrentSkin = 'default';
  config.Skin.FallbackSkin = 'default';
  config.Recording.FrameWidth = 1920;
  config.Recording.FrameHeight = 1080;
  config.Recording.FPS = 60;
  config.Recording.Encoder = encoder;
  config.Recording.AudioCodec = 'aac';
  config.Recording.OutputDir = paths.danserOutput;
  config.Recording.Container = 'mp4';
  config.Recording.ShowFFmpegLogs = true;
  if (config.Recording.MotionBlur) config.Recording.MotionBlur.Enabled = false;
  const temporary = `${paths.danserSettings}.part`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.danserSettings);
}
