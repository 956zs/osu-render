import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_RENDER_OPTIONS } from '../src/render-options.js';

const ROUTES = ['render', 'history', 'skins', 'diagnostics'];
const STEPS = ['uploaded', 'resolving', 'downloading', 'queued', 'rendering', 'completed'];

async function page(): Promise<{ markup: string; script: string; css: string }> {
  const [markup, script, css] = await Promise.all(['index.html', 'app.js', 'app.css']
    .map((file) => readFile(`public/${file}`, 'utf8')));
  return { markup, script, css };
}

function startTag(markup: string, id: string): string {
  const tag = new RegExp(`<[a-z]+\\b[^>]*\\sid="${id}"[^>]*>`).exec(markup);
  assert.ok(tag, `element #${id} is missing`);
  return tag[0];
}

function section(markup: string, id: string): string {
  const body = new RegExp(`<section\\b[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)\\n  </section>`).exec(markup)?.[1];
  assert.ok(body, `section #${id} is missing`);
  return body;
}

test('render option controls map one-to-one to the allowlisted options and their defaults', async () => {
  const { markup } = await page();
  const controls = [...markup.matchAll(/<(input|select)\b([^>]*)\sdata-option="(\w+)"([^>]*)>/g)];
  const keys = controls.map((match) => match[3]);
  assert.deepEqual([...keys].sort(), Object.keys(DEFAULT_RENDER_OPTIONS).sort());
  assert.equal(new Set(keys).size, keys.length, 'each option has exactly one control');
  for (const [tag, tagName, before, key, after] of controls) {
    assert.match(tag, new RegExp(`\\sid="${key}"`), `control for ${key} must have id="${key}"`);
    const expected = DEFAULT_RENDER_OPTIONS[key as keyof typeof DEFAULT_RENDER_OPTIONS];
    const attributes = `${before} ${after}`;
    if (typeof expected === 'boolean') {
      assert.match(attributes, /type="checkbox"/, key);
      assert.equal(/\schecked\b/.test(attributes), expected, `${key} default`);
    } else if (tagName === 'input') {
      assert.match(attributes, new RegExp(`value="${expected}"`), `${key} default`);
    } else {
      const options = new RegExp(`<select\\b[^>]*\\sid="${key}"[^>]*>([\\s\\S]*?)</select>`).exec(markup)?.[1] ?? '';
      assert.match(options, new RegExp(`<option value="${expected}" selected`), `${key} default`);
      if (typeof expected === 'number') assert.match(attributes, /data-type="number"/, key);
    }
  }
  assert.doesNotMatch(markup, /id="encoder"|id="motionBlur"/);
});

test('render options are collected from the data-option controls only', async () => {
  const { script } = await page();
  assert.match(script, /const optionControls = \[\.\.\.document\.querySelectorAll\('\[data-option\]'\)\];/);
  const body = /function renderOptions\(\) \{([\s\S]*?)\n\}/.exec(script)?.[1] ?? '';
  assert.match(body, /for \(const control of optionControls\)/);
  assert.match(body, /options\[key\] = control\.checked/);
  assert.match(script, /form\.append\('options', JSON\.stringify\(renderOptions\(\)\)\)/);
  assert.match(script, /form\.append\('replay', file\)/);
});

test('top bar has the four tabs with icons and hash routes', async () => {
  const { markup, script, css } = await page();
  const nav = /<nav class="tabs" id="tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(markup)?.[1] ?? '';
  const links = [...nav.matchAll(/<a class="tab" href="#\/(\w+)" data-route="(\w+)">\s*<svg class="tab-icon"[^>]*aria-hidden="true"/g)];
  assert.deepEqual(links.map((match) => match[1]), ROUTES);
  for (const match of links) assert.equal(match[1], match[2]);
  for (const route of ROUTES) assert.match(startTag(markup, `view-${route}`), new RegExp(`data-view="${route}"`));
  assert.match(script, /const ROUTES = \['render', 'history', 'skins', 'diagnostics'\];/);
  assert.match(script, /window\.addEventListener\('hashchange'/);
  assert.match(script, /tab\.setAttribute\('aria-current', 'page'\)/);
  const mobile = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(mobile, /\.tabs \{[^}]*position: fixed;[^}]*bottom: 0;/);
  assert.match(mobile, /\.tab-icon \{ display: block; \}/);
});

test('header shows a language switcher and a live renderer status chip', async () => {
  const { markup } = await page();
  const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(markup)?.[1] ?? '';
  assert.match(header, /<select id="language"/);
  const chip = startTag(header, 'rendererStatus');
  assert.match(chip, /aria-live="polite"/);
  assert.match(chip, /role="status"/);
  startTag(header, 'rendererLabel');
  startTag(header, 'rendererReason');
  startTag(header, 'updateBanner');
});

test('render tab has the drop zone, quick settings, drawer and presets', async () => {
  const { markup, script } = await page();
  const render = section(markup, 'view-render');
  assert.match(startTag(render, 'file'), /type="file" accept="\.osr"/);
  for (const id of ['skin', 'resolution', 'backgroundDim', 'skipIntro', 'token']) {
    assert.ok(/<aside class="quick card"[\s\S]*<\/aside>/.exec(render)?.[0].includes(`id="${id}"`), `${id} is in quick settings`);
  }
  assert.match(startTag(render, 'settingsDrawer'), /^<dialog /);
  assert.match(startTag(render, 'settingsSearch'), /type="search"/);
  for (const id of ['moreSettings', 'presetSave', 'presetDelete', 'presetReset', 'drawerClose']) assert.match(startTag(render, id), /^<button type="button"/);
  assert.match(script, /const PRESETS_STORAGE_KEY = 'renderPresets';/);
  assert.match(script, /applyOptions\(DEFAULT_OPTIONS\)/);
  assert.match(script, /drawer\.showModal\(\)/);
});

test('job card shows a stepper, live status, progress with speed and ETA, and an inline preview', async () => {
  const { markup, script } = await page();
  const job = section(markup, 'view-render');
  assert.deepEqual([...job.matchAll(/<li data-step="(\w+)">/g)].map((match) => match[1]), STEPS);
  assert.match(startTag(job, 'jobStatus'), /aria-live="polite"/);
  assert.match(startTag(job, 'progress'), /role="progressbar"/);
  assert.match(startTag(job, 'jobVideo'), /^<video /);
  for (const id of ['download', 'retry', 'cancel', 'another']) assert.match(startTag(job, id), /^<button type="button"/);
  assert.match(script, /data\.speed\.toFixed\(2\)/);
  assert.match(script, /t\('job\.eta', \{ eta: data\.eta \}\)/);
  assert.match(script, /typeof data\?\.previewUrl === 'string'/);
  assert.match(script, /storageSet\(sessionStorage, ACTIVE_JOB_STORAGE_KEY, jobId\)/);
  assert.match(script, /api\(`\/api\/renders\/\$\{jobId\}`, \{ method: 'DELETE' \}\)/);
});

test('history tab lists renders with preview, download and delete actions', async () => {
  const { markup, script } = await page();
  const history = section(markup, 'view-history');
  assert.match(startTag(history, 'historyRefresh'), /^<button type="button"/);
  assert.match(startTag(history, 'historyStatus'), /aria-live="polite"/);
  assert.match(startTag(history, 'historyList'), /^<ul /);
  startTag(history, 'historyEmpty');
  assert.match(script, /api\(`\/api\/renders\?limit=\$\{HISTORY_LIMIT\}`/);
  assert.match(script, /api\(`\/api\/renders\/\$\{id\}\/files`, \{ method: 'DELETE' \}\)/);
  assert.match(script, /window\.confirm\(t\('history\.confirmDelete'\)\)/);
  assert.match(script, /button\(t\('history\.preview'\)/);
  assert.match(startTag(markup, 'previewDialog'), /^<dialog /);
});

test('skins tab lists skins and uploads .osk files', async () => {
  const { markup, script } = await page();
  const skins = section(markup, 'view-skins');
  assert.match(startTag(skins, 'skinFile'), /type="file" accept="\.osk"/);
  assert.match(startTag(skins, 'skinStatus'), /aria-live="polite"/);
  assert.match(startTag(skins, 'skinList'), /^<ul /);
  assert.match(markup, /<option value="default" selected data-i18n="settings\.skin\.default">/);
  assert.match(script, /api\('\/api\/skins', \{ cache: 'no-store' \}\)/);
  assert.match(script, /form\.append\('skin', file\)/);
  assert.match(script, /api\('\/api\/skins', \{ method: 'POST', body: form \}\)/);
  assert.match(script, /t\('skins\.use'\)/);
});

test('diagnostics tab offers report actions and renderer details', async () => {
  const { markup, script } = await page();
  const card = /<section class="card diag-card" id="diagnostics"[^>]*>([\s\S]*?)<\/section>/.exec(markup)?.[1] ?? '';
  for (const id of ['diagDownload', 'diagCopy', 'diagIssue']) assert.match(startTag(card, id), /^<button type="button"/);
  assert.match(startTag(card, 'diagSend'), /^<button type="button" id="diagSend" class="btn btn-primary" hidden data-i18n="diagnostics\.send">/);
  assert.match(startTag(card, 'diagAutoSend'), /\shidden\s/);
  assert.match(startTag(card, 'diagStatus'), /aria-live="polite"/);
  assert.match(startTag(card, 'diagSummary'), /^<textarea\b[^>]*\sreadonly\b/);
  startTag(markup, 'rendererFacts');
  startTag(markup, 'probeList');
  assert.match(script, /api\('\/api\/diagnostics'/);
  assert.match(script, /osu-render-diagnostics-\$\{fileTimestamp\(new Date\(\)\)\}\.json/);
  assert.match(script, /const ISSUE_URL_PREFIX = 'https:\/\/github\.com\/';/);
  assert.match(script, /url\.startsWith\(ISSUE_URL_PREFIX\)/);
  assert.match(script, /window\.open\(url, '_blank', 'noopener'\)/);
  assert.equal((script.match(/window\.open\(/g) ?? []).length, 1);
  assert.match(script, /const reporting = health\.reportWebhook === true;/);
  assert.match(script, /diagSend\.hidden = !reporting; diagAutoSend\.hidden = !reporting; diagPrivacy\.hidden = reporting;/);
  assert.match(script, /api\('\/api\/diagnostics\/send', \{ method: 'POST' \}\)/);
});

test('page is split into same-origin files and never renders text as HTML', async () => {
  const { markup, script, css } = await page();
  assert.match(markup, /<link rel="stylesheet" href="\/app\.css">/);
  assert.match(markup, /<script type="module" src="\/app\.js"><\/script>/);
  assert.doesNotMatch(markup, /<style\b/, 'no inline styles');
  assert.equal((markup.match(/<script\b/g) ?? []).length, 1, 'no inline scripts');
  assert.doesNotMatch(markup, /\sstyle="/, 'no style attributes (CSP style-src self)');
  assert.doesNotMatch(markup, /\son[a-z]+\s*=\s*["']/i, 'no inline event handler attributes');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(markup, /\s(?:src|href)="(?:https?:)?\/\//, 'no external resources');
  assert.doesNotMatch(css, /@import|@font-face|url\(\s*["']?(?:https?:)?\/\//);
  assert.deepEqual(script.match(/https?:\/\/[^'"\s)]*/g), ['https://github.com/']);
  for (const button of markup.match(/<button\b[^>]*>/g) ?? []) assert.match(button, /^<button type="button"/);
  assert.doesNotMatch(markup, /`/);
});

test('motion respects prefers-reduced-motion and focus stays visible', async () => {
  const { css } = await page();
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none !important; transition: none !important;/);
  assert.match(css, /:focus-visible \{ outline: 2px solid/);
  assert.doesNotMatch(css, /:focus-visible \{ outline: none/);
});
