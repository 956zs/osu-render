import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BeatmapResolver } from '../src/beatmap-resolver.js';
import { RenderDatabase } from '../src/database.js';
import { AppError } from '../src/errors.js';
import {
  LocalSongsIndex, copySetFolder, parseOsuMetadata, resolveSongsDirs,
} from '../src/local-songs.js';
import type { MirrorChain } from '../src/mirrors.js';
import type { OsuApiClient } from '../src/osu-api.js';
import type { Paths } from '../src/types.js';

const OPTIONS = { maxFiles: 1000, progressEvery: 1000 };
const LIMITS = { maxCompressedBytes: 1024 ** 2, maxExtractedBytes: 1024 ** 2, maxEntries: 100 };

function osuFile(options: { title?: string; setId?: number | string; id?: number | string; lastMs?: number; extra?: string } = {}): string {
  return [
    'osu file format v14', '', '[General]', 'Mode: 0', '', '[Metadata]',
    `Title:${options.title ?? 'Song'}`, 'Artist:Someone', 'Creator:mapper', 'Version:Insane',
    `BeatmapID:${options.id ?? 111}`, `BeatmapSetID:${options.setId ?? 222}`, '', '[HitObjects]',
    '256,192,1000,1,0,0:0:0:0:', `256,192,${options.lastMs ?? 5000},1,0,0:0:0:0:`, options.extra ?? '',
  ].join('\r\n');
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

interface Fixture { root: string; songs: string; database: RenderDatabase; paths: Paths }

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osu-render-local-songs-'));
  const songs = path.join(root, 'osu', 'Songs');
  await mkdir(songs, { recursive: true });
  const data = path.join(root, 'data');
  const paths = {
    root, data, db: path.join(data, 'render.db'), replays: path.join(data, 'replays'), temp: path.join(data, 'temp'),
    videos: path.join(data, 'videos'), songs: path.join(data, 'songs'), skins: path.join(data, 'skins'),
    danserOutput: path.join(data, 'out'), danserSettings: path.join(root, 'service.json'),
    logs: path.join(data, 'logs'), diagnostics: path.join(data, 'diagnostics'),
  } as Paths;
  for (const directory of [data, paths.temp, paths.songs]) await mkdir(directory, { recursive: true });
  const database = new RenderDatabase(paths.db);
  try { await run({ root, songs, database, paths }); } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function addSet(songs: string, name: string, files: Record<string, string>): Promise<string> {
  const directory = path.join(songs, name);
  await mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  return directory;
}

function fakeApi(): { api: OsuApiClient; calls: string[] } {
  const calls: string[] = [];
  const api = {
    lookupBeatmap: async (checksum: string) => {
      calls.push(checksum);
      throw new AppError('BEATMAP_NOT_FOUND', 'Beatmap was not found.', 404);
    },
  } as unknown as OsuApiClient;
  return { api, calls };
}

const NO_MIRRORS = { download: async () => { throw new Error('mirror should not be used'); } } as unknown as MirrorChain;

test('songs folders come from OSU_SONGS_DIRS or Windows auto-detection', () => {
  assert.deepEqual(resolveSongsDirs({ OSU_SONGS_DIRS: '/a/Songs:/b/Songs:/a/Songs: ' }, 'linux', true), ['/a/Songs', '/b/Songs']);
  assert.deepEqual(resolveSongsDirs({ OSU_SONGS_DIRS: 'D:\\osu\\Songs;E:\\Songs' }, 'win32', true), ['D:\\osu\\Songs', 'E:\\Songs']);
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  assert.deepEqual(resolveSongsDirs(env, 'win32', true, () => true), ['C:\\Users\\me\\AppData\\Local\\osu!\\Songs']);
  assert.deepEqual(resolveSongsDirs(env, 'win32', true, () => false), []);
  assert.deepEqual(resolveSongsDirs(env, 'win32', false, () => true), []);
  assert.deepEqual(resolveSongsDirs(env, 'linux', true, () => true), []);
  assert.deepEqual(resolveSongsDirs({}, 'win32', true, () => true), []);
});

test('.osu metadata parsing handles unsubmitted maps and long objects', () => {
  const parsed = parseOsuMetadata(osuFile({ id: 0, setId: -1, lastMs: 9000, extra: '256,192,7000,12,0,20000,0:0:0:0:' }));
  assert.deepEqual(parsed, {
    beatmapId: null, beatmapsetId: null, title: 'Song', artist: 'Someone', version: 'Insane', lengthMs: 20000,
  });
  assert.equal(parseOsuMetadata(osuFile()).beatmapsetId, 222);
  assert.equal(parseOsuMetadata(osuFile()).lengthMs, 5000);
  assert.deepEqual(parseOsuMetadata(''), {
    beatmapId: null, beatmapsetId: null, title: null, artist: null, version: null, lengthMs: null,
  });
});

test('index scans .osu files and rescans only what changed', async () => {
  await withFixture(async ({ songs, database }) => {
    const a = osuFile({ title: 'A' });
    const b = osuFile({ title: 'B', id: 112 });
    await addSet(songs, '222 Someone - Song', { 'a.osu': a, 'b.osu': b, 'audio.mp3': 'x' });
    await addSet(songs, '333 Other', { 'c.osu': osuFile({ title: 'C', setId: 333 }) });
    await writeFile(path.join(songs, 'loose.osu'), osuFile());
    const index = new LocalSongsIndex(database.db, [songs, path.join(songs, 'missing')], OPTIONS);
    assert.equal(index.status().state, 'idle');
    await index.scan();
    assert.deepEqual({ ...index.status(), durationMs: 0 }, {
      state: 'ready', dirs: 2, filesSeen: 3, hashed: 3, indexed: 3, skippedLinks: 0, truncated: false, durationMs: 0,
    });
    const hit = await index.lookup(md5(a));
    assert.equal(hit?.title, 'A');
    assert.equal(hit?.beatmapset_id, 222);
    assert.equal(hit?.set_dir, path.join(songs, '222 Someone - Song'));

    await index.scan();
    assert.equal(index.status().hashed, 0, 'unchanged files are not hashed again');

    const changed = osuFile({ title: 'B2', id: 112 });
    await writeFile(path.join(songs, '222 Someone - Song', 'b.osu'), changed);
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(songs, '222 Someone - Song', 'b.osu'), future, future);
    await rm(path.join(songs, '333 Other'), { recursive: true });
    await index.scan();
    assert.equal(index.status().hashed, 1);
    assert.equal(index.status().indexed, 2);
    assert.equal(await index.lookup(md5(b)), null);
    assert.equal((await index.lookup(md5(changed)))?.title, 'B2');
  });
});

test('index skips symlinked sets and files and stops at the file cap', async () => {
  await withFixture(async ({ root, songs, database }) => {
    const outside = await addSet(root, 'outside', { 'x.osu': osuFile({ title: 'X' }) });
    await symlink(outside, path.join(songs, 'linked-set'), 'junction');
    const real = await addSet(songs, 'real', { 'r.osu': osuFile({ title: 'R' }) });
    await symlink(path.join(outside, 'x.osu'), path.join(real, 'linked.osu'));
    const index = new LocalSongsIndex(database.db, [songs], OPTIONS);
    await index.scan();
    assert.equal(index.status().skippedLinks, 2);
    assert.equal(index.status().indexed, 1);
    assert.equal(await index.lookup(md5(osuFile({ title: 'X' }))), null);

    await addSet(songs, 'more', { 'm1.osu': osuFile({ title: 'M1' }), 'm2.osu': osuFile({ title: 'M2' }) });
    const capped = new LocalSongsIndex(database.db, [songs], { maxFiles: 2, progressEvery: 1 });
    await capped.scan();
    assert.equal(capped.status().truncated, true);
    assert.equal(capped.status().filesSeen, 2);
    assert.ok(capped.status().indexed >= 2, 'a truncated scan keeps rows it did not reach');
  });
});

test('disabled index never scans or matches', async () => {
  await withFixture(async ({ database }) => {
    const index = new LocalSongsIndex(database.db, [], OPTIONS);
    await index.scan();
    assert.equal(index.status().state, 'disabled');
    assert.equal(await index.lookup('0'.repeat(32)), null);
  });
});

test('copying a set keeps regular files only and enforces the limits', async () => {
  await withFixture(async ({ root, songs }) => {
    const set = await addSet(songs, 'set', { 'a.osu': 'a', 'sb/bg.png': 'png' });
    await symlink(path.join(root, 'osu'), path.join(set, 'escape'));
    const target = path.join(root, 'copy');
    await copySetFolder(set, target, { maxEntries: 10, maxExtractedBytes: 100 });
    assert.deepEqual((await readdir(target)).sort(), ['a.osu', 'sb']);
    assert.equal(await readFile(path.join(target, 'sb', 'bg.png'), 'utf8'), 'png');
    await assert.rejects(copySetFolder(set, target, { maxEntries: 2, maxExtractedBytes: 100 }), /too many files/);
    await assert.rejects(copySetFolder(set, target, { maxEntries: 10, maxExtractedBytes: 2 }), /too large/);
    await assert.rejects(access(target));
    await addSet(songs, 'bad', { 'trailing. ': 'x' });
    await assert.rejects(copySetFolder(path.join(songs, 'bad'), target, { maxEntries: 10, maxExtractedBytes: 100 }));
  });
});

test('resolver copies a local set before asking the osu! API', async () => {
  await withFixture(async ({ songs, database, paths }) => {
    const text = osuFile({ id: 0, setId: -1, title: 'Unsubmitted' });
    await addSet(songs, 'beatmap-local', { 'map.osu': text, 'audio.mp3': 'audio' });
    const index = new LocalSongsIndex(database.db, [songs], OPTIONS);
    await index.scan();
    const { api, calls } = fakeApi();
    const resolver = new BeatmapResolver(paths, database, api, NO_MIRRORS, LIMITS, index);
    let downloading = false;
    const resolved = await resolver.resolve(md5(text), () => { downloading = true; });
    assert.deepEqual(calls, []);
    assert.equal(downloading, false);
    assert.equal(resolved.metadata.title, 'Unsubmitted');
    assert.equal(resolved.cache.beatmapset_id, 0);
    assert.match(path.basename(resolved.cache.map_path), /^local-[0-9a-f-]{36}$/);
    assert.equal(await readFile(path.join(resolved.cache.map_path, 'audio.mp3'), 'utf8'), 'audio');
    assert.deepEqual(await readdir(paths.temp), []);

    database.createRender({ id: 'job', replayPath: '/x.osr', clientKey: 'c', encoder: 'libx264' });
    database.updateBeatmap('job', resolved.metadata);
    const row = database.getRender('job');
    assert.equal(row?.beatmap_id, null);
    assert.equal(row?.beatmapset_id, null);
    assert.equal(row?.beatmap_title, 'Unsubmitted');

    const again = await resolver.resolve(md5(text), () => undefined);
    assert.equal(again.metadata.title, 'Unsubmitted', 'cached maps keep their metadata');
  });
});

test('resolver falls back to the API when the local file no longer matches', async () => {
  await withFixture(async ({ songs, database, paths }) => {
    const text = osuFile({ title: 'Edited later' });
    const set = await addSet(songs, '222 set', { 'map.osu': text });
    const index = new LocalSongsIndex(database.db, [songs], OPTIONS);
    await index.scan();
    await writeFile(path.join(set, 'map.osu'), `${text}\r\n// edited`);
    const { api, calls } = fakeApi();
    const resolver = new BeatmapResolver(paths, database, api, NO_MIRRORS, LIMITS, index);
    await assert.rejects(resolver.resolve(md5(text), () => undefined), (error: { code?: string }) => error.code === 'BEATMAP_NOT_FOUND');
    assert.deepEqual(calls, [md5(text)]);
    assert.deepEqual(await readdir(paths.songs), []);
  });
});

test('resolver falls back when copying the local set fails, and applies the length limit', async () => {
  await withFixture(async ({ songs, database, paths }) => {
    const text = osuFile({ title: 'Huge' });
    await addSet(songs, 'set', { 'map.osu': text, 'video.avi': 'x'.repeat(4096) });
    const long = osuFile({ title: 'Long', lastMs: 16 * 60 * 1000 });
    await addSet(songs, 'long', { 'map.osu': long });
    const index = new LocalSongsIndex(database.db, [songs], OPTIONS);
    await index.scan();
    const { api, calls } = fakeApi();
    const resolver = new BeatmapResolver(paths, database, api, NO_MIRRORS, { ...LIMITS, maxExtractedBytes: 1024 }, index);
    await assert.rejects(resolver.resolve(md5(text), () => undefined), (error: { code?: string }) => error.code === 'BEATMAP_NOT_FOUND');
    assert.deepEqual(calls, [md5(text)]);
    assert.deepEqual(await readdir(paths.songs), []);
    await assert.rejects(resolver.resolve(md5(long), () => undefined), /15 minute/);
    assert.equal(calls.length, 1);
  });
});

test('diagnostics include the local Songs index status without paths', async () => {
  const { collectDiagnostics } = await import('../src/diagnostics.js');
  await withFixture(async ({ songs, database, paths }) => {
    await addSet(songs, 'set', { 'map.osu': osuFile() });
    const index = new LocalSongsIndex(database.db, [songs], OPTIONS);
    await index.scan();
    const report = await collectDiagnostics({
      preflight: {
        run: async () => ({ renderer: true, display: true, encoder: 'libx264', probes: [] }),
        probeAll: async () => [],
        tools: async () => { throw new Error('no danser'); },
      },
      settings: {
        host: '127.0.0.1', port: 3030, renderEncoder: 'auto', danserDir: path.join(paths.root, 'danser'),
        osuClientId: '', osuClientSecret: '', authToken: '', mirrors: [],
      },
      paths: { data: paths.data, logs: paths.logs },
      skipProbes: 'auto_report',
      runCommand: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      localSongs: index,
    });
    assert.equal(report.localSongs?.state, 'ready');
    assert.equal(report.localSongs?.indexed, 1);
    assert.ok(!JSON.stringify(report.localSongs).includes(songs));
  });
});
