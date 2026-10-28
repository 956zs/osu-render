import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EncoderSetting } from './encoders.js';
import type { Paths } from './types.js';

type Section = Record<string, unknown>;

interface DanserSettings {
  [key: string]: unknown;
  General: Section;
  Graphics: Section;
  Skin: Section;
  Recording: Section;
}

interface DanserSettingsOptions {
  paths: Paths;
  encoder: EncoderSetting;
  baseSettingsPath: string;
  skinsDir: string;
}

export async function writeDanserSettings(options: DanserSettingsOptions): Promise<void> {
  const { paths, encoder, baseSettingsPath, skinsDir } = options;
  if (encoder === 'unknown') return;
  const base = await readBaseSettings(baseSettingsPath);
  const config: DanserSettings = {
    ...base, General: section(base.General), Graphics: section(base.Graphics),
    Skin: section(base.Skin), Recording: section(base.Recording),
  };
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
  if (isSection(config.Recording.MotionBlur)) config.Recording.MotionBlur.Enabled = false;
  const temporary = `${paths.danserSettings}.part`;
  await mkdir(path.dirname(paths.danserSettings), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.danserSettings);
}

async function readBaseSettings(baseSettingsPath: string): Promise<Section> {
  let text: string;
  try { text = await readFile(baseSettingsPath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isSection(parsed)) throw new Error(`danser base settings must be a JSON object: ${path.basename(baseSettingsPath)}`);
  return parsed;
}

function section(value: unknown): Section {
  return isSection(value) ? { ...value } : {};
}

function isSection(value: unknown): value is Section {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
