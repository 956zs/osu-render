import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractOsz, validateArchiveEntryName } from './archive.js';
import { AppError } from './errors.js';
import { renameWithRetry } from './platform.js';

/** danser's built-in skin. It ships with danser, so it never lives in the skins folder. */
export const DEFAULT_SKIN = 'default';
/** Hidden working folder inside the skins folder; same volume, so the final rename is atomic. */
export const SKIN_STAGING_DIR = '.osu-render-staging';

export interface SkinLimits {
  readonly maxEntries: number;
  readonly maxExtractedBytes: number;
  readonly maxNameLength: number;
}

const SKIN_FILE = /\.(ini|png|jpe?g|wav|ogg|mp3)$/i;
const IGNORED_ROOT_ENTRIES = new Set(['__macosx']);
const RM_RETRY = { force: true, recursive: true, maxRetries: 5, retryDelay: 200 } as const;
let installChain: Promise<unknown> = Promise.resolve();

/** True for a name that can be a folder directly inside the skins folder on every platform. */
export function isValidSkinName(name: unknown, maxLength: number): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLength) return false;
  if (name.startsWith('.') || name.includes('/') || name !== name.trim()) return false;
  try { validateArchiveEntryName(name); return true; } catch { return false; }
}

/** Turns an uploaded file name into a skin folder name; throws SKIN_INVALID when nothing usable is left. */
export function skinNameFromFilename(filename: string, maxLength: number): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  let name = base.replace(/\.osk$/i, '').normalize('NFC')
    .replace(/[\u0000-\u001f\\/:<>"|?*]/g, '_').replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '');
  name = [...name].slice(0, maxLength).join('').replace(/[. ]+$/, '');
  if (name !== '' && !isValidSkinName(name, maxLength)) name = `_${name}`.slice(0, maxLength).replace(/[. ]+$/, '');
  if (!isValidSkinName(name, maxLength)) throw skinInvalid('The skin file name cannot be used as a folder name.');
  if (name.toLowerCase() === DEFAULT_SKIN) throw skinInvalid('The name "default" is reserved for the built-in skin. Rename the .osk file.');
  return name;
}

/** Built-in default first, then every installed skin folder sorted by name. */
export async function listSkins(skinsDir: string, maxNameLength: number): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(skinsDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [DEFAULT_SKIN];
    throw error;
  }
  const skins: string[] = [];
  for (const name of entries) {
    if (!isValidSkinName(name, maxNameLength) || name.toLowerCase() === DEFAULT_SKIN) continue;
    if (await isSkinFolder(path.join(skinsDir, name))) skins.push(name);
  }
  skins.sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }) || left.localeCompare(right));
  return [DEFAULT_SKIN, ...skins];
}

/** Installs .osk files someone copied straight into the skins folder, then lists the skins. */
export async function syncSkins(skinsDir: string, limits: SkinLimits): Promise<string[]> {
  let entries: string[] = [];
  try { entries = await readdir(skinsDir); } catch { /* listSkins reports a missing folder */ }
  for (const file of entries.filter((entry) => /\.osk$/i.test(entry))) {
    const archive = path.join(skinsDir, file);
    try {
      if (!(await stat(archive)).isFile()) continue;
      await installSkin(archive, file, skinsDir, limits);
      await rm(archive, { force: true });
    } catch {
      // A broken archive stays where it is, renamed so it is not retried on every listing.
      await renameWithRetry(archive, `${archive}.invalid`).catch(() => undefined);
    }
  }
  return listSkins(skinsDir, limits.maxNameLength);
}

/** Path for a temporary upload inside the skins folder's staging area. */
export async function skinUploadPath(skinsDir: string): Promise<string> {
  const staging = path.join(skinsDir, SKIN_STAGING_DIR);
  await mkdir(staging, { recursive: true });
  return path.join(staging, `${randomUUID()}.osk`);
}

/**
 * Extracts an .osk into <skinsDir>/<name>, replacing a skin with the same name (any letter case) in one rename.
 * Installs run one at a time so two uploads of the same skin cannot interleave.
 */
export function installSkin(archive: string, filename: string, skinsDir: string, limits: SkinLimits): Promise<string> {
  const name = skinNameFromFilename(filename, limits.maxNameLength);
  const run = installChain.then(() => installSerialized(archive, name, skinsDir, limits));
  installChain = run.catch(() => undefined);
  return run;
}

async function installSerialized(archive: string, name: string, skinsDir: string, limits: SkinLimits): Promise<string> {
  const staging = path.join(skinsDir, SKIN_STAGING_DIR);
  await mkdir(staging, { recursive: true });
  const work = path.join(staging, randomUUID());
  const previous = path.join(staging, `${randomUUID()}-previous`);
  try {
    try {
      await extractOsz(archive, work, { maxEntries: limits.maxEntries, maxExtractedBytes: limits.maxExtractedBytes });
    } catch (error) {
      const message = error instanceof AppError ? error.publicMessage : 'not a valid zip archive';
      if (/extraction limits/.test(message)) throw skinTooLarge('The skin is larger than this server allows once unpacked.');
      throw skinInvalid(`The skin archive is invalid: ${message}.`);
    }
    const root = await skinRoot(work);
    if (!(await isSkinFolder(root))) throw skinInvalid('The archive does not contain any skin files.');
    const existing = (await readdir(skinsDir)).find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (existing) await renameWithRetry(path.join(skinsDir, existing), previous);
    try { await renameWithRetry(root, path.join(skinsDir, name)); } catch (error) {
      if (existing) await renameWithRetry(previous, path.join(skinsDir, existing)).catch(() => undefined);
      throw error;
    }
    return name;
  } finally {
    await Promise.all([rm(work, RM_RETRY), rm(previous, RM_RETRY)]);
  }
}

/** Many .osk files wrap everything in one top-level folder; use that folder as the skin. */
async function skinRoot(extracted: string): Promise<string> {
  if (await isSkinFolder(extracted)) return extracted;
  const entries = (await readdir(extracted, { withFileTypes: true }))
    .filter((entry) => !IGNORED_ROOT_ENTRIES.has(entry.name.toLowerCase()));
  return entries.length === 1 && entries[0].isDirectory() ? path.join(extracted, entries[0].name) : extracted;
}

async function isSkinFolder(directory: string): Promise<boolean> {
  try {
    if (!(await stat(directory)).isDirectory()) return false;
    return (await readdir(directory, { withFileTypes: true }))
      .some((entry) => !entry.isDirectory() && SKIN_FILE.test(entry.name));
  } catch { return false; }
}

export function skinInvalid(message: string): AppError {
  return new AppError('SKIN_INVALID', message, 422);
}

export function skinTooLarge(message: string): AppError {
  return new AppError('SKIN_TOO_LARGE', message, 413);
}
