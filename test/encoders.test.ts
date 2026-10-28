import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUPPORTED_ENCODERS, encoderCandidates, encoderKind, encoderVendor, isHardwareEncoder, isSupportedEncoder,
} from '../src/encoders.js';
import { appConfig } from '../src/app-config.js';

const ORDER = {
  win32: ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'],
  linux: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'],
  default: ['libx264'],
};

test('auto mode follows the per-platform order with a default fallback', () => {
  assert.deepEqual(encoderCandidates('auto', 'linux', ORDER), ORDER.linux);
  assert.deepEqual(encoderCandidates('auto', 'win32', ORDER), ORDER.win32);
  assert.deepEqual(encoderCandidates('auto', 'darwin', ORDER), ['libx264']);
  assert.deepEqual(encoderCandidates(' AUTO ', 'linux', ORDER), ORDER.linux);
  assert.deepEqual(encoderCandidates('auto', 'linux'), appConfig.encoders.autoOrder.linux);
});

test('forced encoder falls back to libx264 without duplicates', () => {
  assert.deepEqual(encoderCandidates('h264_amf', 'win32'), ['h264_amf', 'libx264']);
  assert.deepEqual(encoderCandidates(' H264_QSV ', 'linux'), ['h264_qsv', 'libx264']);
  assert.deepEqual(encoderCandidates('libx264', 'linux'), ['libx264']);
});

test('unknown or empty overrides are rejected with a clear message', () => {
  assert.throws(() => encoderCandidates('h264_vaapi', 'linux'), /RENDER_ENCODER must be "auto" or one of .*h264_vaapi/);
  assert.throws(() => encoderCandidates('', 'linux'), /RENDER_ENCODER/);
});

test('auto order entries are validated against supported encoders', () => {
  assert.throws(() => encoderCandidates('auto', 'linux', { linux: ['av1_magic'], default: ['libx264'] }),
    /encoders\.autoOrder\.linux\[0\] "av1_magic"/);
  assert.deepEqual(encoderCandidates('auto', 'linux', { default: ['libx264', 'libx264'] }), ['libx264']);
});

test('vendor and kind classification covers every encoder', () => {
  const vendors = Object.fromEntries(SUPPORTED_ENCODERS.map((encoder) => [encoder, encoderVendor(encoder)]));
  assert.deepEqual(vendors, {
    h264_nvenc: 'nvidia', hevc_nvenc: 'nvidia', h264_amf: 'amd', hevc_amf: 'amd',
    h264_qsv: 'intel', hevc_qsv: 'intel', libx264: 'cpu',
  });
  assert.equal(encoderVendor('unknown'), 'none');
  assert.equal(isHardwareEncoder('h264_qsv'), true);
  assert.equal(isHardwareEncoder('libx264'), false);
  assert.equal(isHardwareEncoder('unknown'), false);
  assert.equal(encoderKind('hevc_nvenc'), 'hardware');
  assert.equal(encoderKind('libx264'), 'software');
  assert.equal(encoderKind('unknown'), 'none');
  assert.equal(isSupportedEncoder('h264_amf'), true);
  assert.equal(isSupportedEncoder('unknown'), false);
});
