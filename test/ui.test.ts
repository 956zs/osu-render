import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const RENDER_OPTION_IDS = [
  'resolution', 'skipIntro', 'masterVolume', 'musicVolume', 'sampleVolume', 'backgroundDim', 'backgroundBlur',
  'playfieldScale', 'loadVideos', 'loadStoryboards', 'backgroundParallax', 'bloom', 'cursorSize', 'cursorTrailStyle',
  'cursorRainbow', 'cursorGlow', 'cursorRipples', 'cursorSmoke', 'useSkinColors', 'useBeatmapColors', 'showScore',
  'showHpBar', 'showComboCounter', 'showHitErrorMeter', 'showPpCounter', 'showHitCounter', 'showStrainGraph',
  'showKeyOverlay', 'showScoreboard', 'showMods', 'showResultsScreen', 'showApproachCircles', 'showComboNumbers',
  'showSliderEndCircles', 'showSliderFollowCircle', 'showSliderScorePoints',
];

async function page(): Promise<{ html: string; markup: string; script: string }> {
  const html = await readFile('public/index.html', 'utf8');
  const scriptStart = html.indexOf('<script type="module">');
  return { html, markup: html.slice(0, scriptStart), script: html.slice(scriptStart) };
}

function startTag(markup: string, id: string): string {
  const tag = new RegExp(`<[a-z]+\\b[^>]*\\sid="${id}"[^>]*>`).exec(markup);
  assert.ok(tag, `element #${id} is missing`);
  return tag[0];
}

test('render page exposes expanded allowlisted controls', async () => {
  const html = await readFile('public/index.html', 'utf8');
  for (const id of [
    'resolution', 'masterVolume', 'backgroundBlur', 'playfieldScale', 'cursorTrailStyle',
    'cursorRainbow', 'showHpBar', 'showMods', 'showSliderFollowCircle',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="encoder"/);
  assert.doesNotMatch(html, /id="motionBlur"/);
});

test('render options payload keeps every allowlisted key mapped to its control', async () => {
  const { markup, script } = await page();
  const body = /function renderOptions\(\) \{([\s\S]*?)\n\}/.exec(script);
  assert.ok(body, 'renderOptions() is missing');
  const entries = [...body[1].matchAll(/(\w+): (?:checked|number)\('(\w+)'\)/g)].map((match) => [match[1], match[2]]);
  assert.ok(/resolution: document\.querySelector\('#resolution'\)\.value/.test(body[1]));
  assert.deepEqual(['resolution', ...entries.map(([key]) => key)].sort(), [...RENDER_OPTION_IDS].sort());
  for (const [key, id] of entries) assert.equal(key, id);
  for (const id of RENDER_OPTION_IDS) startTag(markup, id);
  assert.match(startTag(markup, 'settingsCount'), new RegExp(`data-i18n-n="${RENDER_OPTION_IDS.length}"`));
});

test('header shows a language switcher and a live renderer status chip', async () => {
  const { markup } = await page();
  const header = /<header class="hero">([\s\S]*?)<\/header>/.exec(markup)?.[1] ?? '';
  assert.match(header, /<select id="language"/);
  const chip = startTag(header, 'rendererStatus');
  assert.match(chip, /aria-live="polite"/);
  assert.match(chip, /role="status"/);
  startTag(header, 'rendererLabel');
  startTag(header, 'rendererReason');
});

test('diagnostics card offers download, copy and GitHub issue actions', async () => {
  const { markup, script } = await page();
  const card = /<section class="panel diag-card" id="diagnostics"[^>]*>([\s\S]*?)<\/section>/.exec(markup)?.[1] ?? '';
  assert.match(card, /<span class="step">03<\/span>/);
  for (const id of ['diagDownload', 'diagCopy', 'diagIssue']) assert.match(startTag(card, id), /^<button type="button"/);
  assert.match(startTag(card, 'diagStatus'), /aria-live="polite"/);
  assert.match(startTag(card, 'diagSummary'), /^<textarea\b[^>]*\sreadonly\b/);
  assert.match(script, /api\('\/api\/diagnostics'/);
  assert.match(script, /osu-render-diagnostics-\$\{fileTimestamp\(new Date\(\)\)\}\.json/);
  assert.match(script, /const ISSUE_URL_PREFIX = 'https:\/\/github\.com\/';/);
  assert.match(script, /url\.startsWith\(ISSUE_URL_PREFIX\)/);
  assert.match(script, /window\.open\(url, '_blank', 'noopener'\)/);
  assert.equal((script.match(/window\.open\(/g) ?? []).length, 1);
});

test('send to developer button and auto-send note appear only when the webhook is enabled', async () => {
  const { markup, script } = await page();
  const card = /<section class="panel diag-card" id="diagnostics"[^>]*>([\s\S]*?)<\/section>/.exec(markup)?.[1] ?? '';
  assert.match(startTag(card, 'diagSend'), /^<button type="button" id="diagSend" hidden data-i18n="diagnostics\.send">/);
  assert.match(startTag(card, 'diagAutoSend'), /\shidden\s/);
  assert.doesNotMatch(startTag(card, 'diagPrivacy'), /\shidden/);
  assert.match(script, /const reporting = health\.reportWebhook === true;/);
  assert.match(script, /diagSend\.hidden = !reporting; diagAutoSend\.hidden = !reporting; diagPrivacy\.hidden = reporting;/);
  assert.match(script, /api\('\/api\/diagnostics\/send', \{ method: 'POST' \}\)/);
  assert.match(script, /showDiagnostics\('diagnostics\.sent', 'ok'\)/);
  assert.match(script, /\[diagSend, diagDownload, diagCopy, diagIssue\]/);
});

test('page stays self-contained and never renders text as HTML', async () => {
  const { html, markup, script } = await page();
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, 'no inline event handler attributes');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(html, /\s(?:src|href)="(?:https?:)?\/\//, 'no external resources');
  assert.doesNotMatch(html, /@import|url\(\s*["']?(?:https?:)?\/\//);
  assert.deepEqual(html.match(/https?:\/\/[^'"\s)]*/g), ['https://github.com/']);
  for (const button of markup.match(/<button\b[^>]*>/g) ?? []) assert.match(button, /^<button type="button"/);
});

test('copy has no stray backticks and the settings note is encoder-neutral', async () => {
  const { markup } = await page();
  assert.doesNotMatch(markup, /`/);
  assert.doesNotMatch(markup, /QSV/);
  assert.match(markup, /<p class="settings-foot" data-i18n="settings\.footer">/);
});
