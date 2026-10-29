import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RENDER_OPTIONS,
  buildDanserPatch,
  buildEncoderPatch,
  parseRenderOptions,
} from '../src/render-options.js';
import { SUPPORTED_ENCODERS } from '../src/encoders.js';

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
  })), 'unknown');
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

test('speed profile defaults to balanced and rejects unknown profiles', () => {
  assert.equal(DEFAULT_RENDER_OPTIONS.speedProfile, 'balanced');
  assert.equal(parseRenderOptions('{"speedProfile":"fast"}').speedProfile, 'fast');
  assert.equal(parseRenderOptions('{"speedProfile":"quality"}').speedProfile, 'quality');
  for (const bad of ['"turbo"', '""', '"Fast"', '1', 'true', '["fast"]']) {
    assert.throws(() => parseRenderOptions(`{"speedProfile":${bad}}`), (error: Error & { code?: string }) =>
      error.code === 'INVALID_OPTIONS' && /speedProfile/.test(error.message), bad);
  }
});

test('speed profile patches the job encoder with the configured preset and quality', () => {
  const expected: Record<string, Record<string, [string, number, string]>> = {
    h264_nvenc: { fast: ['p1', 24, 'CQ'], balanced: ['p4', 22, 'CQ'], quality: ['p7', 20, 'CQ'] },
    hevc_nvenc: { fast: ['p1', 26, 'CQ'], balanced: ['p4', 24, 'CQ'], quality: ['p7', 22, 'CQ'] },
    h264_amf: { fast: ['speed', 22, 'CQ'], balanced: ['balanced', 20, 'CQ'], quality: ['quality', 18, 'CQ'] },
    hevc_amf: { fast: ['speed', 24, 'CQ'], balanced: ['balanced', 22, 'CQ'], quality: ['quality', 20, 'CQ'] },
    h264_qsv: { fast: ['veryfast', 23, 'Quality'], balanced: ['faster', 20, 'Quality'], quality: ['slow', 15, 'Quality'] },
    hevc_qsv: { fast: ['veryfast', 25, 'Quality'], balanced: ['faster', 22, 'Quality'], quality: ['slow', 17, 'Quality'] },
    libx264: { fast: ['veryfast', 20, 'CRF'], balanced: ['faster', 18, 'CRF'], quality: ['medium', 16, 'CRF'] },
  };
  const rateControl: Record<string, string> = {
    h264_nvenc: 'cq', hevc_nvenc: 'cq', h264_amf: 'cqp', hevc_amf: 'cqp', h264_qsv: 'icq', hevc_qsv: 'icq', libx264: 'crf',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...SUPPORTED_ENCODERS].sort());
  for (const encoder of SUPPORTED_ENCODERS) {
    for (const profile of ['fast', 'balanced', 'quality'] as const) {
      const [preset, quality, key] = expected[encoder][profile];
      const block = { RateControl: rateControl[encoder], [key]: quality, Preset: preset };
      assert.deepEqual(buildEncoderPatch(encoder, profile), block, `${encoder} ${profile}`);
      const patch = buildDanserPatch(parseRenderOptions(JSON.stringify({ speedProfile: profile, resolution: '720p' })), encoder);
      assert.deepEqual(patch.Recording, { FrameWidth: 1280, FrameHeight: 720, [encoder]: block }, `${encoder} ${profile} patch`);
    }
  }
});

test('fast profile forces bloom off; other profiles keep the bloom option', () => {
  const bloom = (json: object): boolean => buildDanserPatch(parseRenderOptions(JSON.stringify(json)), 'libx264').Playfield.Bloom.Enabled;
  assert.equal(bloom({ speedProfile: 'fast', bloom: true }), false);
  assert.equal(bloom({ speedProfile: 'fast', bloom: false }), false);
  assert.equal(bloom({ speedProfile: 'balanced', bloom: true }), true);
  assert.equal(bloom({ speedProfile: 'quality', bloom: true }), true);
  assert.equal(bloom({ speedProfile: 'quality', bloom: false }), false);
  assert.equal(parseRenderOptions('{"speedProfile":"fast","bloom":true}').bloom, true, 'the stored option is unchanged');
});

test('unknown job encoders get no encoder block', () => {
  const patch = buildDanserPatch(parseRenderOptions('{"speedProfile":"fast"}'), 'unknown');
  assert.deepEqual(patch.Recording, { FrameWidth: 1920, FrameHeight: 1080 });
});
