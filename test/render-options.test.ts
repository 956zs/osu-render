import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RENDER_OPTIONS,
  buildDanserPatch,
  parseRenderOptions,
} from '../src/render-options.js';

test('render options accept only bounded visual settings', () => {
  assert.deepEqual(parseRenderOptions(undefined), DEFAULT_RENDER_OPTIONS);
  const options = parseRenderOptions(JSON.stringify({
    resolution: '720p',
    backgroundDim: 65,
    backgroundBlur: 45,
    cursorSize: 16,
    cursorTrailStyle: 4,
    musicVolume: 70,
    showPpCounter: false,
  }));
  assert.equal(options.backgroundDim, 65);
  assert.equal(options.resolution, '720p');
  assert.equal(options.backgroundBlur, 45);
  assert.equal(options.cursorSize, 16);
  assert.equal(options.cursorTrailStyle, 4);
  assert.equal(options.musicVolume, 70);
  assert.equal(options.showPpCounter, false);
  assert.equal(options.showKeyOverlay, true);
  assert.equal(options.skipIntro, true);
  assert.equal(parseRenderOptions(undefined).resolution, '1080p');
  assert.equal(parseRenderOptions('{"skipIntro":false}').skipIntro, false);
  assert.throws(() => parseRenderOptions('{"resolution":"1440p"}'), /resolution/i);
  assert.throws(() => parseRenderOptions('{"encoder":"libx264"}'), /unsupported render option/i);
  assert.throws(() => parseRenderOptions('{"backgroundDim":101}'), /backgroundDim/i);
  assert.throws(() => parseRenderOptions('{"musicVolume":101}'), /musicVolume/i);
  assert.throws(() => parseRenderOptions('{"cursorTrailStyle":0}'), /cursorTrailStyle/i);
});

test('danser patch contains allowlisted settings but no service controls', () => {
  const patch = buildDanserPatch(parseRenderOptions(JSON.stringify({
    backgroundDim: 40, backgroundBlur: 60, loadVideos: false,
    masterVolume: 80, playfieldScale: 90, cursorRainbow: true,
    showHpBar: false, showSliderScorePoints: false,
    resolution: '720p',
  })));
  assert.deepEqual(patch.Recording, { FrameWidth: 1280, FrameHeight: 720 });
  assert.deepEqual(patch.Playfield.Background, {
    LoadStoryboards: true,
    LoadVideos: false,
    Dim: { Normal: 0.4 },
    Parallax: { Enabled: true },
    Blur: { Enabled: true, Values: { Normal: 0.6 } },
  });
  assert.equal(patch.Playfield.Scale, 0.9);
  assert.equal(patch.Audio.GeneralVolume, 0.8);
  assert.equal(patch.Cursor.Colors.EnableRainbow, true);
  assert.equal(patch.Gameplay.HpBar.Show, false);
  assert.equal(patch.Objects.Sliders.DrawScorePoints, false);
  assert(!('General' in patch));
});
