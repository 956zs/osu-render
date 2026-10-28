import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
