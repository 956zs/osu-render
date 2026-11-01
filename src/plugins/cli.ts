import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { settings } from '../config.js';
import { extractOsz } from '../archive.js';
import { readManifest } from './loader.js';
import { MANIFEST_FILE, PLUGIN_ID_PATTERN, supportsPlatform } from './manifest.js';

/**
 * npm run plugin -- list | install <folder|file.zip> [--force] | remove <id>
 *
 * Installs plugins into PLUGINS_DIR (default <DATA_DIR>/plugins). Plugins run with the service's permissions,
 * so only install plugins you trust (docs/plugins.md). Restart the service afterwards.
 */

const ZIP_LIMITS = { maxEntries: 5000, maxExtractedBytes: 512 * 1024 ** 2 };

const USAGE = `usage: npm run plugin -- <command>
  list                          installed plugins
  install <folder|file.zip>     install (or with --force replace) a plugin
  remove <id>                   uninstall a plugin
Plugins dir: PLUGINS_DIR (now ${settings.pluginsDir}). Restart osu-render afterwards.
Plugins run with the service's permissions: only install plugins you trust.`;

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const force = argv.includes('--force');
  const args = argv.filter((arg) => arg !== '--force');
  const dir = settings.pluginsDir;
  switch (args[0]) {
    case 'list': return list(dir, out);
    case 'install': return args[1] && args.length === 2 ? install(dir, args[1], force, out) : usage(out);
    case 'remove': return args[1] && args.length === 2 ? remove(dir, args[1], out) : usage(out);
    default: return usage(out);
  }
}

function usage(out: (line: string) => void): number {
  out(USAGE);
  return 2;
}

export async function list(dir: string, out: (line: string) => void): Promise<number> {
  let names: string[] = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (names.length === 0) out(`no plugins in ${dir}`);
  for (const name of names) {
    try {
      const m = await readManifest(path.join(dir, name));
      const platform = supportsPlatform(m, process.platform) ? '' : `  (not for ${process.platform})`;
      out(`${m.id}  ${m.version}  ${m.name}${platform}`);
    } catch (error) {
      out(`${name}  BROKEN: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 0;
}

/** The folder holding plugin.json: the root itself, or its only subfolder (zips made from a folder). */
async function pluginRoot(root: string): Promise<string> {
  if (await isFile(path.join(root, MANIFEST_FILE))) return root;
  const entries = (await readdir(root, { withFileTypes: true })).filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
  if (entries.length === 1 && entries[0].isDirectory() && await isFile(path.join(root, entries[0].name, MANIFEST_FILE))) {
    return path.join(root, entries[0].name);
  }
  throw new Error(`no ${MANIFEST_FILE} at the top of the plugin (or inside its only folder)`);
}

export async function install(dir: string, source: string, force: boolean, out: (line: string) => void): Promise<number> {
  await mkdir(dir, { recursive: true });
  const staging = path.join(dir, `.staging-${randomUUID()}`);
  try {
    const info = await stat(source);
    if (info.isDirectory()) {
      await cp(source, staging, { recursive: true, errorOnExist: true, filter: (file) => !path.basename(file).startsWith('.git') });
    } else if (source.toLowerCase().endsWith('.zip')) {
      await extractOsz(source, staging, ZIP_LIMITS);
    } else {
      throw new Error('give a plugin folder or a .zip');
    }
    const root = await pluginRoot(staging);
    const manifest = await readManifest(root);
    if (!(await isFile(path.resolve(root, ...manifest.entry.split('/'))))) throw new Error(`the entry ${manifest.entry} is missing`);
    const target = path.join(dir, manifest.id);
    if (await exists(target)) {
      if (!force) throw new Error(`${manifest.id} is already installed; use --force to replace it`);
      await rm(target, { recursive: true, force: true });
    }
    await rename(root, target);
    out(`installed ${manifest.id} ${manifest.version} into ${target}`);
    if (!supportsPlatform(manifest, process.platform)) out(`note: ${manifest.id} does not run on ${process.platform}`);
    out('restart osu-render to load it');
    return 0;
  } catch (error) {
    out(`install failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function remove(dir: string, id: string, out: (line: string) => void): Promise<number> {
  if (!PLUGIN_ID_PATTERN.test(id)) { out(`not a plugin id: ${id}`); return 1; }
  const target = path.join(dir, id);
  if (!(await exists(target))) { out(`${id} is not installed`); return 1; }
  await rm(target, { recursive: true, force: true });
  out(`removed ${id}; restart osu-render to unload it`);
  return 0;
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() === true;
}

async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null)) !== null;
}

