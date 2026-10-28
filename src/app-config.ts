import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  encoders: {
    autoOrder: Readonly<Record<string, readonly string[]>>;
    selfTest: { width: number; height: number; timeoutMs: number };
  };
  preflight: { retryIntervalMs: number; softwareFallbackRetryMs: number };
  diagnostics: {
    logTailBytes: number;
    reportLogTailBytes: number;
    recentRenders: number;
    issueUrl: string;
    issueTemplate: string;
  };
  i18n: { languages: readonly string[]; fallback: string };
}

type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };
type Json = Record<string, unknown>;

export const APP_ROOT = findAppRoot(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULTS_FILE = path.join(APP_ROOT, 'config', 'defaults.json');
export const LOCAL_CONFIG_FILE = path.join(APP_ROOT, 'config', 'local.json');

export function loadAppConfig(defaultsFile = DEFAULTS_FILE, localFile = LOCAL_CONFIG_FILE): DeepReadonly<AppConfig> {
  const defaults = readJson(defaultsFile);
  const merged = existsSync(localFile) ? deepMerge(defaults, readJson(localFile)) : defaults;
  return deepFreeze(validateAppConfig(merged));
}

export function validateAppConfig(value: unknown): AppConfig {
  const root = object(value, '(root)', ['encoders', 'preflight', 'diagnostics', 'i18n']);
  const encoders = object(root.encoders, 'encoders', ['autoOrder', 'selfTest']);
  const autoOrder = object(encoders.autoOrder, 'encoders.autoOrder');
  if (!('default' in autoOrder)) throw configError('encoders.autoOrder.default', 'is required');
  const selfTest = object(encoders.selfTest, 'encoders.selfTest', ['width', 'height', 'timeoutMs']);
  const preflight = object(root.preflight, 'preflight', ['retryIntervalMs', 'softwareFallbackRetryMs']);
  const diagnostics = object(root.diagnostics, 'diagnostics',
    ['logTailBytes', 'reportLogTailBytes', 'recentRenders', 'issueUrl', 'issueTemplate']);
  const i18n = object(root.i18n, 'i18n', ['languages', 'fallback']);
  const languages = stringArray(i18n.languages, 'i18n.languages', /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
  const fallback = string(i18n.fallback, 'i18n.fallback');
  if (!languages.includes(fallback)) throw configError('i18n.fallback', 'must be one of i18n.languages');
  return {
    encoders: {
      autoOrder: Object.fromEntries(Object.entries(autoOrder)
        .map(([platform, order]) => [platform, stringArray(order, `encoders.autoOrder.${platform}`, /^[a-z0-9_]+$/)])),
      selfTest: {
        width: integer(selfTest.width, 'encoders.selfTest.width', 16),
        height: integer(selfTest.height, 'encoders.selfTest.height', 16),
        timeoutMs: integer(selfTest.timeoutMs, 'encoders.selfTest.timeoutMs', 1),
      },
    },
    preflight: {
      retryIntervalMs: integer(preflight.retryIntervalMs, 'preflight.retryIntervalMs', 1),
      softwareFallbackRetryMs: integer(preflight.softwareFallbackRetryMs, 'preflight.softwareFallbackRetryMs', 1),
    },
    diagnostics: {
      logTailBytes: integer(diagnostics.logTailBytes, 'diagnostics.logTailBytes', 1),
      reportLogTailBytes: integer(diagnostics.reportLogTailBytes, 'diagnostics.reportLogTailBytes', 0),
      recentRenders: integer(diagnostics.recentRenders, 'diagnostics.recentRenders', 0),
      issueUrl: httpsUrl(diagnostics.issueUrl, 'diagnostics.issueUrl'),
      issueTemplate: string(diagnostics.issueTemplate, 'diagnostics.issueTemplate', /^[\w.-]+$/),
    },
    i18n: { languages, fallback },
  };
}

export function deepMerge(base: Json, override: Json): Json {
  const result: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key] as Json, value) : value;
  }
  return result;
}

function findAppRoot(start: string): string {
  for (let directory = start, depth = 0; depth < 4; depth += 1, directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, 'config', 'defaults.json'))) return directory;
  }
  throw new Error(`config/defaults.json was not found above ${start}`);
}

function readJson(file: string): Json {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`Invalid app config file ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Invalid app config file ${path.basename(file)}: expected a JSON object`);
  return parsed;
}

function object(value: unknown, key: string, allowed?: string[]): Json {
  if (!isPlainObject(value)) throw configError(key, 'must be an object');
  const unknown = allowed && Object.keys(value).find((name) => !allowed.includes(name));
  if (unknown) throw configError(key === '(root)' ? unknown : `${key}.${unknown}`, 'is not a known setting');
  return value;
}

function integer(value: unknown, key: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw configError(key, `must be an integer >= ${minimum}`);
  return value as number;
}

function string(value: unknown, key: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) {
    throw configError(key, pattern ? `must be a string matching ${pattern}` : 'must be a non-empty string');
  }
  return value;
}

function stringArray(value: unknown, key: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length === 0) throw configError(key, 'must be a non-empty array');
  return value.map((item, index) => string(item, `${key}[${index}]`, pattern));
}

function httpsUrl(value: unknown, key: string): string {
  const text = string(value, key);
  try { if (new URL(text).protocol === 'https:') return text; } catch { /* reported below */ }
  throw configError(key, 'must be an https URL');
}

function configError(key: string, problem: string): Error {
  return new Error(`Invalid app config: ${key} ${problem}`);
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const appConfig = loadAppConfig();
