import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReplayBuffer } from '../src/replay.js';

function osuString(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([0x0b, bytes.length]), bytes]);
}

function buildReplay(playMode = 0): Buffer {
  const fixed = Buffer.alloc(2 * 6 + 4 + 2 + 1 + 4);
  let offset = 2 * 6;
  fixed.writeInt32LE(123456, offset); offset += 4;
  fixed.writeUInt16LE(321, offset); offset += 2;
  fixed.writeUInt8(1, offset); offset += 1;
  fixed.writeUInt32LE(8, offset);
  const header = Buffer.alloc(5);
  header.writeUInt8(playMode, 0);
  header.writeInt32LE(20250101, 1);
  const ticks = Buffer.alloc(8);
  ticks.writeBigInt64LE(638700000000000000n);
  const replayData = Buffer.from([1, 2, 3]);
  const length = Buffer.alloc(4);
  length.writeInt32LE(replayData.length);
  return Buffer.concat([
    header,
    osuString('0123456789abcdef0123456789abcdef'),
    osuString('player'),
    osuString('fedcba9876543210fedcba9876543210'),
    fixed,
    Buffer.from([0]),
    ticks,
    length,
    replayData,
  ]);
}

test('parses stable replay metadata', () => {
  const replay = parseReplayBuffer(buildReplay());
  assert.equal(replay.playMode, 0);
  assert.equal(replay.playerName, 'player');
  assert.equal(replay.score, 123456);
  assert.equal(replay.maxCombo, 321);
  assert.equal(replay.mods, 'HD');
  assert.equal(replay.compressedReplayBytes, 3);
});

test('preserves unsupported mode for boundary validation', () => {
  assert.equal(parseReplayBuffer(buildReplay(3)).playMode, 3);
});
