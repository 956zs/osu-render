import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS_FILE, appConfig, deepMerge, loadAppConfig, validateAppConfig } from '../src/app-config.js';

async function withConfig(local: unknown, run: (defaults: string, localFile: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-app-config-'));
  const defaults = path.join(directory, 'defaults.json');
  const localFile = path.join(directory, 'local.json');
  await copyFile(DEFAULTS_FILE, defaults);
  if (local !== undefined) await writeFile(localFile, typeof local === 'string' ? local : JSON.stringify(local));
  try { await run(defaults, localFile); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('shipped defaults load, validate and are deeply frozen', async () => {
  await withConfig(undefined, (defaults, localFile) => {
    const config = loadAppConfig(defaults, localFile);
    assert.deepEqual(config.encoders.autoOrder.linux, ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']);
    assert.deepEqual(config.encoders.autoOrder.win32, ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264']);
    assert.deepEqual(config.encoders.selfTest, { width: 240, height: 144, timeoutMs: 20000 });
    assert.deepEqual(config.preflight, { retryIntervalMs: 5000, softwareFallbackRetryMs: 300000 });
    assert.equal(config.diagnostics.logTailBytes, 65536);
    assert.deepEqual(config.i18n, { languages: ['en', 'zh-TW', 'es'], fallback: 'en' });
    assert(Object.isFrozen(config.encoders.selfTest));
    assert(Object.isFrozen(config.i18n.languages));
  });
  assert(Object.isFrozen(appConfig));
});

test('local override is deep-merged and replaces arrays wholesale', async () => {
  await withConfig({ encoders: { selfTest: { width: 320 }, autoOrder: { linux: ['libx264'] } } }, (defaults, localFile) => {
    const config = loadAppConfig(defaults, localFile);
    assert.equal(config.encoders.selfTest.width, 320);
    assert.equal(config.encoders.selfTest.height, 144);
    assert.deepEqual(config.encoders.autoOrder.linux, ['libx264']);
    assert.deepEqual(config.encoders.autoOrder.win32, ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264']);
  });
});

test('empty local override equals the defaults', async () => {
  await withConfig({}, (defaults, localFile) => {
    assert.deepEqual(loadAppConfig(defaults, localFile), loadAppConfig(defaults, `${localFile}.missing`));
  });
});

test('invalid values name the offending key', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ diagnostics: { logTailBytes: 'big' } }, /diagnostics\.logTailBytes must be an integer/],
    [{ diagnostics: { logTailByte: 1 } }, /diagnostics\.logTailByte is not a known setting/],
    [{ encoders: { selfTest: { width: 8 } } }, /encoders\.selfTest\.width must be an integer >= 16/],
    [{ preflight: { retryIntervalMs: 1.5 } }, /preflight\.retryIntervalMs/],
    [{ i18n: { fallback: 'fr' } }, /i18n\.fallback must be one of i18n\.languages/],
    [{ i18n: { languages: ['en', '../x'] } }, /i18n\.languages\[1\]/],
    [{ i18n: { languages: [] } }, /i18n\.languages must be a non-empty array/],
    [{ diagnostics: { issueUrl: 'http://example.com' } }, /diagnostics\.issueUrl must be an https URL/],
    [{ encoders: { autoOrder: { linux: 'libx264' } } }, /encoders\.autoOrder\.linux must be a non-empty array/],
    [{ extra: true }, /extra is not a known setting/],
  ];
  for (const [local, pattern] of cases) {
    await withConfig(local, (defaults, localFile) => {
      assert.throws(() => loadAppConfig(defaults, localFile), pattern);
    });
  }
});

test('malformed local JSON names the file', async () => {
  await withConfig('{ not json', (defaults, localFile) => {
    assert.throws(() => loadAppConfig(defaults, localFile), /local\.json/);
  });
  await withConfig('[]', (defaults, localFile) => {
    assert.throws(() => loadAppConfig(defaults, localFile), /local\.json: expected a JSON object/);
  });
});

test('validation requires a default auto order and a root object', () => {
  assert.throws(() => validateAppConfig(null), /\(root\) must be an object/);
  const withoutDefault = JSON.parse(JSON.stringify(appConfig)) as { encoders: { autoOrder: unknown } };
  withoutDefault.encoders.autoOrder = { linux: ['libx264'] };
  assert.throws(() => validateAppConfig(withoutDefault), /encoders\.autoOrder\.default is required/);
});

test('deepMerge merges nested objects without mutating the base', () => {
  const base = { a: { b: 1, c: [1, 2] }, d: 'x' };
  const merged = deepMerge(base, { a: { c: [3] }, e: null });
  assert.deepEqual(merged, { a: { b: 1, c: [3] }, d: 'x', e: null });
  assert.deepEqual(base, { a: { b: 1, c: [1, 2] }, d: 'x' });
  assert.deepEqual(deepMerge({}, {}), {});
});
