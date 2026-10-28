import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeDanserSettings } from '../src/danser-config.js';
import type { Paths } from '../src/types.js';

async function withRoot(run: (root: string, paths: Paths) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osu-render-danser-config-'));
  try { await run(root, testPaths(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

test('keeps supplied visual config while enforcing service settings', async () => {
  await withRoot(async (root, paths) => {
    const baseSettingsPath = path.join(root, 'base.json');
    await mkdir(path.dirname(paths.danserSettings), { recursive: true });
    await writeFile(baseSettingsPath, JSON.stringify({
      General: {}, Graphics: { Fullscreen: true }, Skin: { CurrentSkin: 'missing' },
      Playfield: { Scale: 0.91 }, Recording: { MotionBlur: { Enabled: true } },
    }));
    await writeDanserSettings({ paths, encoder: 'h264_qsv', baseSettingsPath, skinsDir: paths.skins });
    const config = JSON.parse(await readFile(paths.danserSettings, 'utf8'));
    assert.equal(config.Playfield.Scale, 0.91);
    assert.equal(config.General.OsuSongsDir, paths.songs);
    assert.equal(config.Graphics.Fullscreen, false);
    assert.equal(config.Recording.Encoder, 'h264_qsv');
    assert.equal(config.Recording.MotionBlur.Enabled, false);
    assert.equal(config.Skin.CurrentSkin, 'default');
  });
});

test('creates settings from scratch when the base settings file is missing', async () => {
  await withRoot(async (root, paths) => {
    await writeDanserSettings({
      paths, encoder: 'h264_nvenc', baseSettingsPath: path.join(root, 'missing', 'default.json'), skinsDir: paths.skins,
    });
    const config = JSON.parse(await readFile(paths.danserSettings, 'utf8'));
    assert.deepEqual(Object.keys(config).sort(), ['General', 'Graphics', 'Recording', 'Skin']);
    assert.equal(config.General.OsuReplaysDir, paths.replays);
    assert.equal(config.General.OsuSkinsDir, paths.skins);
    assert.equal(config.Graphics.Fullscreen, false);
    assert.equal(config.Skin.FallbackSkin, 'default');
    assert.equal(config.Recording.Encoder, 'h264_nvenc');
    assert.equal(config.Recording.OutputDir, paths.danserOutput);
    assert.equal(config.Recording.MotionBlur, undefined);
  });
});

test('replaces malformed sections and skips unknown encoders', async () => {
  await withRoot(async (root, paths) => {
    const baseSettingsPath = path.join(root, 'base.json');
    await writeFile(baseSettingsPath, JSON.stringify({ General: null, Graphics: [1], Recording: 'x' }));
    await writeDanserSettings({ paths, encoder: 'unknown', baseSettingsPath, skinsDir: paths.skins });
    await assert.rejects(access(paths.danserSettings));
    await writeDanserSettings({ paths, encoder: 'libx264', baseSettingsPath, skinsDir: paths.skins });
    const config = JSON.parse(await readFile(paths.danserSettings, 'utf8'));
    assert.equal(config.General.UnpackOszFiles, false);
    assert.deepEqual(Object.keys(config.Graphics), ['Fullscreen']);
    assert.equal(config.Recording.Encoder, 'libx264');
  });
});

test('rejects base settings that are not a JSON object', async () => {
  await withRoot(async (root, paths) => {
    const baseSettingsPath = path.join(root, 'base.json');
    await writeFile(baseSettingsPath, '[]');
    await assert.rejects(writeDanserSettings({ paths, encoder: 'libx264', baseSettingsPath, skinsDir: paths.skins }),
      /must be a JSON object/);
  });
});

function testPaths(root: string): Paths {
  const data = path.join(root, 'data');
  return {
    root, data, db: path.join(data, 'render.db'),
    replays: path.join(data, 'replays'), temp: path.join(data, 'temp'),
    videos: path.join(data, 'videos'), songs: path.join(data, 'songs'),
    skins: path.join(root, 'skins'), danserOutput: path.join(data, 'output'),
    danserSettings: path.join(root, 'settings', 'service.json'),
    logs: path.join(data, 'logs'), diagnostics: path.join(data, 'diagnostics'),
  };
}
