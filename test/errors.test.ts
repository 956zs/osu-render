import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { AppError, internalErrorDetail } from '../src/errors.js';

test('expected app errors have no internal detail', () => {
  assert.equal(internalErrorDetail(new AppError('RENDER_FAILED', 'danser failed', 500)), null);
  assert.equal(internalErrorDetail(new AppError('BEATMAP_NOT_FOUND', 'missing', 404)), null);
});

test('internal detail is the error name and message, without stack or absolute paths', () => {
  const error = new Error("ENOENT: no such file or directory, open '/srv/osu-render/data/songs/123 Artist/map.osu'");
  const detail = internalErrorDetail(error);
  assert.equal(detail, "Error: ENOENT: no such file or directory, open '…/map.osu'");
  assert.doesNotMatch(detail ?? '', /at |\/srv/);
  assert.equal(internalErrorDetail(new TypeError('Cannot read properties of undefined')), 'TypeError: Cannot read properties of undefined');
  assert.equal(internalErrorDetail(new AppError('INTERNAL_ERROR', 'Render job was not found.', 404)), 'AppError: Render job was not found.');
});

test('internal detail strips Windows, UNC and home paths but keeps URLs and ratios', () => {
  assert.equal(internalErrorDetail(new Error('EPERM: rename C:\\Users\\bob\\osu-render\\data\\x.mp4.part')), 'Error: EPERM: rename …/x.mp4.part');
  assert.equal(internalErrorDetail(new Error('open \\\\server\\share\\file.osr failed')), 'Error: open …/file.osr failed');
  assert.equal(internalErrorDetail(new Error(`bad ${os.homedir()}/x`)), 'Error: bad …/x');
  assert.equal(internalErrorDetail(new Error('fetch https://osu.ppy.sh/api/v2/beatmaps failed, 1/2 done')),
    'Error: fetch https://osu.ppy.sh/api/v2/beatmaps failed, 1/2 done');
  const user = os.userInfo().username;
  if (user.length >= 2) assert.equal(internalErrorDetail(new Error(`user ${user} not allowed`)), 'Error: user <user> not allowed');
});

test('internal detail handles non-errors, whitespace and the length cap', () => {
  assert.equal(internalErrorDetail('boom'), 'string: boom');
  assert.equal(internalErrorDetail(undefined), 'undefined: undefined');
  assert.equal(internalErrorDetail(new Error('a\n  b\tc')), 'Error: a b c');
  const long = internalErrorDetail(new Error('x'.repeat(2000))) ?? '';
  assert.equal(long.length, 500);
  assert.ok(long.endsWith('…'));
});
