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
  const body = new RegExp(`<section\\b[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)\\n    </section>`).exec(markup)?.[1];
  assert.ok(body, `section #${id} is missing`);
  return body;
}

test('render option controls map one-to-one to the allowlisted options and their defaults', async () => {
  const { markup } = await page();
  const controls = [...markup.matchAll(/<(input|select)\b([^>]*)\sdata-option="(\w+)"([^>]*)>/g)];
  const keys = controls.map((match) => match[3]);
  assert.deepEqual([...new Set(keys)].sort(), Object.keys(DEFAULT_RENDER_OPTIONS).sort());
  for (const [tag, tagName, before, key, after] of controls) {
    const expected = DEFAULT_RENDER_OPTIONS[key as keyof typeof DEFAULT_RENDER_OPTIONS];
    const attributes = `${before} ${after}`;
    if (/type="radio"/.test(attributes)) {
      // A radio group: one control per value, id "<key>-<value>", the default value checked.
      const value = /value="([^"]+)"/.exec(attributes)?.[1];
      assert.match(tag, new RegExp(`\\sid="${key}-${value}"`), `radio for ${key}=${value}`);
      assert.match(attributes, new RegExp(`name="${key}"`));
      assert.equal(/\schecked\b/.test(attributes), value === expected, `${key} default`);
      continue;
    }
    assert.equal(keys.filter((other) => other === key).length, 1, `${key} has exactly one control`);
    assert.match(tag, new RegExp(`\\sid="${key}"`), `control for ${key} must have id="${key}"`);
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
  assert.match(body, /if \(control\.checked\) options\[key\] = control\.value/);
  assert.match(script, /form\.append\('options', JSON\.stringify\(renderOptions\(\)\)\)/);
  assert.match(script, /form\.append\('replay', file\)/);
});

test('rail and phone tab bar both link the four sections with icons and hash routes', async () => {
  const { markup, script, css } = await page();
  for (const id of ['tabs', 'tabbar']) {
    const nav = new RegExp(`<nav class="[a-z]+" id="${id}"[^>]*>([\\s\\S]*?)</nav>`).exec(markup)?.[1] ?? '';
    const links = [...nav.matchAll(/<a href="#\/(\w+)" data-route="(\w+)"><svg class="nav-icon" aria-hidden="true">/g)];
    assert.deepEqual(links.map((match) => match[1]), ROUTES, id);
    for (const match of links) assert.equal(match[1], match[2]);
  }
  for (const route of ROUTES) assert.match(startTag(markup, `view-${route}`), new RegExp(`data-view="${route}"`));
  assert.match(script, /const ROUTES = \['render', 'history', 'skins', 'diagnostics'\];/);
  assert.match(script, /window\.addEventListener\('hashchange'/);
  assert.match(script, /tab\.setAttribute\('aria-current', 'page'\)/);
  assert.match(css, /\.tabbar \{ display: none; \}/);
  const phone = /@media \(max-width: 760px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(phone, /\.rail \.nav \{ display: none; \}/);
  assert.match(phone, /\.tabbar \{[^}]*position: fixed;[^}]*bottom:/);
});

test('rail footer holds the update card, a live renderer status and the language switch', async () => {
  const { markup } = await page();
  const foot = /<div class="rail-foot">([\s\S]*?)\n    <\/div>\n  <\/aside>/.exec(markup)?.[1] ?? '';
  assert.match(startTag(foot, 'updateBanner'), /role="status"/);
  const status = startTag(foot, 'rendererStatus');
  assert.match(status, /aria-live="polite"/);
  assert.match(status, /role="status"/);
  startTag(foot, 'rendererLabel');
  startTag(foot, 'rendererReason');
  assert.match(startTag(foot, 'language'), /role="group"/);
});

test('update card lists the release note bullets as text under "What\'s new" next to the full notes link', async () => {
  const { markup, script } = await page();
  const banner = /<section class="update" id="updateBanner"[^>]*>([\s\S]*?)<\/section>/.exec(markup)?.[1] ?? '';
  assert.match(startTag(banner, 'updateWhatsNew'), /<details\b[^>]*\shidden/);
  assert.match(banner, /<summary data-i18n="update\.whatsNew">/);
  startTag(banner, 'updateNoteList');
  assert.match(startTag(banner, 'updateNotes'), /data-i18n="update\.notes"/);
  assert.ok(banner.indexOf('updateWhatsNew') < banner.indexOf('id="updateNotes"'), 'bullets come before the full notes link');
  assert.match(script, /item\.textContent = note;/);
  assert.match(script, /updateWhatsNew\.hidden = notes\.length === 0;/);
});

test('render tab has the drop zone, quick settings, drawer and presets', async () => {
  const { markup, script } = await page();
  const render = section(markup, 'view-render');
  assert.match(startTag(render, 'file'), /type="file" accept="\.osr"/);
  const quick = /<section class="card quick"[\s\S]*?\n          <\/section>/.exec(render)?.[0] ?? '';
  for (const id of ['skin', 'resolution-1080p', 'backgroundDim', 'skipIntro', 'token', 'moreSettings']) {
    assert.ok(quick.includes(`id="${id}"`), `${id} is in quick settings`);
  }
  assert.match(startTag(render, 'settingsDrawer'), /^<dialog /);
  assert.match(startTag(render, 'settingsSearch'), /type="search"/);
  for (const id of ['moreSettings', 'presetSave', 'presetReset', 'drawerClose']) assert.match(startTag(render, id), /^<button type="button"/);
  startTag(render, 'presetList');
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
  for (const id of ['download', 'retry', 'cancel', 'another', 'doneAnother']) assert.match(startTag(job, id), /^<button type="button"/);
  for (const id of ['progressSpeed', 'progressEta', 'progressLength']) assert.match(startTag(job, id), /^<dd /);
  assert.match(script, /data\.speed\.toFixed\(2\)/);
  assert.match(script, /progressEta\.textContent = typeof data\?\.eta === 'string'/);
  assert.match(script, /progressFill\.style\.strokeDashoffset/);
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
  assert.match(script, /iconButton\('i-eye', t\('history\.preview'\)/);
  assert.match(startTag(markup, 'previewDialog'), /^<dialog /);
});

test('skins tab lists skins and uploads .osk files', async () => {
  const { markup, script } = await page();
  const skins = section(markup, 'view-skins');
  assert.match(startTag(skins, 'skinFile'), /type="file" accept="\.osk"/);
  assert.match(startTag(skins, 'skinStatus'), /aria-live="polite"/);
  assert.match(startTag(skins, 'skinList'), /^<ul /);
  assert.match(startTag(skins, 'skinDrop'), /^<label /);
  assert.match(markup, /<option value="default" selected data-i18n="settings\.skin\.default">/);
  assert.match(script, /api\('\/api\/skins', \{ cache: 'no-store' \}\)/);
  assert.match(script, /form\.append\('skin', file\)/);
  assert.match(script, /api\('\/api\/skins', \{ method: 'POST', body: form \}\)/);
  assert.match(script, /t\('skins\.use'\)/);
});

test('diagnostics tab offers report actions and renderer details', async () => {
  const { markup, script } = await page();
  const card = /<section class="card diag-card" id="diagnostics"[^>]*>([\s\S]*?)<\/section>/.exec(markup)?.[1] ?? '';
  assert.ok(card, 'diagnostics card is missing');
  for (const id of ['diagDownload', 'diagCopy', 'diagIssue']) assert.match(startTag(card, id), /^<button type="button"/);
  assert.match(startTag(card, 'diagSend'), /^<button type="button" id="diagSend" class="btn ghost" hidden data-i18n="diagnostics\.send">/);
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
  // The SVG namespace is an identifier, not a resource; GitHub is only the issue/notes link prefix.
  assert.deepEqual(script.match(/https?:\/\/[^'"\s)]*/g), ['http://www.w3.org/2000/svg', 'https://github.com/']);
  for (const button of markup.match(/<button\b[^>]*>/g) ?? []) assert.match(button, /^<button type="button"/);
  assert.doesNotMatch(markup, /`/);
});

test('motion respects prefers-reduced-motion and focus stays visible', async () => {
  const { css } = await page();
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none !important; transition: none !important;/);
  assert.match(css, /:focus-visible \{ outline: \d+px solid/);
  assert.doesNotMatch(css, /:focus-visible \{ outline: none/);
});

test('theme values live in :root custom properties', async () => {
  const { css } = await page();
  const root = /^:root \{[\s\S]*?\n\}/m.exec(css);
  assert.ok(root, ':root token block is missing');
  const rules = css.replace(root[0], '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(rules.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|gradient\(|url\(/gi) ?? [], [],
    'colours, gradients and images outside :root must come from tokens');
  assert.doesNotMatch(css, /backdrop-filter|text-shadow|background-clip:\s*text/);
});
