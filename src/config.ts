import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { encoderCandidates } from './encoders.js';
import type { Paths } from './types.js';

const GIB = 1024 ** 3;
const SERVICE_ROOT = path.resolve(process.env.SERVICE_ROOT ?? process.cwd());
const ENV_FILE = path.join(SERVICE_ROOT, '.env');
const SETTINGS_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

if (existsSync(ENV_FILE)) loadEnvFile(ENV_FILE);

const DATA_DIR = rootPath(env('DATA_DIR') ?? 'data');
const DANSER_DIR = rootPath(env('DANSER_DIR') ?? 'danser');
const DANSER_BIN = env('DANSER_BIN');
const RENDER_ENCODER = (env('RENDER_ENCODER') ?? 'auto').toLowerCase();
const DANSER_SETTINGS_NAME = env('DANSER_SETTINGS_NAME') ?? 'service';

encoderCandidates(RENDER_ENCODER);
if (!SETTINGS_NAME_PATTERN.test(DANSER_SETTINGS_NAME)) {
  throw new Error(`DANSER_SETTINGS_NAME must match ${SETTINGS_NAME_PATTERN} (got "${DANSER_SETTINGS_NAME}").`);
}

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
  dataDir: DATA_DIR,
  danserDir: DANSER_DIR,
  danserBin: DANSER_BIN ? rootPath(DANSER_BIN) : undefined,
  danserBaseSettings: rootPath(env('DANSER_BASE_SETTINGS') ?? path.join(DANSER_DIR, 'settings', 'default.json')),
  danserSkinsDir: rootPath(env('DANSER_SKINS_DIR') ?? path.join(DATA_DIR, 'skins')),
  danserSettingsName: DANSER_SETTINGS_NAME,
  renderEncoder: RENDER_ENCODER,
  osuClientId: process.env.OSU_CLIENT_ID ?? '',
  osuClientSecret: process.env.OSU_CLIENT_SECRET ?? '',
  mirrors: (process.env.BEATMAP_MIRRORS ?? 'https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}')
    .split(',').map((value) => value.trim()).filter(Boolean),
  authToken: process.env.AUTH_TOKEN ?? '',
  /** Secret: never log it. Validate with parseWebhookUrl (webhook-url.ts); invalid values disable reporting. */
  reportWebhookUrl: env('REPORT_WEBHOOK_URL') ?? '',
});

export function getPaths(): Paths {
  const data = settings.dataDir;
  return {
    root: settings.root,
    data,
    db: path.join(data, 'render.db'),
    replays: path.join(data, 'replays'),
    temp: path.join(data, 'temp'),
    videos: path.join(data, 'videos'),
    songs: path.join(data, 'songs'),
    skins: path.join(data, 'skins'),
    danserOutput: path.join(data, 'temp', 'danser-output'),
    danserSettings: path.join(settings.danserDir, 'settings', `${settings.danserSettingsName}.json`),
    logs: path.join(data, 'logs'),
    diagnostics: path.join(data, 'diagnostics'),
  };
}

export async function ensureDirectories(paths: Paths): Promise<void> {
  await Promise.all(Object.values(paths).filter((value) => value !== paths.db && !value.endsWith('.json'))
    .map((directory) => mkdir(directory, { recursive: true })));
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function rootPath(value: string): string {
  return path.resolve(SERVICE_ROOT, value);
}
