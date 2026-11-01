import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANIFEST_FILE, supportsPlatform, validateManifest, type PluginManifest } from './manifest.js';
import type { PluginModule } from './types.js';

/** Largest plugin.json read. */
const MAX_MANIFEST_BYTES = 256 * 1024;

/** One folder in the plugins dir: its manifest and module when they loaded, else why not. */
export interface PluginRecord {
  dir: string;
  manifest?: PluginManifest;
  module?: PluginModule;
  /** Why the plugin cannot run here (bad manifest, failed import, other platform). */
  error?: string;
}

/** Reads and validates `<dir>/plugin.json`. */
export async function readManifest(dir: string): Promise<PluginManifest> {
  const file = path.join(dir, MANIFEST_FILE);
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error(`${MANIFEST_FILE} is missing or too large`);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifest(parsed);
}

/**
 * Loads every plugin folder in `pluginsDir` (sorted by name). A plugin that fails anywhere (manifest, import,
 * missing videoStage, duplicate id) is returned with `error` and never runs; the others are unaffected.
 * Plugins for another platform are listed but not imported.
 */
export async function loadPlugins(pluginsDir: string, platform: NodeJS.Platform = process.platform): Promise<PluginRecord[]> {
  let entries: string[];
  try {
    entries = (await readdir(pluginsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: PluginRecord[] = [];
  const seen = new Set<string>();
  for (const name of entries) {
    const dir = path.join(pluginsDir, name);
    const record: PluginRecord = { dir };
    records.push(record);
    try {
      record.manifest = await readManifest(dir);
      if (seen.has(record.manifest.id)) throw new Error(`another plugin already has the id ${record.manifest.id}`);
      seen.add(record.manifest.id);
      if (!supportsPlatform(record.manifest, platform)) {
        record.error = `not available on ${platform} (plugin supports ${record.manifest.platforms?.join(', ')})`;
        continue;
      }
      const entry = path.resolve(dir, ...record.manifest.entry.split('/'));
      if (!entry.startsWith(path.resolve(dir) + path.sep)) throw new Error('entry is outside the plugin folder');
      const loaded = await import(pathToFileURL(entry).href) as Partial<PluginModule>;
      if (typeof loaded.videoStage !== 'function') throw new Error('the entry module does not export videoStage()');
      if (loaded.available !== undefined && typeof loaded.available !== 'function') throw new Error('available must be a function');
      record.module = loaded as PluginModule;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      delete record.module;
    }
  }
  return records;
}
