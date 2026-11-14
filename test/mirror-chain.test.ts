import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BeatmapResolver } from '../src/beatmap-resolver.js';
import { RenderDatabase } from '../src/database.js';
import { MirrorChain, mirrorTemplates, type BeatmapMirror } from '../src/mirrors.js';
import type { OsuApiClient } from '../src/osu-api.js';
import type { Paths } from '../src/types.js';
import { storeZip } from './skins-zip.js';

const FALLBACK = ['https://a.example/d/{id}', 'https://b.example/d/{id}'];
const LIMITS = { maxCompressedBytes: 1024 ** 2, maxExtractedBytes: 1024 ** 2, maxEntries: 100 };

test('mirrorTemplates puts configured mirrors first and appends unique fallbacks', () => {
  assert.deepEqual(mirrorTemplates(undefined, FALLBACK, false), FALLBACK);
  assert.deepEqual(mirrorTemplates('', FALLBACK, false), FALLBACK);
  assert.deepEqual(mirrorTemplates(' https://b.example/d/{id} , ,https://c.example/{id}', FALLBACK, false),
    ['https://b.example/d/{id}', 'https://c.example/{id}', 'https://a.example/d/{id}']);
});

test('mirrorTemplates honours BEATMAP_MIRRORS_ONLY but never ends up empty', () => {
  assert.deepEqual(mirrorTemplates('https://c.example/{id}', FALLBACK, true), ['https://c.example/{id}']);
  assert.deepEqual(mirrorTemplates(undefined, FALLBACK, true), FALLBACK);
  assert.deepEqual(mirrorTemplates(' , ', FALLBACK, true), FALLBACK);
});

function fakeMirror(name: string, behaviour: 'ok' | 'fail', content = name): BeatmapMirror & { calls: number } {
  const mirror = {
    name, calls: 0,
    async downloadBeatmapset(_id: number, destination: string): Promise<void> {
      mirror.calls += 1;
      if (behaviour === 'fail') throw new Error('HTTP 503');
      await writeFile(destination, content);
    },
  };
  return mirror;
}

async function withTemp(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-mirrors-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('an outdated mirror is skipped and the next one is accepted', async () => {
  await withTemp(async (directory) => {
    let counter = 0;
    const archivePath = (): string => path.join(directory, `${counter += 1}.osz`);
    const old = fakeMirror('old', 'ok', 'old version');
    const fresh = fakeMirror('fresh', 'ok', 'new version');
    const chain = new MirrorChain([old, fresh]);
    const result = await chain.download(1, 1024, archivePath, async (archive) => {
      const text = await readFile(archive, 'utf8');
      return text === 'new version' ? text : null;
    });
    assert.equal(result, 'new version');
    assert.deepEqual([old.calls, fresh.calls], [1, 1]);
    assert.deepEqual(await readdir(directory), [], 'every downloaded archive is removed');
  });
});

test('all mirrors outdated reports a version mismatch, all failing reports a download failure', async () => {
  await withTemp(async (directory) => {
    let counter = 0;
    const archivePath = (): string => path.join(directory, `${counter += 1}.osz`);
    const never = async (): Promise<null> => null;
    await assert.rejects(new MirrorChain([fakeMirror('a', 'ok'), fakeMirror('b', 'fail')]).download(1, 1024, archivePath, never),
      (error: { code?: string; message?: string }) => error.code === 'BEATMAP_CHECKSUM_MISMATCH' && /\ba\b/.test(error.message ?? ''));
    await assert.rejects(new MirrorChain([fakeMirror('a', 'fail'), fakeMirror('b', 'fail')]).download(1, 1024, archivePath, never),
      (error: { code?: string }) => error.code === 'BEATMAP_DOWNLOAD_FAILED');
    await assert.rejects(new MirrorChain([]).download(1, 1024, archivePath, never),
      (error: { code?: string }) => error.code === 'BEATMAP_DOWNLOAD_FAILED');
    assert.deepEqual(await readdir(directory), []);
  });
});

test('a broken archive from one mirror does not stop the next mirror', async () => {
  await withTemp(async (directory) => {
    let counter = 0;
    const archivePath = (): string => path.join(directory, `${counter += 1}.osz`);
    const chain = new MirrorChain([fakeMirror('broken', 'ok'), fakeMirror('good', 'ok')]);
    const result = await chain.download(1, 1024, archivePath, async (archive) => {
      if (await readFile(archive, 'utf8') === 'broken') throw new Error('not a zip');
      return 'good';
    });
    assert.equal(result, 'good');
  });
});

test('resolver installs the set from the first mirror that has the replay version', async () => {
  await withTemp(async (root) => {
    const data = path.join(root, 'data');
    const paths = {
      root, data, db: path.join(data, 'render.db'), replays: path.join(data, 'replays'), temp: path.join(data, 'temp'),
      videos: path.join(data, 'videos'), songs: path.join(data, 'songs'), skins: path.join(data, 'skins'),
      danserOutput: path.join(data, 'out'), danserSettings: path.join(root, 'service.json'),
      logs: path.join(data, 'logs'), diagnostics: path.join(data, 'diagnostics'),
    } as Paths;
    for (const directory of [data, paths.temp, paths.songs]) await mkdir(directory, { recursive: true });
    const current = 'osu file format v14\n[Metadata]\nVersion:Save Me\n// updated';
    const checksum = createHash('md5').update(current).digest('hex');
    const zipOf = (text: string): Buffer => storeZip([{ name: 'map [Save Me].osu', data: text }]);
    const mirror = (name: string, body: Buffer): BeatmapMirror => ({
      name, async downloadBeatmapset(_id: number, destination: string) { await writeFile(destination, body); },
    });
    const api = {
      lookupBeatmap: async () => ({ id: 5, beatmapsetId: 6, checksum, title: 'T', artist: 'A', version: 'Save Me', totalLength: 120 }),
    } as unknown as OsuApiClient;
    const database = new RenderDatabase(paths.db);
    try {
      const chain = new MirrorChain([mirror('stale', zipOf('osu file format v14\n// old')), mirror('fresh', zipOf(current))]);
      const resolver = new BeatmapResolver(paths, database, api, chain, LIMITS);
      const resolved = await resolver.resolve(checksum, () => undefined);
      assert.equal(resolved.metadata.beatmapsetId, 6);
      assert.equal(await readFile(path.join(resolved.cache.map_path, 'map [Save Me].osu'), 'utf8'), current);
      assert.equal((await readdir(paths.songs)).length, 1, 'only the matching set is installed');
      assert.deepEqual(await readdir(paths.temp), [], 'archives and extraction dirs are cleaned up');

      const staleOnly = new BeatmapResolver(paths, database, api, new MirrorChain([mirror('stale', zipOf('// old'))]), LIMITS);
      await assert.rejects(staleOnly.resolve(createHash('md5').update('other').digest('hex'), () => undefined),
        (error: { code?: string }) => error.code === 'BEATMAP_CHECKSUM_MISMATCH');
    } finally {
      database.close();
    }
  });
});
