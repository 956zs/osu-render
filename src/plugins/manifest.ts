import path from 'node:path';

/** Plugin API version this host implements (plugin.json "apiVersion"). */
export const PLUGIN_API_VERSION = 1;
export const MANIFEST_FILE = 'plugin.json';
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const OPTION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const PLATFORMS = ['linux', 'win32', 'darwin'] as const;
const MAX_TEXT = 300;
const MAX_OPTIONS = 20;
const MAX_VALUES = 20;
/** Option key the host adds to every plugin: whether it runs for a render. */
export const ENABLED_KEY = 'enabled';

export type OptionValue = boolean | number | string;

export type PluginOption =
  | { key: string; type: 'toggle'; default: boolean }
  | { key: string; type: 'select'; values: string[]; default: string }
  | { key: string; type: 'number'; min: number; max: number; step: number; default: number; unit?: string };

export interface PluginStrings {
  name?: string;
  description?: string;
  /** Option labels and select value labels: options[key].label, options[key].values[value]. */
  options?: Record<string, { label?: string; values?: Record<string, string> }>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description: string;
  /** ESM module relative to the plugin folder. */
  entry: string;
  /** Platforms the plugin runs on; all when absent. */
  platforms?: Array<typeof PLATFORMS[number]>;
  options: PluginOption[];
  i18n: Record<string, PluginStrings>;
}

export class ManifestError extends Error {}

function fail(field: string, problem: string): never {
  throw new ManifestError(`plugin.json: ${field} ${problem}`);
}

function text(value: unknown, field: string, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && value.trim() === '') || value.length > MAX_TEXT) {
    fail(field, `must be a ${required ? 'non-empty ' : ''}string of at most ${MAX_TEXT} characters`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a parsed plugin.json; throws ManifestError naming the bad field. */
export function validateManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) fail('(root)', 'must be a JSON object');
  const id = text(value.id, 'id');
  if (!PLUGIN_ID_PATTERN.test(id)) fail('id', `must match ${PLUGIN_ID_PATTERN}`);
  if (value.apiVersion !== PLUGIN_API_VERSION) {
    fail('apiVersion', `is ${JSON.stringify(value.apiVersion)}; this osu-render supports plugin API ${PLUGIN_API_VERSION}`);
  }
  const entry = text(value.entry ?? 'index.js', 'entry');
  const normalized = path.posix.normalize(entry.replaceAll('\\', '/'));
  if (path.posix.isAbsolute(normalized) || normalized.startsWith('..') || !/\.(m?js)$/.test(normalized)) {
    fail('entry', 'must be a .js or .mjs file inside the plugin folder');
  }
  let platforms: PluginManifest['platforms'];
  if (value.platforms !== undefined) {
    if (!Array.isArray(value.platforms) || value.platforms.length === 0
      || !value.platforms.every((p) => (PLATFORMS as readonly unknown[]).includes(p))) {
      fail('platforms', `must be a non-empty list of ${PLATFORMS.join(', ')}`);
    }
    platforms = value.platforms as PluginManifest['platforms'];
  }
  const rawOptions = value.options ?? [];
  if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) fail('options', `must be a list of at most ${MAX_OPTIONS}`);
  const options = rawOptions.map((option, index) => validateOption(option, `options[${index}]`));
  const keys = new Set<string>();
  for (const option of options) {
    if (keys.has(option.key)) fail('options', `has key "${option.key}" twice`);
    keys.add(option.key);
  }
  const rawStrings = value.i18n ?? {};
  if (!isRecord(rawStrings)) fail('i18n', 'must be an object of languages');
  const i18n: Record<string, PluginStrings> = {};
  for (const [language, strings] of Object.entries(rawStrings)) {
    if (!LANGUAGE_PATTERN.test(language)) fail(`i18n.${language}`, 'is not a language tag');
    i18n[language] = validateStrings(strings, `i18n.${language}`);
  }
  return {
    id,
    name: text(value.name, 'name'),
    version: text(value.version, 'version'),
    apiVersion: PLUGIN_API_VERSION,
    description: text(value.description, 'description', false),
    entry: normalized,
    ...(platforms ? { platforms } : {}),
    options,
    i18n,
  };
}

function validateOption(value: unknown, field: string): PluginOption {
  if (!isRecord(value)) fail(field, 'must be an object');
  const key = text(value.key, `${field}.key`);
  if (!OPTION_KEY_PATTERN.test(key) || key === ENABLED_KEY) fail(`${field}.key`, `must match ${OPTION_KEY_PATTERN} and not be "${ENABLED_KEY}"`);
  switch (value.type) {
    case 'toggle':
      if (typeof value.default !== 'boolean') fail(`${field}.default`, 'must be true or false');
      return { key, type: 'toggle', default: value.default };
    case 'select': {
      const values = value.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES
        || !values.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 64) || new Set(values).size !== values.length) {
        fail(`${field}.values`, `must be 1 to ${MAX_VALUES} different strings`);
      }
      if (!values.includes(value.default)) fail(`${field}.default`, 'must be one of values');
      return { key, type: 'select', values: values as string[], default: value.default as string };
    }
    case 'number': {
      const { min, max, default: initial } = value;
      const step = value.step ?? 1;
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        fail(field, 'needs finite min <= max');
      }
      if (typeof step !== 'number' || !(step > 0)) fail(`${field}.step`, 'must be a positive number');
      if (typeof initial !== 'number' || initial < min || initial > max) fail(`${field}.default`, 'must be within min..max');
      const unit = value.unit === undefined ? undefined : text(value.unit, `${field}.unit`);
      return { key, type: 'number', min, max, step, default: initial, ...(unit ? { unit } : {}) };
    }
    default:
      return fail(`${field}.type`, 'must be toggle, select or number');
  }
}

function validateStrings(value: unknown, field: string): PluginStrings {
  if (!isRecord(value)) fail(field, 'must be an object');
  const out: PluginStrings = {};
  if (value.name !== undefined) out.name = text(value.name, `${field}.name`);
  if (value.description !== undefined) out.description = text(value.description, `${field}.description`);
  if (value.options !== undefined) {
    if (!isRecord(value.options)) fail(`${field}.options`, 'must be an object');
    out.options = {};
    for (const [key, labels] of Object.entries(value.options)) {
      if (!isRecord(labels)) fail(`${field}.options.${key}`, 'must be an object');
      const entry: { label?: string; values?: Record<string, string> } = {};
      if (labels.label !== undefined) entry.label = text(labels.label, `${field}.options.${key}.label`);
      if (labels.values !== undefined) {
        if (!isRecord(labels.values)) fail(`${field}.options.${key}.values`, 'must be an object');
        entry.values = Object.fromEntries(Object.entries(labels.values)
          .map(([v, label]) => [v, text(label, `${field}.options.${key}.values.${v}`)]));
      }
      out.options[key] = entry;
    }
  }
  return out;
}

/** Whether a manifest's platforms include `platform`. */
export function supportsPlatform(manifest: Pick<PluginManifest, 'platforms'>, platform: NodeJS.Platform): boolean {
  return !manifest.platforms || (manifest.platforms as string[]).includes(platform);
}

/**
 * Per-job options of one plugin from the UI: `enabled` plus the manifest's options. Missing values take the
 * defaults; unknown keys and wrong types are errors (the message names the option).
 */
export function normalizePluginOptions(manifest: PluginManifest, input: unknown): Record<string, OptionValue> {
  if (input !== undefined && !isRecord(input)) throw new ManifestError(`options of plugin ${manifest.id} must be an object`);
  const raw = input ?? {};
  const known = new Set([ENABLED_KEY, ...manifest.options.map((o) => o.key)]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ManifestError(`plugin ${manifest.id} has no option ${key}`);
  }
  const enabled = raw[ENABLED_KEY] ?? false;
  if (typeof enabled !== 'boolean') throw new ManifestError(`plugin ${manifest.id}: enabled must be true or false`);
  const out: Record<string, OptionValue> = { [ENABLED_KEY]: enabled };
  for (const option of manifest.options) {
    const value = raw[option.key] ?? option.default;
    const bad = (): never => { throw new ManifestError(`plugin ${manifest.id}: option ${option.key} is invalid`); };
    if (option.type === 'toggle' && typeof value !== 'boolean') bad();
    if (option.type === 'select' && !option.values.includes(value as string)) bad();
    if (option.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < option.min || value > option.max)) bad();
    out[option.key] = value as OptionValue;
  }
  return out;
}
