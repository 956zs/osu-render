import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { install, list, remove } from '../src/plugins/cli.js';
import { PluginHost } from '../src/plugins/host.js';
import { loadPlugins } from '../src/plugins/loader.js';
import { ManifestError, normalizePluginOptions, validateManifest } from '../src/plugins/manifest.js';
import type { ToolOptions, ToolResult } from '../src/plugins/video-utils.js';
import type { DanserTools } from '../src/platform.js';
import { parseRenderOptions } from '../src/render-options.js';
import type { RenderRow } from '../src/types.js';
import { storeZip } from './skins-zip.js';

const MANIFEST = {
  id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, description: 'Demo plugin', entry: 'index.mjs',
  options: [
    { key: 'corner', type: 'select', values: ['left', 'right'], default: 'right' },
    { key: 'size', type: 'number', min: 10, max: 90, step: 5, default: 40, unit: '%' },
    { key: 'labels', type: 'toggle', default: true },
  ],
  i18n: { en: { name: 'Demo', options: { corner: { label: 'Corner', values: { left: 'Left' } } } }, 'zh-TW': { name: '示範' } },
};

const OSU = 'osu file format v14\n[Difficulty]\nApproachRate:9\n[HitObjects]\n256,192,1500,1,0\n';

async function tempDir(tag: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `osu-render-plugins-${tag}-`));
}

/** Writes a plugin folder: manifest (merged over MANIFEST) and module source. */
async function writePlugin(root: string, folder: string, source: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ ...MANIFEST, id: folder, ...manifest }));
  await writeFile(path.join(dir, 'index.mjs'), source);
  return dir;
}

test('manifest validation names the bad field', () => {
  const ok = validateManifest(MANIFEST);
  assert.equal(ok.id, 'demo');
  assert.equal(ok.entry, 'index.mjs');
  assert.equal(validateManifest({ ...MANIFEST, entry: undefined }).entry, 'index.js');
  const bad = (patch: Record<string, unknown>, field: RegExp): void => {
    assert.throws(() => validateManifest({ ...MANIFEST, ...patch }), (error: unknown) => error instanceof ManifestError && field.test(error.message));
  };
  bad({ apiVersion: 2 }, /apiVersion/);
  bad({ id: 'Bad Id' }, /id/);
  bad({ id: undefined }, /id/);
  bad({ entry: '../escape.js' }, /entry/);
  bad({ entry: '/abs/index.js' }, /entry/);
  bad({ entry: 'index.ts' }, /entry/);
  bad({ platforms: ['amiga'] }, /platforms/);
  bad({ platforms: [] }, /platforms/);
  bad({ options: [{ key: 'enabled', type: 'toggle', default: true }] }, /options\[0\]\.key/);
  bad({ options: [{ key: 'c', type: 'select', values: ['a'], default: 'b' }] }, /options\[0\]\.default/);
  bad({ options: [{ key: 'n', type: 'number', min: 5, max: 1, default: 3 }] }, /options\[0\]/);
  bad({ options: [{ key: 'n', type: 'number', min: 0, max: 10, default: 11 }] }, /options\[0\]\.default/);
  bad({ options: [{ key: 'x', type: 'colour', default: 1 }] }, /options\[0\]\.type/);
  bad({ options: [{ key: 'a', type: 'toggle', default: true }, { key: 'a', type: 'toggle', default: false }] }, /twice/);
  bad({ i18n: { 'not a tag': {} } }, /i18n/);
  bad({ i18n: { en: { name: 5 } } }, /i18n\.en\.name/);
  assert.throws(() => validateManifest(null), /root/);
});

test('per-job options: defaults, enabled flag and value checks', () => {
  const manifest = validateManifest(MANIFEST);
  assert.deepEqual(normalizePluginOptions(manifest, undefined), { enabled: false, corner: 'right', size: 40, labels: true });
  assert.deepEqual(normalizePluginOptions(manifest, { enabled: true, corner: 'left', size: 90 }),
    { enabled: true, corner: 'left', size: 90, labels: true });
  for (const input of [{ corner: 'middle' }, { size: 95 }, { size: 'big' }, { labels: 1 }, { enabled: 'yes' }, { other: 1 }, 'x']) {
    assert.throws(() => normalizePluginOptions(manifest, input), ManifestError, JSON.stringify(input));
  }
});

test('render options carry plugin options with a checked shape', () => {
  assert.deepEqual(parseRenderOptions(undefined).plugins, {});
  const options = parseRenderOptions(JSON.stringify({ plugins: { demo: { enabled: true, size: 40, corner: 'left' } } }));
  assert.deepEqual(options.plugins, { demo: { enabled: true, size: 40, corner: 'left' } });
  for (const plugins of [[], { 'Bad Id': {} }, { demo: [] }, { demo: { 'bad-key': 1 } }, { demo: { x: { nested: 1 } } }, { demo: { x: 'y'.repeat(65) } }]) {
    assert.throws(() => parseRenderOptions(JSON.stringify({ plugins })), { code: 'INVALID_OPTIONS' }, JSON.stringify(plugins));
  }
});

test('loader: good plugins load, broken ones are listed with the reason and never imported further', async () => {
  const root = await tempDir('load');
  try {
    await writePlugin(root, 'good', 'export async function videoStage() { return { status: "skipped", reason: "x" }; }');
    await writePlugin(root, 'throws', 'throw new Error("import boom");');
    await writePlugin(root, 'nostage', 'export const nothing = 1;');
    await writePlugin(root, 'otheros', 'throw new Error("must not be imported");', { platforms: ['darwin'] });
    await writePlugin(root, 'twin', 'export async function videoStage() {}', { id: 'good' });
    await mkdir(path.join(root, 'nojson'));
    await mkdir(path.join(root, 'badjson'));
    await writeFile(path.join(root, 'badjson', 'plugin.json'), '{nope');
    await mkdir(path.join(root, '.staging-x'));
    const records = await loadPlugins(root, 'linux');
    const by = (name: string) => records.find((r) => path.basename(r.dir) === name);
    assert.equal(records.length, 7, 'dot folders are ignored');
    assert(by('good')?.module && !by('good')?.error);
    assert.match(by('throws')?.error ?? '', /import boom/);
    assert.match(by('nostage')?.error ?? '', /videoStage/);
    assert.match(by('otheros')?.error ?? '', /not available on linux/);
    assert.equal(by('otheros')?.module, undefined);
    assert.match(by('twin')?.error ?? '', /already has the id good/);
    assert.match(by('nojson')?.error ?? '', /ENOENT|missing/);
    assert.match(by('badjson')?.error ?? '', /not valid JSON/);
    assert.deepEqual(await loadPlugins(path.join(root, 'missing')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface Fixture { root: string; host: PluginHost; video: string; logs: string; job: RenderRow; tools: DanserTools; temp: string }

async function hostFixture(plugins: Record<string, string>, extra: { stageTimeoutMs?: number; availableTimeoutMs?: number } = {}): Promise<Fixture> {
  const root = await tempDir('host');
  const pluginsDir = path.join(root, 'plugins');
  for (const [id, source] of Object.entries(plugins)) await writePlugin(pluginsDir, id, source);
  for (const sub of ['temp', 'logs']) await mkdir(path.join(root, sub));
  await writeFile(path.join(root, 'map.osu'), OSU);
  await writeFile(path.join(root, 'danser.json'), JSON.stringify({ Playfield: { LeadInHold: 2 } }));
  const video = path.join(root, 'video.mp4');
  await writeFile(video, 'danser');
  const host = new PluginHost(await loadPlugins(pluginsDir, 'linux'), {
    findBeatmapFile: async () => path.join(root, 'map.osu'),
    danserSettingsPath: path.join(root, 'danser.json'),
    tempDir: path.join(root, 'temp'), logsDir: path.join(root, 'logs'), platform: 'linux', env: { HOME: root },
    availabilityTtlMs: 0, ...extra,
    runTool: async (_command: string, _args: string[], _options: ToolOptions): Promise<ToolResult> => ({ code: 0, output: '12.5\n' }),
  });
  await host.refresh(true);
  const job = { id: 'job1', replay_path: '/r/job1.osr', beatmap_checksum: 'a'.repeat(32), mods: 'DT', encoder: 'libx264', fps: 60 } as RenderRow;
  const tools = { ffmpeg: '/d/ffmpeg', ffprobe: '/d/ffprobe', libraryDirs: [] } as unknown as DanserTools;
  return { root, host, video, logs: path.join(root, 'logs', 'job1.log'), job, tools, temp: path.join(root, 'temp') };
}

function enabled(...ids: string[]) {
  return parseRenderOptions(JSON.stringify({ resolution: '720p', plugins: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) }));
}

/** A plugin that writes its context (minus functions) next to the video it returns. */
const APPLY = `import { writeFile } from 'node:fs/promises';
export async function videoStage(ctx) {
  const output = ctx.workDir + '/out.mp4';
  ctx.log('hello from the plugin');
  const { utils, signal, log, ...rest } = ctx;
  await writeFile(output, JSON.stringify({ ...rest, song: utils.songTimeAt(1999) }));
  return { status: 'applied', output, note: 'drew things' };
}`;

test('video stage: an applied output replaces the video; the context has the timeline and options', async () => {
  const f = await hostFixture({ demo: APPLY });
  try {
    // as the HTTP layer stores them: normalized against the manifest
    const options = { ...enabled('demo'), plugins: f.host.normalize(enabled('demo').plugins) };
    const reports = await f.host.runVideoStage(f.job, f.video, options, f.tools);
    assert.deepEqual(reports, [{ id: 'demo', status: 'applied', note: 'drew things' }]);
    const ctx = JSON.parse(await readFile(f.video, 'utf8'));
    assert.equal(ctx.apiVersion, 1);
    assert.equal(ctx.job.replayPath, '/r/job1.osr');
    assert.equal(ctx.job.beatmap.osuPath, path.join(f.root, 'map.osu'));
    assert.deepEqual(ctx.timeline, { startMs: -99, prerollMs: 999, rate: 1.5 });
    assert.equal(ctx.song, -99 + 999 + 1000 * 1.5);
    assert.deepEqual(ctx.video, { path: f.video, width: 1280, height: 720, fps: 60, durationMs: 12500 });
    assert.deepEqual(ctx.options, { enabled: true, corner: 'right', size: 40, labels: true });
    assert.equal(ctx.tools.ffmpeg, '/d/ffmpeg');
    const log = await readFile(f.logs, 'utf8');
    assert.match(log, /\[plugin demo\] hello from the plugin/);
    assert.match(log, /\[osu-render\] plugin demo applied: drew things/);
    assert.deepEqual(await readdir(path.join(f.temp, 'plugins', 'job1')), [], 'work folder removed');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('video stage: failures are isolated and keep the video', async () => {
  const f = await hostFixture({
    athrows: 'export async function videoStage() { throw new Error("plugin boom"); }',
    boutside: 'export async function videoStage() { return { status: "applied", output: "/etc/hostname" }; }',
    cgarbage: 'export async function videoStage() { return 42; }',
    dskip: 'export async function videoStage() { return { status: "skipped", reason: "nothing to do" }; }',
    eempty: 'export async function videoStage(ctx) { return { status: "applied", output: ctx.workDir + "/missing.mp4" }; }',
    foff: 'export async function videoStage() { throw new Error("must not run"); }',
  });
  try {
    const options = enabled('athrows', 'boutside', 'cgarbage', 'dskip', 'eempty');
    const reports = await f.host.runVideoStage(f.job, f.video, options, f.tools);
    assert.deepEqual(reports.map((r) => [r.id, r.status]), [
      ['athrows', 'failed'], ['boutside', 'failed'], ['cgarbage', 'failed'], ['dskip', 'skipped'], ['eempty', 'failed'],
    ]);
    assert.match(reports[0].note, /plugin boom/);
    assert.match(reports[1].note, /inside ctx.workDir/);
    assert.match(reports[2].note, /must return/);
    assert.equal(reports[3].note, 'nothing to do');
    assert.match(reports[4].note, /missing or empty/);
    assert.equal(await readFile(f.video, 'utf8'), 'danser');
    assert.deepEqual(await f.host.runVideoStage(f.job, f.video, enabled(), f.tools), [], 'nothing enabled');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('video stage: plugins run in id order on the previous plugin\'s video', async () => {
  const append = (tag: string) => `import { readFile, writeFile } from 'node:fs/promises';
export async function videoStage(ctx) {
  const output = ctx.workDir + '/out.mp4';
  await writeFile(output, (await readFile(ctx.video.path, 'utf8')) + '+${tag}');
  return { status: 'applied', output };
}`;
  const f = await hostFixture({ bsecond: append('b'), afirst: append('a') });
  try {
    await f.host.runVideoStage(f.job, f.video, enabled('bsecond', 'afirst'), f.tools);
    assert.equal(await readFile(f.video, 'utf8'), 'danser+a+b');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('video stage: time limit and cancel', async () => {
  const waits = `export function videoStage(ctx) {
  return new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('stopped'))));
}`;
  const f = await hostFixture({ slow: waits }, { stageTimeoutMs: 200 });
  try {
    const [report] = await f.host.runVideoStage(f.job, f.video, enabled('slow'), f.tools);
    assert.equal(report.status, 'failed');
    assert.match(report.note, /took longer than/);
    const abort = new AbortController();
    const g = await hostFixture({ slow: waits }, { stageTimeoutMs: 60_000 });
    try {
      const running = assert.rejects(g.host.runVideoStage(g.job, g.video, enabled('slow'), g.tools, abort.signal), /cancelled/);
      setTimeout(() => abort.abort(), 100);
      await running;
      assert.equal(await readFile(g.video, 'utf8'), 'danser');
    } finally {
      await rm(g.root, { recursive: true, force: true });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('availability: checked with a time limit, unavailable plugins are skipped and listed with the reason', async () => {
  const stage = 'export async function videoStage() { throw new Error("must not run"); }';
  const f = await hostFixture({
    always: 'export async function videoStage() { return { status: "skipped", reason: "ok" }; }',
    missing: `export function available() { return { available: false, reason: 'tool not found' }; }\n${stage}`,
    hangs: `export function available() { return new Promise(() => {}); }\n${stage}`,
    broken: `export function available() { throw new Error('check boom'); }\n${stage}`,
    plain: `export async function available(ctx) { return ctx.apiVersion === 1 && ctx.platform === 'linux'; }\nexport async function videoStage() { return { status: "skipped", reason: "ok" }; }`,
  }, { availableTimeoutMs: 150 });
  try {
    const info = Object.fromEntries(f.host.list().map((p) => [p.id, p]));
    assert.equal(info.always.available, true);
    assert.equal(info.plain.available, true);
    assert.deepEqual([info.missing.available, info.missing.reason], [false, 'tool not found']);
    assert.match(info.hangs.reason ?? '', /no answer in 150 ms/);
    assert.match(info.broken.reason ?? '', /check boom/);
    assert.deepEqual(info.always.options.map((o) => o.key), ['corner', 'size', 'labels']);
    assert.equal(info.always.i18n['zh-TW'].name, '示範');
    const [report] = await f.host.runVideoStage(f.job, f.video, enabled('missing'), f.tools);
    assert.deepEqual(report, { id: 'missing', status: 'skipped', note: 'unavailable: tool not found' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('host normalizes job options: unknown plugins dropped, bad values refused', async () => {
  const f = await hostFixture({ demo: APPLY });
  try {
    assert.deepEqual(f.host.normalize({ demo: { enabled: true }, removed: { enabled: true } }),
      { demo: { enabled: true, corner: 'right', size: 40, labels: true } });
    assert.throws(() => f.host.normalize({ demo: { size: 1000 } }), ManifestError);
    assert(f.host.wants(enabled('demo')));
    assert(!f.host.wants(enabled()));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('plugin CLI installs from a folder or zip, refuses to overwrite without --force, lists and removes', async () => {
  const root = await tempDir('cli');
  const lines: string[] = [];
  const out = (line: string): void => { lines.push(line); };
  try {
    const plugins = path.join(root, 'installed');
    const source = await writePlugin(path.join(root, 'src'), 'demo', 'export async function videoStage() {}');
    assert.equal(await install(plugins, source, false, out), 0);
    assert.match(lines.join('\n'), /installed demo 1\.0\.0/);
    assert.equal(await install(plugins, source, false, out), 1);
    assert.match(lines.at(-1) ?? '', /already installed; use --force/);
    assert.equal(await install(plugins, source, true, out), 0);
    // zip with the plugin inside one folder
    const zip = path.join(root, 'zipped.zip');
    await writeFile(zip, storeZip([
      { name: 'zipped/plugin.json', data: JSON.stringify({ ...MANIFEST, id: 'zipped' }) },
      { name: 'zipped/index.mjs', data: 'export async function videoStage() {}' },
    ]));
    assert.equal(await install(plugins, zip, false, out), 0);
    // broken sources leave nothing behind
    const bad = path.join(root, 'bad.zip');
    await writeFile(bad, storeZip([{ name: 'plugin.json', data: '{}' }]));
    assert.equal(await install(plugins, bad, false, out), 1);
    const noEntry = path.join(root, 'noentry.zip');
    await writeFile(noEntry, storeZip([{ name: 'plugin.json', data: JSON.stringify({ ...MANIFEST, id: 'noentry' }) }]));
    assert.equal(await install(plugins, noEntry, false, out), 1);
    assert.match(lines.at(-1) ?? '', /entry index\.mjs is missing/);
    assert.equal(await install(plugins, path.join(root, 'file.txt'), false, out), 1);
    assert.deepEqual((await readdir(plugins)).sort(), ['demo', 'zipped']);
    await mkdir(path.join(plugins, 'junk'));
    lines.length = 0;
    assert.equal(await list(plugins, out), 0);
    assert.deepEqual(lines, ['demo  1.0.0  Demo', 'junk  BROKEN: ' + lines[1].slice('junk  BROKEN: '.length), 'zipped  1.0.0  Demo']);
    assert.equal(await remove(plugins, 'demo', out), 0);
    assert.equal(await remove(plugins, 'demo', out), 1);
    assert.equal(await remove(plugins, '../escape', out), 1);
    assert.deepEqual((await readdir(plugins)).sort(), ['junk', 'zipped']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the example plugin in examples/plugins is valid and loads', async () => {
  const records = await loadPlugins(path.resolve('examples', 'plugins'), 'linux');
  const border = records.find((record) => record.manifest?.id === 'border');
  assert(border?.module, border?.error);
  assert.equal(border.error, undefined);
  assert.deepEqual(border.manifest?.options.map((option) => option.key), ['color', 'thickness']);
});
