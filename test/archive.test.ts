import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { extractOsz, validateArchiveEntryName } from '../src/archive.js';

const LIMITS = { maxEntries: 100, maxExtractedBytes: 1024 * 1024 };

function storeZip(entries: Array<{ name: string; data?: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

async function withZip(entries: Array<{ name: string; data?: string }>, run: (zip: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osu-render-archive-'));
  const zip = path.join(root, 'map.osz');
  await writeFile(zip, storeZip(entries));
  try { await run(zip, root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

test('entry validator accepts normal names and strips directory slashes', () => {
  assert.equal(validateArchiveEntryName('Song/hit.wav'), 'Song/hit.wav');
  assert.equal(validateArchiveEntryName('SB/'), 'SB');
  assert.equal(validateArchiveEntryName('Artist - Title (Mapper) [Hard].osu'), 'Artist - Title (Mapper) [Hard].osu');
  assert.equal(validateArchiveEntryName('音楽/.hidden'), '音楽/.hidden');
});

test('entry validator rejects empty names and empty segments', () => {
  for (const name of ['', '/', 'a//b', './a', 'a/./b']) {
    assert.throws(() => validateArchiveEntryName(name), Error, name);
  }
});

test('entry validator enforces boundaries on length and reserved names', () => {
  assert.equal(validateArchiveEntryName('a'.repeat(255)), 'a'.repeat(255));
  assert.throws(() => validateArchiveEntryName('a'.repeat(256)), /too long/);
  for (const name of ['COM10.txt', 'CONSOLE.osu', 'nul_.wav', 'lpt0', 'auxiliary/x']) {
    assert.equal(validateArchiveEntryName(name), name);
  }
  for (const name of ['CON', 'con.txt', 'Nul.tar.gz', 'dir/aux.wav', 'COM1.osu', 'lpt9', 'COM\u00b9', 'LPT\u00b3.x', 'CONIN$', 'conout$.log', 'NUL .txt']) {
    assert.throws(() => validateArchiveEntryName(name), /reserved name/, name);
  }
});

test('entry validator rejects traversal, absolute paths and windows-hostile characters', () => {
  const cases: Array<[string, RegExp]> = [
    ['../evil.txt', /segment/], ['a/../../evil', /segment/], ['/etc/passwd', /absolute/],
    ['C:/Windows/x', /invalid character/], ['a\\b', /invalid character/], ['\\\\server\\share\\x', /invalid character/],
    ['a:b', /invalid character/], ['a<b', /invalid character/], ['a>b', /invalid character/], ['a"b', /invalid character/],
    ['a|b', /invalid character/], ['a?b', /invalid character/], ['a*b', /invalid character/],
    ['a\u0000b', /invalid character/], ['a\u001fb', /invalid character/], ['dir./x', /dot or space/], ['x ', /dot or space/],
  ];
  for (const [name, pattern] of cases) assert.throws(() => validateArchiveEntryName(name), pattern, name);
});

test('extracts a stored zip with nested entries', async () => {
  await withZip([
    { name: 'Song/' }, { name: 'Song/map.osu', data: 'osu file format v14' }, { name: 'audio.mp3', data: 'mp3' },
  ], async (zip, root) => {
    const output = path.join(root, 'out');
    await extractOsz(zip, output, LIMITS);
    assert.equal(await readFile(path.join(output, 'Song', 'map.osu'), 'utf8'), 'osu file format v14');
    assert.equal(await readFile(path.join(output, 'audio.mp3'), 'utf8'), 'mp3');
  });
});

test('extracts into a symlinked or junctioned data directory', async () => {
  await withZip([{ name: 'map.osu', data: 'x' }], async (zip, root) => {
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    await mkdir(real);
    await symlink(real, link, 'junction');
    await extractOsz(zip, path.join(link, 'out'), LIMITS);
    assert.equal(await readFile(path.join(real, 'out', 'map.osu'), 'utf8'), 'x');
  });
});

test('rejects reserved windows names and removes the partial output', async () => {
  await withZip([{ name: 'ok.osu', data: 'x' }, { name: 'CON.txt', data: 'y' }], async (zip, root) => {
    const output = path.join(root, 'out');
    await assert.rejects(extractOsz(zip, output, LIMITS), { code: 'BEATMAP_INVALID_ARCHIVE', message: /reserved name/ });
    assert.equal(await exists(output), false);
  });
});

test('rejects case-insensitive duplicates and file/directory clashes', async () => {
  for (const entries of [
    [{ name: 'Map.osu', data: 'a' }, { name: 'map.OSU', data: 'b' }],
    [{ name: 'sb', data: 'a' }, { name: 'SB/x.png', data: 'b' }],
    [{ name: 'SB/x.png', data: 'a' }, { name: 'sb', data: 'b' }],
  ]) {
    await withZip(entries, async (zip, root) => {
      await assert.rejects(extractOsz(zip, path.join(root, 'out'), LIMITS), { code: 'BEATMAP_INVALID_ARCHIVE', message: /duplicate/ });
    });
  }
});

test('rejects path traversal without writing outside the root', async () => {
  await withZip([{ name: '../evil.txt', data: 'x' }], async (zip, root) => {
    await assert.rejects(extractOsz(zip, path.join(root, 'out'), LIMITS), { code: 'BEATMAP_INVALID_ARCHIVE' });
    assert.equal(await exists(path.join(root, 'evil.txt')), false);
  });
});
