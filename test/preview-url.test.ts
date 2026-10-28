import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { settings } from '../src/config.js';
import { contentDisposition, createHttpServer, type HttpDependencies } from '../src/http.js';
import { createPreviewSigner, type PreviewSigner } from '../src/preview-url.js';
import type { PreflightResult, RenderRow } from '../src/types.js';

const READY: PreflightResult = { renderer: true, display: true, encoder: 'libx264', probes: [] };
const KEY = Buffer.alloc(32, 7);
const ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '66666666-7777-4888-9999-000000000000';
const START = 1_800_000_000_000;

function query(url: string): { exp: string; sig: string } {
  const params = new URL(url, 'http://local').searchParams;
  return { exp: params.get('exp') ?? '', sig: params.get('sig') ?? '' };
}

test('signed preview URLs verify for their render until they expire', () => {
  let now = START;
  const signer = createPreviewSigner({ key: KEY, ttlSeconds: 3600, now: () => now });
  const url = signer.url(ID);
  assert.match(url, new RegExp(`^/api/renders/${ID}/video\\?exp=\\d+&sig=[0-9a-f]{64}$`));
  const { exp, sig } = query(url);
  assert.equal(Number(exp), START / 1000 + 3600);
  assert.equal(signer.verify(ID, sig, exp), true);
  assert.equal(signer.verify(OTHER_ID, sig, exp), false, 'other id');
  assert.equal(signer.verify(ID, `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`, exp), false, 'tampered sig');
  assert.equal(signer.verify(ID, sig, String(Number(exp) + 1)), false, 'tampered exp');
  assert.equal(signer.verify(ID, sig.toUpperCase(), exp), false, 'non-canonical hex');
  for (const bad of [undefined, '', ['a'], `${sig}00`, 'zz'.repeat(32)]) assert.equal(signer.verify(ID, bad, exp), false);
  for (const bad of [undefined, '', '-1', '1e9', '1234567890123']) assert.equal(signer.verify(ID, sig, bad), false);
  assert.equal(createPreviewSigner({ ttlSeconds: 3600, now: () => now }).verify(ID, sig, exp), false, 'other key');
  now = START + 3600 * 1000;
  assert.equal(signer.verify(ID, sig, exp), true, 'valid through the expiry second');
  now = START + 3601 * 1000;
  assert.equal(signer.verify(ID, sig, exp), false, 'expired');
});

test('expiries far beyond the configured lifetime are rejected', () => {
  const longLived = createPreviewSigner({ key: KEY, ttlSeconds: 100 * 3600, now: () => START });
  const { exp, sig } = query(longLived.url(ID));
  assert.equal(createPreviewSigner({ key: KEY, ttlSeconds: 3600, now: () => START }).verify(ID, sig, exp), false);
});

async function withVideoServer(
  run: (app: Awaited<ReturnType<typeof createHttpServer>>, signer: PreviewSigner, clock: { now: number }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-preview-'));
  const video = path.join(directory, `${ID}.mp4`);
  await writeFile(video, Buffer.from('0123456789'));
  const clock = { now: START };
  const signer = createPreviewSigner({ key: KEY, ttlSeconds: 3600, now: () => clock.now });
  const row = {
    id: ID, status: 'completed', progress: 100, video_path: video, files_deleted_at: null, expires_at: Date.now() + 3_600_000,
    started_at: 1000, completed_at: 4000, created_at: 500, width: 1920, height: 1080, fps: 60, encoder: 'libx264',
    options_json: '{}', beatmap_id: 7, beatmapset_id: 8, beatmap_checksum: 'c', beatmap_title: 'Song', beatmap_artist: 'Artist',
    beatmap_version: 'Insane', player_name: 'p', mods: '', error_code: null, error_message: null, client_key: '127.0.0.1',
  } as unknown as RenderRow;
  const dependencies = {
    database: {
      getRender: (id: string) => (id === ID ? row : undefined), queuePosition: () => null, queuedCount: () => 0,
      rendersForClient: () => [row],
    },
    queue: {},
    storage: { freeBytes: async () => 1024 ** 4 },
    preflight: { health: async () => ({ status: 'ok' }) },
    preflightState: { current: () => READY, refreshIfNeeded: async () => READY },
    paths: { replays: directory, videos: directory, data: directory, logs: directory },
    previewSigner: signer,
  } as unknown as HttpDependencies;
  const app = await createHttpServer(dependencies);
  try { await run(app, signer, clock); } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const auth = settings.authToken ? { authorization: `Bearer ${settings.authToken}` } : {};

test('render JSON carries the signed preview URL and beatmap details', async () => {
  await withVideoServer(async (app) => {
    const render = (await app.inject({ method: 'GET', url: `/api/renders/${ID}`, headers: auth })).json();
    assert.match(render.previewUrl, new RegExp(`^/api/renders/${ID}/video\\?exp=`));
    assert.deepEqual(render.beatmap, { id: 7, beatmapsetId: 8, checksum: 'c', title: 'Song', artist: 'Artist', version: 'Insane' });
    assert.equal(render.speed, null);
    assert.equal(render.eta, null);
    assert.equal(render.renderMs, 3000);
    assert.equal(render.startedAt, 1000);
    const history = (await app.inject({ method: 'GET', url: '/api/renders', headers: auth })).json();
    assert.match(history.renders[0].previewUrl, /&sig=[0-9a-f]{64}$/);
  });
});

test('signed video URL streams inline with range support and no Bearer header', async () => {
  await withVideoServer(async (app, signer) => {
    const url = signer.url(ID);
    const full = await app.inject({ method: 'GET', url });
    assert.equal(full.statusCode, 200);
    assert.equal(full.body, '0123456789');
    assert.match(String(full.headers['content-disposition']), new RegExp(`^inline; filename="${ID}\\.mp4"; filename\\*=UTF-8''`));
    const part = await app.inject({ method: 'GET', url, headers: { range: 'bytes=2-5' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.body, '2345');
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  });
});

test('expired, tampered and other-render signatures are refused', async () => {
  await withVideoServer(async (app, signer, clock) => {
    const { exp, sig } = query(signer.url(ID));
    const otherSig = query(signer.url(OTHER_ID)).sig;
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    for (const url of [
      `/api/renders/${ID}/video?exp=${exp}&sig=${flipped}`,
      `/api/renders/${ID}/video?exp=${Number(exp) - 1}&sig=${sig}`,
      `/api/renders/${ID}/video?exp=${exp}&sig=${otherSig}`,
      `/api/renders/${ID}/video?sig=${sig}`,
      `/api/renders/${ID}/video?exp=${exp}&sig=${sig}&sig=${sig}`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.json().error.code, 'UNAUTHORIZED', url);
    }
    clock.now += 3601 * 1000;
    const expired = await app.inject({ method: 'GET', url: `/api/renders/${ID}/video?exp=${exp}&sig=${sig}` });
    assert.equal(expired.statusCode, 403);
  });
});

test('a signature only unlocks the video route', async () => {
  if (!settings.authToken) return; // without AUTH_TOKEN every /api route is open anyway
  await withVideoServer(async (app, signer) => {
    const { exp, sig } = query(signer.url(ID));
    const response = await app.inject({ method: 'GET', url: `/api/renders/${ID}?exp=${exp}&sig=${sig}` });
    assert.equal(response.statusCode, 401);
  });
});

test('video downloads are named after the beatmap with an ASCII fallback', () => {
  const row = { id: ID, beatmap_title: 'Blue Zenith', beatmap_artist: 'xi', beatmap_version: 'FOUR "DIMENSIONS"' } as RenderRow;
  assert.equal(contentDisposition('attachment', row),
    `attachment; filename="${ID}.mp4"; filename*=UTF-8''xi%20-%20Blue%20Zenith%20%5BFOUR%20_DIMENSIONS_%5D.mp4`);
  assert.equal(contentDisposition('inline', { ...row, beatmap_title: '千本桜', beatmap_artist: null, beatmap_version: null }),
    `inline; filename="${ID}.mp4"; filename*=UTF-8''%E5%8D%83%E6%9C%AC%E6%A1%9C.mp4`);
  assert.equal(contentDisposition('inline', { ...row, beatmap_title: null }), `inline; filename="${ID}.mp4"`);
});
