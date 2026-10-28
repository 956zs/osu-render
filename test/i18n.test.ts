import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const ERROR_CODES = [
  'INVALID_REPLAY', 'UNSUPPORTED_MODE', 'REPLAY_TOO_LARGE', 'TOO_MANY_REQUESTS', 'QUEUE_FULL',
  'RENDERER_UNAVAILABLE', 'STORAGE_LOW', 'UNAUTHORIZED', 'INVALID_OPTIONS', 'BEATMAP_NOT_FOUND',
  'BEATMAP_DOWNLOAD_FAILED', 'BEATMAP_INVALID_ARCHIVE', 'BEATMAP_CHECKSUM_MISMATCH', 'RENDER_FAILED',
  'RENDER_TIMEOUT', 'INTERNAL_ERROR', 'REPORT_WEBHOOK_DISABLED', 'REPORT_SEND_FAILED', 'SKIN_INVALID', 'SKIN_TOO_LARGE', 'RENDER_EXPIRED', 'RENDER_ACTIVE',
  'UPDATE_NOT_PORTABLE', 'UPDATE_BUSY', 'UPDATE_FAILED',
];
const JOB_STATUSES = [
  'uploaded', 'resolving', 'downloading', 'queued', 'rendering', 'finalizing', 'completed', 'failed', 'cancelled',
];
const PREFLIGHT_REASONS = [
  'renderer_unavailable', 'display_unavailable', 'hardware_encoder_unavailable', 'encoder_unavailable', 'storage_low',
];
const ENCODER_LABELS = ['nvenc', 'amf', 'qsv', 'x264', 'unknown'];
const TRANSLATED_ATTRIBUTES = ['placeholder', 'aria-label'];

interface TranslatableElement { tag: string; attributes: Map<string, string>; text: string | null }

async function localeNames(): Promise<string[]> {
  return (await readdir('public/i18n')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
}

async function loadLocale(language: string): Promise<Map<string, string>> {
  return flatten(JSON.parse(await readFile(`public/i18n/${language}.json`, 'utf8')), '', language, new Map());
}

function flatten(node: unknown, prefix: string, language: string, out: Map<string, string>): Map<string, string> {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${language}: ${prefix || '<root>'} must be an object or string`);
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    assert.doesNotMatch(key, /\./, `${language}: key ${key} must not contain dots (nesting builds the path)`);
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else flatten(value, path, language, out);
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" } as Record<string, string>)[name]);
}

async function pageParts(): Promise<{ markup: string; script: string }> {
  const html = await readFile('public/index.html', 'utf8');
  const scriptStart = html.indexOf('<script type="module">');
  assert.ok(scriptStart > 0, 'index.html must contain the module script');
  return { markup: html.slice(0, scriptStart), script: html.slice(scriptStart) };
}

// Collects every start tag that carries a data-i18n* attribute. Elements with data-i18n must hold
// plain text only, because the runtime replaces their textContent.
function translatableElements(markup: string): TranslatableElement[] {
  const elements: TranslatableElement[] = [];
  for (const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/g)) {
    if (!/\sdata-i18n/.test(match[2])) continue;
    const attributes = new Map<string, string>();
    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      attributes.set(attribute[1], decodeEntities(attribute[2] ?? ''));
    }
    let text: string | null = null;
    if (attributes.has('data-i18n')) {
      const rest = markup.slice((match.index ?? 0) + match[0].length);
      const body = /^([^<]*)<\/([a-z][\w-]*)>/.exec(rest);
      assert.ok(body && body[2] === match[1], `<${match[1]} data-i18n="${attributes.get('data-i18n')}"> must contain only text`);
      text = decodeEntities(body[1]);
    }
    elements.push({ tag: match[1], attributes, text });
  }
  return elements;
}

test('locale files match the configured languages', async () => {
  const names = await localeNames();
  assert.ok(names.includes('en'), 'en.json is the canonical locale');
  try {
    await access('config/defaults.json');
  } catch {
    return;
  }
  const config = JSON.parse(await readFile('config/defaults.json', 'utf8')) as { i18n: { languages: string[]; fallback: string } };
  assert.deepEqual(names, [...config.i18n.languages].sort());
  assert.equal(config.i18n.fallback, 'en');
});

test('every locale has the same keys and placeholders as en', async () => {
  const english = await loadLocale('en');
  for (const language of await localeNames()) {
    const messages = await loadLocale(language);
    const missing = [...english.keys()].filter((key) => !messages.has(key));
    const extra = [...messages.keys()].filter((key) => !english.has(key));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${language}.json key set differs from en.json`);
    for (const [key, text] of messages) {
      assert.ok(text.trim().length > 0, `${language}.json ${key} is empty`);
      assert.deepEqual(placeholders(text), placeholders(english.get(key) ?? ''), `${language}.json ${key} placeholders differ from en`);
    }
  }
});

test('en.json covers statuses, error codes, preflight reasons and encoder labels', async () => {
  const english = await loadLocale('en');
  const required = [
    ...JOB_STATUSES.map((status) => `status.${status}`),
    ...ERROR_CODES.map((code) => `errors.${code}`),
    ...PREFLIGHT_REASONS.map((reason) => `reason.${reason}`),
    ...ENCODER_LABELS.map((label) => `encoder.${label}`),
    'renderer.kind.hardware', 'renderer.kind.software', 'renderer.chip', 'renderer.none',
  ];
  assert.deepEqual(required.filter((key) => !english.has(key)), []);
  assert.match(english.get('status.queued') ?? '', /\{position\}/);
  assert.match(english.get('status.rendering') ?? '', /\{progress\}/);
});

test('markup default text equals en.json for every translatable element', async () => {
  const english = await loadLocale('en');
  const { markup } = await pageParts();
  const elements = translatableElements(markup);
  assert.equal(elements.filter((element) => element.text !== null).length, (markup.match(/\sdata-i18n="/g) ?? []).length);
  assert.ok(elements.length > 60, 'page should be fully translatable');
  for (const element of elements) {
    const key = element.attributes.get('data-i18n');
    if (key !== undefined) {
      assert.ok(english.has(key), `data-i18n="${key}" is missing from en.json`);
      const n = element.attributes.get('data-i18n-n');
      const expected = (english.get(key) ?? '').replace(/\{n\}/g, (match) => n ?? match);
      assert.equal(element.text, expected, `markup text for ${key} drifted from en.json`);
      assert.deepEqual(placeholders(element.text ?? ''), [], `markup text for ${key} has an unfilled placeholder`);
    }
    for (const attribute of TRANSLATED_ATTRIBUTES) {
      const attributeKey = element.attributes.get(`data-i18n-${attribute}`);
      if (attributeKey === undefined) continue;
      assert.ok(english.has(attributeKey), `data-i18n-${attribute}="${attributeKey}" is missing from en.json`);
      assert.equal(element.attributes.get(attribute), english.get(attributeKey), `${attribute} for ${attributeKey} drifted from en.json`);
    }
  }
});

test('script references only existing keys and every key is used', async () => {
  const english = await loadLocale('en');
  const { markup, script } = await pageParts();
  const staticKeys = [
    ...[...script.matchAll(/\b(?:t|showDiagnostics)\('([a-z][\w.]*)'/g)].map((match) => match[1]),
    ...[...script.matchAll(/\bkey: '([a-z][\w.]*)'/g)].map((match) => match[1]),
  ];
  assert.ok(staticKeys.length > 10);
  assert.deepEqual(staticKeys.filter((key) => !english.has(key)), []);
  const dynamicPrefixes = [...script.matchAll(/\bt\(`([a-z][\w.]*)\.\$\{/g)].map((match) => `${match[1]}.`);
  assert.deepEqual([...new Set(dynamicPrefixes)].sort(), ['encoder.', 'errors.', 'reason.', 'renderer.kind.', 'status.']);
  const markupKeys = [...markup.matchAll(/\sdata-i18n(?:-[a-z-]+)?="([a-z][\w.]*)"/g)].map((match) => match[1]);
  const used = new Set([...staticKeys, ...markupKeys]);
  const unused = [...english.keys()].filter((key) => !used.has(key) && !dynamicPrefixes.some((prefix) => key.startsWith(prefix)));
  assert.deepEqual(unused, [], 'en.json has keys nothing on the page uses');
});

test('language switcher lists exactly the shipped locales with autonyms', async () => {
  const { markup } = await pageParts();
  const select = /<select id="language"[^>]*>([\s\S]*?)<\/select>/.exec(markup);
  assert.ok(select, 'language select is missing');
  const options = [...select[1].matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map((option) => option[1]).sort(), await localeNames());
  assert.deepEqual(Object.fromEntries(options.map((option) => [option[1], option[2]])), { en: 'English', 'zh-TW': '繁體中文', es: 'Español' });
});
