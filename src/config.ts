import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import type { Paths } from './types.js';

const GIB = 1024 ** 3;
const SERVICE_ROOT = path.resolve(process.env.SERVICE_ROOT ?? process.cwd());
const ENV_FILE = path.join(SERVICE_ROOT, '.env');

if (existsSync(ENV_FILE)) loadEnvFile(ENV_FILE);

const DANSER_DIR = process.env.DANSER_DIR ?? path.join(os.homedir(), 'Downloads/danser-0.11.0-linux');

export const limits = Object.freeze({
  maxOsrBytes: 5 * 1024 ** 2,
  maxOszCompressedBytes: 300 * 1024 ** 2,
  maxOszExtractedBytes: 1024 ** 3,
  maxArchiveEntries: 5000,
  softMinFreeBytes: 15 * GIB,
  hardMinFreeBytes: 8 * GIB,
  maxQueue: Number(process.env.MAX_QUEUE ?? 20),
  maxOutstandingPerClient: 3,
  maxRenderMinutes: 30,
  replayRetentionMs: 24 * 60 * 60 * 1000,
  videoRetentionMs: 24 * 60 * 60 * 1000,
});

export const settings = Object.freeze({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3030),
  root: SERVICE_ROOT,
  dataDir: process.env.DATA_DIR ?? path.join(os.homedir(), 'services/osu-render/data'),
  danserDir: DANSER_DIR,
  danserBin: process.env.DANSER_BIN ?? path.join(DANSER_DIR, 'danser-cli'),
  danserBaseSettings: process.env.DANSER_BASE_SETTINGS ?? path.join(DANSER_DIR, 'settings/default.json'),
  danserSkinsDir: process.env.DANSER_SKINS_DIR ?? path.join(os.homedir(), 'danser-render/Skins'),
  osuClientId: process.env.OSU_CLIENT_ID ?? '',
  osuClientSecret: process.env.OSU_CLIENT_SECRET ?? '',
  mirrors: (process.env.BEATMAP_MIRRORS ?? 'https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}')
    .split(',').map((value) => value.trim()).filter(Boolean),
  authToken: process.env.AUTH_TOKEN ?? '',
});

export function getPaths(): Paths {
  const data = path.resolve(settings.dataDir);
  return {
    root: path.resolve(settings.root),
    data,
    db: path.join(data, 'render.db'),
    replays: path.join(data, 'replays'),
    temp: path.join(data, 'temp'),
    videos: path.join(data, 'videos'),
    songs: path.join(data, 'songs'),
    skins: path.join(data, 'skins'),
    danserOutput: path.join(data, 'temp/danser-output'),
    danserSettings: path.join(settings.danserDir, 'settings/service.json'),
  };
}

export async function ensureDirectories(paths: Paths): Promise<void> {
  await Promise.all(Object.values(paths).filter((value) => value !== paths.db && !value.endsWith('.json'))
    .map((directory) => mkdir(directory, { recursive: true })));
}
