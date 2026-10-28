import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAppConfig } from '../src/app-config.js';
import { buildDanserPatch, DEFAULT_RENDER_OPTIONS, parseRenderOptions } from '../src/render-options.js';
import { buildDanserArguments } from '../src/renderer.js';
import {
  DEFAULT_SKIN, SKIN_STAGING_DIR, installSkin, isValidSkinName, listSkins, skinNameFromFilename, syncSkins,
} from '../src/skins.js';
import type { RenderRow } from '../src/types.js';
import { storeZip } from './skins-zip.js';

const LIMITS = { maxEntries: 100, maxExtractedBytes: 1024 * 1024, maxNameLength: 100 };

async function withSkinsDir(run: (skins: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osu-render-skins-'));
  const skins = path.join(root, 'skins');
  await mkdir(skins);
  try { await run(skins, root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeOsk(root: string, file: string, entries: Array<{ name: string; data?: string }>): Promise<string> {
  const target = path.join(root, file);
  await writeFile(target, storeZip(entries));
  return target;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

test('skin names are Windows-safe folder names', () => {
  assert.equal(skinNameFromFilename('Rafis HDDT.osk', 100), 'Rafis HDDT');
  assert.equal(skinNameFromFilename('C:\\Users\\me\\Downloads\\- YUGEN -.OSK', 100), '- YUGEN -');
  assert.equal(skinNameFromFilename('a:b*c?.osk', 100), 'a_b_c_');
  assert.equal(skinNameFromFilename('  spaced   name .. .osk', 100), 'spaced name');
  assert.equal(skinNameFromFilename('...hidden.osk', 100), 'hidden');
  assert.equal(skinNameFromFilename('con.osk', 100), '_con');
  assert.equal(skinNameFromFilename('光.osk', 100), '光');
  assert.equal(skinNameFromFilename(`${'x'.repeat(150)}.osk`, 100).length, 100);
  for (const bad of ['.osk', '   .osk', '....osk', 'default.osk', 'DEFAULT.osk']) {
    assert.throws(() => skinNameFromFilename(bad, 100), (error: { code?: string }) => error.code === 'SKIN_INVALID', bad);
  }
  for (const good of ['Rafis', '- YUGEN -', '光', 'a.b']) assert.ok(isValidSkinName(good, 100), good);
  for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'nul', 'trail.', ' lead', 'x'.repeat(101), 3, null]) {
    assert.ok(!isValidSkinName(bad, 100), String(bad));
  }
});

test('listing returns default first and only real skin folders', async () => {
  await withSkinsDir(async (skins) => {
    assert.deepEqual(await listSkins(path.join(skins, 'missing'), 100), [DEFAULT_SKIN]);
    await mkdir(path.join(skins, 'beta'));
    await writeFile(path.join(skins, 'beta', 'skin.ini'), '[General]');
    await mkdir(path.join(skins, 'Alpha'));
    await writeFile(path.join(skins, 'Alpha', 'cursor.png'), '');
    await mkdir(path.join(skins, 'empty'));
    await mkdir(path.join(skins, 'nested', 'inner'), { recursive: true });
    await writeFile(path.join(skins, 'nested', 'inner', 'skin.ini'), '');
    await mkdir(path.join(skins, 'Default'));
    await writeFile(path.join(skins, 'Default', 'skin.ini'), '');
    await mkdir(path.join(skins, SKIN_STAGING_DIR, 'x'), { recursive: true });
    await writeFile(path.join(skins, SKIN_STAGING_DIR, 'x', 'skin.ini'), '');
    await writeFile(path.join(skins, 'loose.png'), '');
    assert.deepEqual(await listSkins(skins, 100), ['default', 'Alpha', 'beta']);
  });
});

test('installs an .osk, unwrapping a single top-level folder', async () => {
  await withSkinsDir(async (skins, root) => {
    const flat = await writeOsk(root, 'flat.osk', [{ name: 'skin.ini', data: 'flat' }, { name: 'hitcircle.png' }]);
    assert.equal(await installSkin(flat, 'My Skin.osk', skins, LIMITS), 'My Skin');
    assert.equal(await readFile(path.join(skins, 'My Skin', 'skin.ini'), 'utf8'), 'flat');
    const wrapped = await writeOsk(root, 'wrapped.osk', [
      { name: 'Wrapped/' }, { name: 'Wrapped/skin.ini', data: 'wrapped' }, { name: 'Wrapped/sub/x.png' },
      { name: '__MACOSX/' }, { name: '__MACOSX/._skin.ini' },
    ]);
    assert.equal(await installSkin(wrapped, 'Other.osk', skins, LIMITS), 'Other');
    assert.equal(await readFile(path.join(skins, 'Other', 'skin.ini'), 'utf8'), 'wrapped');
    assert.ok(await exists(path.join(skins, 'Other', 'sub', 'x.png')));
    assert.deepEqual(await listSkins(skins, 100), ['default', 'My Skin', 'Other']);
    assert.deepEqual(await readdir(path.join(skins, SKIN_STAGING_DIR)), []);
  });
});

test('reinstalling a skin replaces the old folder, ignoring letter case', async () => {
  await withSkinsDir(async (skins, root) => {
    const first = await writeOsk(root, 'a.osk', [{ name: 'skin.ini', data: 'v1' }, { name: 'old.png' }]);
    await installSkin(first, 'Skin.osk', skins, LIMITS);
    const second = await writeOsk(root, 'b.osk', [{ name: 'skin.ini', data: 'v2' }]);
    const [one, two] = await Promise.all([
      installSkin(second, 'SKIN.osk', skins, LIMITS),
      installSkin(second, 'SKIN.osk', skins, LIMITS),
    ]);
    assert.deepEqual([one, two], ['SKIN', 'SKIN']);
    assert.deepEqual((await readdir(skins)).filter((name) => !name.startsWith('.')), ['SKIN']);
    assert.equal(await readFile(path.join(skins, 'SKIN', 'skin.ini'), 'utf8'), 'v2');
    assert.ok(!(await exists(path.join(skins, 'SKIN', 'old.png'))));
  });
});

test('rejects traversal, non-zip and empty archives without touching existing skins', async () => {
  await withSkinsDir(async (skins, root) => {
    await mkdir(path.join(skins, 'Keep'));
    await writeFile(path.join(skins, 'Keep', 'skin.ini'), 'keep');
    const cases: Array<[string, Buffer]> = [
      ['traversal', storeZip([{ name: '../Keep/skin.ini', data: 'evil' }])],
      ['absolute', storeZip([{ name: '/etc/skin.ini', data: 'evil' }])],
      ['backslash', storeZip([{ name: '..\\Keep\\skin.ini', data: 'evil' }])],
      ['notzip', Buffer.from('not a zip')],
      ['noskin', storeZip([{ name: 'readme.txt', data: 'hi' }])],
    ];
    for (const [label, data] of cases) {
      const file = path.join(root, `${label}.osk`);
      await writeFile(file, data);
      await assert.rejects(installSkin(file, 'Keep.osk', skins, LIMITS),
        (error: { code?: string }) => error.code === 'SKIN_INVALID', label);
    }
    assert.equal(await readFile(path.join(skins, 'Keep', 'skin.ini'), 'utf8'), 'keep');
    assert.ok(!(await exists(path.join(root, 'etc'))));
    assert.deepEqual(await readdir(path.join(skins, SKIN_STAGING_DIR)), []);
  });
});

test('rejects archives over the extraction limits as SKIN_TOO_LARGE', async () => {
  await withSkinsDir(async (skins, root) => {
    const big = await writeOsk(root, 'big.osk', [{ name: 'skin.ini', data: 'x'.repeat(2048) }]);
    await assert.rejects(installSkin(big, 'Big.osk', skins, { ...LIMITS, maxExtractedBytes: 1024 }),
      (error: { code?: string; statusCode?: number }) => error.code === 'SKIN_TOO_LARGE' && error.statusCode === 413);
    const many = await writeOsk(root, 'many.osk', [{ name: 'skin.ini' }, { name: 'a.png' }, { name: 'b.png' }]);
    await assert.rejects(installSkin(many, 'Many.osk', skins, { ...LIMITS, maxEntries: 2 }),
      (error: { code?: string }) => error.code === 'SKIN_TOO_LARGE');
    assert.deepEqual(await listSkins(skins, 100), ['default']);
  });
});

test('syncing installs loose .osk files and parks broken ones', async () => {
  await withSkinsDir(async (skins) => {
    await writeFile(path.join(skins, 'Dropped.osk'), storeZip([{ name: 'skin.ini', data: 'dropped' }]));
    await writeFile(path.join(skins, 'Broken.osk'), 'garbage');
    assert.deepEqual(await syncSkins(skins, LIMITS), ['default', 'Dropped']);
    assert.ok(!(await exists(path.join(skins, 'Dropped.osk'))));
    assert.ok(await exists(path.join(skins, 'Broken.osk.invalid')));
    assert.deepEqual(await syncSkins(skins, LIMITS), ['default', 'Dropped']);
  });
});

test('render options validate the skin name and patch danser skin settings', () => {
  assert.equal(DEFAULT_RENDER_OPTIONS.skin, 'default');
  assert.equal(DEFAULT_RENDER_OPTIONS.useSkinCursor, false);
  const options = parseRenderOptions(JSON.stringify({ skin: 'Rafis HDDT', useSkinCursor: true }));
  assert.equal(options.skin, 'Rafis HDDT');
  assert.equal(options.useSkinCursor, true);
  assert.deepEqual(buildDanserPatch(options).Skin, {
    CurrentSkin: 'Rafis HDDT', UseColorsFromSkin: true, UseBeatmapColors: true, Cursor: { UseSkinCursor: true },
  });
  assert.deepEqual(buildDanserPatch(parseRenderOptions(undefined)).Skin.Cursor, { UseSkinCursor: false });
  assert.equal(buildDanserPatch(parseRenderOptions(undefined)).Skin.CurrentSkin, 'default');
  for (const bad of ['../x', '', '.staging', 'a/b', 'nul', 42, 'x'.repeat(101)]) {
    assert.throws(() => parseRenderOptions(JSON.stringify({ skin: bad })), /skin must be/, String(bad));
  }
  assert.throws(() => parseRenderOptions('{"useSkinCursor":"yes"}'), /useSkinCursor/);
});

test('danser arguments carry the skin in the per-job settings patch', () => {
  const job = {
    id: '00000000-0000-4000-8000-000000000000', replay_path: '/tmp/r.osr',
    options_json: JSON.stringify({ skin: 'Rafis', useSkinCursor: true }),
  } as RenderRow;
  const patch = buildDanserArguments(job).find((argument) => argument.startsWith('-sPatch='));
  assert.ok(patch);
  const skin = JSON.parse(patch.slice('-sPatch='.length)).Skin;
  assert.equal(skin.CurrentSkin, 'Rafis');
  assert.equal(skin.Cursor.UseSkinCursor, true);
});

test('app config requires positive skin limits', () => {
  const base = JSON.parse(readFileSync('config/defaults.json', 'utf8'));
  assert.equal(validateAppConfig(base).skins.maxNameLength, 100);
  assert.throws(() => validateAppConfig({ ...base, skins: { ...base.skins, maxOskBytes: 0 } }), /skins\.maxOskBytes/);
  assert.throws(() => validateAppConfig({ ...base, skins: { ...base.skins, extra: 1 } }), /skins\.extra is not a known setting/);
});
