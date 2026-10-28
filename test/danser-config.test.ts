import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeDanserSettings } from '../src/danser-config.js';
import type { Paths } from '../src/types.js';

test('keeps supplied visual config while enforcing service settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osu-render-danser-config-'));
  const baseSettingsPath = path.join(root, 'base.json');
  const paths = testPaths(root);
  await mkdir(path.dirname(paths.danserSettings), { recursive: true });
  await writeFile(baseSettingsPath, JSON.stringify({
    General: {}, Graphics: { Fullscreen: true }, Skin: { CurrentSkin: 'missing' },
    Playfield: { Scale: 0.91 }, Recording: { MotionBlur: { Enabled: true } },
  }));
  try {
    await writeDanserSettings({ paths, encoder: 'h264_qsv', baseSettingsPath, skinsDir: paths.skins });
    const config = JSON.parse(await readFile(paths.danserSettings, 'utf8'));
    assert.equal(config.Playfield.Scale, 0.91);
    assert.equal(config.General.OsuSongsDir, paths.songs);
    assert.equal(config.Graphics.Fullscreen, false);
    assert.equal(config.Recording.Encoder, 'h264_qsv');
    assert.equal(config.Recording.MotionBlur.Enabled, false);
    assert.equal(config.Skin.CurrentSkin, 'default');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function testPaths(root: string): Paths {
  return {
    root, data: path.join(root, 'data'), db: path.join(root, 'data/render.db'),
    replays: path.join(root, 'data/replays'), temp: path.join(root, 'data/temp'),
    videos: path.join(root, 'data/videos'), songs: path.join(root, 'data/songs'),
    skins: path.join(root, 'skins'), danserOutput: path.join(root, 'data/output'),
    danserSettings: path.join(root, 'settings/service.json'),
  };
}
