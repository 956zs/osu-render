import { readFile } from 'node:fs/promises';
import { AppError } from './errors.js';
import type { ReplayMetadata } from './types.js';

const CHECKSUM = /^[a-f0-9]{32}$/i;
const MODS: Array<[number, string]> = [
  [1, 'NF'], [2, 'EZ'], [4, 'TD'], [8, 'HD'], [16, 'HR'], [32, 'SD'],
  [64, 'DT'], [128, 'RX'], [256, 'HT'], [512, 'NC'], [1024, 'FL'], [2048, 'AT'],
  [4096, 'SO'], [8192, 'AP'], [16384, 'PF'], [32768, 'K4'], [65536, 'K5'],
  [131072, 'K6'], [262144, 'K7'], [524288, 'K8'], [1048576, 'FI'], [2097152, 'RD'],
  [4194304, 'CN'], [8388608, 'TP'], [16777216, 'K9'], [33554432, 'CO'],
  [67108864, 'K1'], [134217728, 'K2'], [268435456, 'K3'], [536870912, 'XH'],
  [1073741824, 'V2'], [2147483648, 'MR'],
];

class BinaryReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  private ensure(size: number): void {
    if (this.offset + size > this.data.length) throw new Error('unexpected end of replay');
  }

  uint8(): number { this.ensure(1); return this.data[this.offset++]; }
  uint16(): number { this.ensure(2); const value = this.data.readUInt16LE(this.offset); this.offset += 2; return value; }
  int32(): number { this.ensure(4); const value = this.data.readInt32LE(this.offset); this.offset += 4; return value; }
  int64(): bigint { this.ensure(8); const value = this.data.readBigInt64LE(this.offset); this.offset += 8; return value; }
  bytes(size: number): Buffer { this.ensure(size); const value = this.data.subarray(this.offset, this.offset + size); this.offset += size; return value; }

  osuString(): string {
    const marker = this.uint8();
    if (marker === 0) return '';
    if (marker !== 0x0b) throw new Error('invalid osu string marker');
    let length = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const part = this.uint8();
      length |= (part & 0x7f) << shift;
      if ((part & 0x80) === 0) return new TextDecoder().decode(this.bytes(length));
      shift += 7;
    }
    throw new Error('invalid osu string length');
  }
}

function formatMods(value: number): string {
  return MODS.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name).join('');
}

function parseBuffer(data: Buffer): ReplayMetadata {
  try {
    const reader = new BinaryReader(data);
    const playMode = reader.uint8();
    const osuVersion = reader.int32();
    const beatmapChecksum = reader.osuString();
    const playerName = reader.osuString();
    const replayChecksum = reader.osuString();
    reader.uint16(); reader.uint16(); reader.uint16(); reader.uint16(); reader.uint16(); reader.uint16();
    const score = reader.int32();
    const maxCombo = reader.uint16();
    reader.uint8();
    const modsValue = reader.int32() >>> 0;
    reader.osuString();
    const ticks = reader.int64();
    const compressedReplayBytes = reader.int32();
    if (compressedReplayBytes <= 0 || compressedReplayBytes > data.length) {
      throw new Error('replay input data is missing');
    }
    reader.bytes(compressedReplayBytes);
    if (!CHECKSUM.test(beatmapChecksum)) throw new Error('invalid beatmap checksum');
    return {
      playMode, osuVersion, beatmapChecksum: beatmapChecksum.toLowerCase(), playerName,
      replayChecksum, score, maxCombo, mods: formatMods(modsValue),
      timestamp: fileTimeToUnixMs(ticks), compressedReplayBytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid replay';
    throw new AppError('INVALID_REPLAY', message, 400);
  }
}

function fileTimeToUnixMs(ticks: bigint): number {
  const unixEpochTicks = 621355968000000000n;
  const millis = (ticks - unixEpochTicks) / 10000n;
  return Number(millis);
}

export async function parseReplayFile(filePath: string): Promise<ReplayMetadata> {
  const data = await readFile(filePath);
  return parseBuffer(data);
}

export function parseReplayBuffer(data: Buffer): ReplayMetadata {
  return parseBuffer(data);
}
