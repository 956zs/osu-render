import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { parseRetentionHours, settings } from '../src/config.js';
import { BeatmapResolver } from '../src/beatmap-resolver.js';
import { RenderDatabase } from '../src/database.js';
import { createHttpServer, type HttpDependencies } from '../src/http.js';
import type { PreflightResult } from '../src/types.js';

const READY: PreflightResult = { renderer: true, display: true, encoder: 'libx264', probes: [] };
const auth = settings.authToken ? { authorization: `Bearer ${settings.authToken}` } : {};
const ME = '10.1.1.1';
const OTHER = '10.2.2.2';

async function withDatabase(run: (database: RenderDatabase, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-history-'));
  const database = new RenderDatabase(path.join(directory, 'render.db'));
  try { await run(database, directory); } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

/** A finished render with a video, replay and log on disk. */
async function finishedRender(database: RenderDatabase, directory: string, id: string, clientKey: string): Promise<void> {
  const replay = path.join(directory, `${id}.osr`);
  const video = path.join(directory, `${id}.mp4`);
  await writeFile(replay, 'replay');
  await writeFile(video, 'video');
  await writeFile(path.join(directory, `${id}.log`), 'log');
  database.createRender({ id, replayPath: replay, clientKey, encoder: 'h264_nvenc' });
  database.updateBeatmap(id, { id: 5, beatmapsetId: 6, title: 'Title', artist: 'Artist', version: 'Hard', creator: 'Mapper', totalLength: 151 });
  database.setStatus(id, 'queued');
  database.markRendering(id);
  database.setStatus(id, 'finalizing', 100);
  database.markCompleted(id, video, Date.now() + 60_000);
}

test('VIDEO_RETENTION_HOURS defaults to 24 and is clamped to 1..720', () => {
  assert.equal(parseRetentionHours(undefined), 24);
  assert.equal(parseRetentionHours('48'), 48);
  assert.equal(parseRetentionHours(' 2 '), 2);
  assert.equal(parseRetentionHours('0'), 1);
  assert.equal(parseRetentionHours('-5'), 1);
  assert.equal(parseRetentionHours('100000'), 720);
  for (const bad of ['', 'abc', '1.5', '12h']) assert.equal(parseRetentionHours(bad), 24, bad);
});

test('older databases gain the history columns', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-migrate-'));
  const file = path.join(directory, 'old.db');
  try {
    const old = new Database(file);
    old.exec(`CREATE TABLE renders (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, replay_path TEXT NOT NULL, video_path TEXT,
      client_key TEXT NOT NULL, player_name TEXT, beatmap_checksum TEXT, beatmap_id INTEGER, beatmapset_id INTEGER,
      mods TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL, fps INTEGER NOT NULL, encoder TEXT NOT NULL,
      error_code TEXT, error_message TEXT, started_at INTEGER, completed_at INTEGER, expires_at INTEGER);
      CREATE TABLE beatmaps (checksum TEXT PRIMARY KEY, beatmap_id INTEGER NOT NULL, beatmapset_id INTEGER NOT NULL,
      map_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);`);
    old.close();
    const database = new RenderDatabase(file);
    const columns = (table: string): string[] => (database.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
    for (const name of ['options_json', 'beatmap_title', 'beatmap_artist', 'beatmap_version', 'files_deleted_at', 'beatmap_creator', 'beatmap_length']) {
      assert.ok(columns('renders').includes(name), name);
    }
    for (const name of ['title', 'artist', 'version', 'creator', 'length']) assert.ok(columns('beatmaps').includes(name), name);
    assert.ok(columns('local_beatmaps').includes('md5'));
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('history lists one client only and deleted files leave the row', async () => {
  await withDatabase(async (database, directory) => {
    await finishedRender(database, directory, 'mine', 'me');
    await finishedRender(database, directory, 'theirs', 'them');
    assert.deepEqual(database.rendersForClient('me', 10).map((row) => row.id), ['mine']);
    assert.deepEqual(database.rendersForClient('me', 0), []);
    database.markFilesDeleted('mine');
    const row = database.getRender('mine');
    assert.ok(row?.files_deleted_at);
    assert.equal(row?.video_path, null);
    assert.equal(database.expiredRenders(Date.now() + 120_000).map((expired) => expired.id).join(), 'theirs');
  });
});

async function withServer(run: (app: Awaited<ReturnType<typeof createHttpServer>>, database: RenderDatabase, directory: string) => Promise<void>): Promise<void> {
  await withDatabase(async (database, directory) => {
    const dependencies = {
      database, queue: { cancel: async () => undefined }, storage: { freeBytes: async () => 1024 ** 4 },
      preflight: {}, preflightState: { current: () => READY, refreshIfNeeded: async () => READY },
      paths: { replays: directory, videos: directory, data: directory, logs: directory },
    } as unknown as HttpDependencies;
    const app = await createHttpServer(dependencies);
    try { await run(app, database, directory); } finally { await app.close(); }
  });
}

test('GET /api/renders returns the requesting client history', async () => {
  await withServer(async (app, database, directory) => {
    await finishedRender(database, directory, '11111111-1111-4111-8111-111111111111', ME);
    await finishedRender(database, directory, '22222222-2222-4222-8222-222222222222', OTHER);
    database.createRender({ id: '33333333-3333-4333-8333-333333333333', replayPath: '/q.osr', clientKey: ME, encoder: 'libx264' });
    const response = await app.inject({ method: 'GET', url: '/api/renders?limit=5', headers: auth, remoteAddress: ME });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const renders = response.json().renders as Array<Record<string, unknown>>;
    assert.deepEqual(renders.map((render) => render.id).sort(), [
      '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
    ]);
    const done = renders.find((render) => render.status === 'completed') as Record<string, unknown>;
    assert.deepEqual(done.beatmap, { id: 5, beatmapsetId: 6, title: 'Title', artist: 'Artist', version: 'Hard', creator: 'Mapper', length: 151 });
    assert.equal(done.resolution, '1080p');
    assert.equal(done.encoder, 'h264_nvenc');
    assert.equal(done.videoAvailable, true);
    assert.equal(typeof done.videoBytes, 'number');
    assert.ok((done.videoBytes as number) > 0);
    assert.equal(done.filesDeleted, false);
    assert.equal(typeof done.renderMs, 'number');
    assert.equal(typeof done.expiresAt, 'number');
    const queued = renders.find((render) => render.status === 'uploaded') as Record<string, unknown>;
    assert.equal(queued.videoAvailable, false);
    assert.equal(queued.videoBytes, null);
    assert.equal(queued.beatmap, null);
    const limited = await app.inject({ method: 'GET', url: '/api/renders?limit=1', headers: auth, remoteAddress: ME });
    assert.equal(limited.json().renders.length, 1);
    for (const limit of ['0', 'abc', '-1', '9999999']) {
      const response = await app.inject({ method: 'GET', url: `/api/renders?limit=${limit}`, headers: auth, remoteAddress: ME });
      assert.equal(response.statusCode, 200, limit);
    }
  });
});

test('DELETE /api/renders/:id/files frees a finished render of the same client', async () => {
  await withServer(async (app, database, directory) => {
    const id = '44444444-4444-4444-8444-444444444444';
    await finishedRender(database, directory, id, ME);
    const stranger = await app.inject({ method: 'DELETE', url: `/api/renders/${id}/files`, headers: auth, remoteAddress: OTHER });
    assert.equal(stranger.statusCode, 404);
    assert.ok(await exists(path.join(directory, `${id}.mp4`)));
    const response = await app.inject({ method: 'DELETE', url: `/api/renders/${id}/files`, headers: auth, remoteAddress: ME });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().filesDeleted, true);
    assert.equal(response.json().videoAvailable, false);
    for (const suffix of ['.mp4', '.osr', '.log']) assert.ok(!(await exists(path.join(directory, `${id}${suffix}`))), suffix);
    assert.equal(database.getRender(id)?.status, 'completed');
    const video = await app.inject({ method: 'GET', url: `/api/renders/${id}/video`, headers: auth });
    assert.equal(video.statusCode, 410);
    assert.equal(video.json().error.code, 'RENDER_EXPIRED');
    const again = await app.inject({ method: 'DELETE', url: `/api/renders/${id}/files`, headers: auth, remoteAddress: ME });
    assert.equal(again.statusCode, 200);

    const active = '55555555-5555-4555-8555-555555555555';
    database.createRender({ id: active, replayPath: path.join(directory, 'active.osr'), clientKey: ME, encoder: 'libx264' });
    const busy = await app.inject({ method: 'DELETE', url: `/api/renders/${active}/files`, headers: auth, remoteAddress: ME });
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().error.code, 'RENDER_ACTIVE');
  });
});

test('render JSON adds mapper, map length, expiry and video size', async () => {
  await withServer(async (app, database, directory) => {
    const id = '44444444-4444-4444-8444-444444444444';
    await finishedRender(database, directory, id, ME);
    const render = (await app.inject({ method: 'GET', url: `/api/renders/${id}`, headers: auth, remoteAddress: ME })).json();
    assert.equal(render.beatmap.creator, 'Mapper');
    assert.equal(render.beatmap.length, 151);
    assert.equal(typeof render.expiresAt, 'number');
    assert.equal(render.videoBytes, 'video'.length);
    database.markFilesDeleted(id);
    const deleted = (await app.inject({ method: 'GET', url: `/api/renders/${id}`, headers: auth, remoteAddress: ME })).json();
    assert.equal(deleted.previewUrl, null);
    assert.equal(deleted.videoBytes, null);
  });
});

test('cached beatmaps keep the mapper and length for later renders', async () => {
  await withDatabase(async (database, directory) => {
    database.saveBeatmap({
      checksum: 'abc', beatmap_id: 5, beatmapset_id: 6, map_path: directory, size_bytes: 1,
      title: 'Title', artist: 'Artist', version: 'Hard', creator: 'Mapper', length: 151,
    });
    assert.equal(database.findBeatmap('abc')?.creator, 'Mapper');
    assert.equal(database.findBeatmap('abc')?.length, 151);
    const resolver = new BeatmapResolver({} as never, database, {} as never, {} as never, { maxCompressedBytes: 1, maxExtractedBytes: 1, maxEntries: 1 });
    const resolved = await resolver.resolve('abc', () => undefined);
    assert.equal(resolved.metadata.creator, 'Mapper');
    assert.equal(resolved.metadata.totalLength, 151);
    database.createRender({ id: 'r', replayPath: '/r.osr', clientKey: ME, encoder: 'libx264' });
    database.updateBeatmap('r', resolved.metadata);
    assert.equal(database.getRender('r')?.beatmap_creator, 'Mapper');
    assert.equal(database.getRender('r')?.beatmap_length, 151);
    database.updateBeatmap('r', { id: 5, beatmapsetId: 6 });
    assert.equal(database.getRender('r')?.beatmap_creator, null);
    assert.equal(database.getRender('r')?.beatmap_length, null);
  });
});
