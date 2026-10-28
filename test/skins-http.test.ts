import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appConfig } from '../src/app-config.js';
import { settings } from '../src/config.js';
import { createHttpServer, type HttpDependencies } from '../src/http.js';
import { SKIN_STAGING_DIR } from '../src/skins.js';
import type { PreflightResult } from '../src/types.js';
import { storeZip } from './skins-zip.js';

const READY: PreflightResult = { renderer: true, display: true, encoder: 'libx264', probes: [] };
const BOUNDARY = '----osu-render-skins-test';
const auth = settings.authToken ? { authorization: `Bearer ${settings.authToken}` } : {};
let clientNumber = 0;

type App = Awaited<ReturnType<typeof createHttpServer>>;

async function withServer(run: (app: App, skins: string, created: string[]) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-skins-http-'));
  const skins = path.join(directory, 'skins');
  const replays = path.join(directory, 'replays');
  await mkdir(skins);
  const created: string[] = [];
  const dependencies = {
    database: {
      activeCountForClient: () => 0, activeCount: () => 0,
      createRender: (row: { id: string }) => { created.push(row.id); },
    },
    queue: { enqueue: async () => undefined },
    storage: { freeBytes: async () => 1024 ** 4, guardNewRender: async () => undefined },
    preflight: {},
    preflightState: { current: () => READY, refreshIfNeeded: async () => READY },
    paths: { replays, videos: directory, data: directory, logs: directory },
    skinsDir: skins,
  } as unknown as HttpDependencies;
  const app = await createHttpServer(dependencies);
  try { await run(app, skins, created); } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function multipart(parts: Array<{ name: string; filename?: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}`;
    const type = part.filename ? '\r\nContent-Type: application/octet-stream' : '';
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n`), Buffer.from(part.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

// Every request gets its own client address so the per-client upload rate limit never trips.
function post(app: App, url: string, parts: Parameters<typeof multipart>[0]) {
  clientNumber += 1;
  return app.inject({
    method: 'POST', url, payload: multipart(parts), remoteAddress: `10.0.0.${clientNumber}`,
    headers: { ...auth, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
}

test('lists the built-in default skin and uploaded skins', async () => {
  await withServer(async (app, skins) => {
    const empty = await app.inject({ method: 'GET', url: '/api/skins', headers: auth });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.headers['cache-control'], 'no-store');
    assert.deepEqual(empty.json(), { skins: [{ name: 'default' }] });
    const osk = storeZip([{ name: 'Cool Skin/' }, { name: 'Cool Skin/skin.ini', data: '[General]' }]);
    const upload = await post(app, '/api/skins', [{ name: 'skin', filename: 'Cool Skin.osk', data: osk }]);
    assert.equal(upload.statusCode, 200, upload.body);
    assert.deepEqual(upload.json(), { name: 'Cool Skin' });
    assert.equal(await readFile(path.join(skins, 'Cool Skin', 'skin.ini'), 'utf8'), '[General]');
    assert.deepEqual(await readdir(path.join(skins, SKIN_STAGING_DIR)), []);
    const listed = await app.inject({ method: 'GET', url: '/api/skins', headers: auth });
    assert.deepEqual(listed.json(), { skins: [{ name: 'default' }, { name: 'Cool Skin' }] });
  });
});

test('rejects uploads that are not usable .osk skins', async () => {
  await withServer(async (app, skins) => {
    const osk = storeZip([{ name: 'skin.ini' }]);
    const cases: Array<[string, Parameters<typeof multipart>[0]]> = [
      ['wrong field', [{ name: 'replay', filename: 'a.osk', data: osk }]],
      ['wrong extension', [{ name: 'skin', filename: 'a.zip', data: osk }]],
      ['reserved name', [{ name: 'skin', filename: 'default.osk', data: osk }]],
      ['not a zip', [{ name: 'skin', filename: 'a.osk', data: 'nope' }]],
      ['traversal', [{ name: 'skin', filename: 'a.osk', data: storeZip([{ name: '../evil.ini' }]) }]],
    ];
    for (const [label, parts] of cases) {
      const response = await post(app, '/api/skins', parts);
      assert.equal(response.json().error?.code, 'SKIN_INVALID', label);
      assert.equal(response.statusCode, 422, label);
    }
    assert.deepEqual((await readdir(skins)).filter((name) => name !== SKIN_STAGING_DIR), []);
    assert.deepEqual(await readdir(path.join(skins, SKIN_STAGING_DIR)), []);
  });
});

test('rejects .osk uploads over the configured size limit', async () => {
  await withServer(async (app, skins) => {
    const data = Buffer.alloc(appConfig.skins.maxOskBytes + 1);
    const response = await post(app, '/api/skins', [{ name: 'skin', filename: 'huge.osk', data }]);
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, 'SKIN_TOO_LARGE');
    assert.deepEqual(await readdir(path.join(skins, SKIN_STAGING_DIR)), []);
  });
});

test('skin uploads share the per-client upload rate limit', async () => {
  await withServer(async (app) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST', url: '/api/skins', remoteAddress: '10.9.9.9',
        payload: multipart([{ name: 'skin', filename: 'a.zip', data: 'x' }]),
        headers: { ...auth, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      });
      statuses.push(response.statusCode);
    }
    assert.deepEqual(statuses.slice(0, 5), [422, 422, 422, 422, 422]);
    assert.equal(statuses[5], 429);
  });
});

test('render submissions must pick an installed skin', async () => {
  await withServer(async (app, skins, created) => {
    const replay = { name: 'replay', filename: 'play.osr', data: 'not parsed before the skin check' };
    const missing = await post(app, '/api/renders', [{ name: 'options', data: '{"skin":"Nope"}' }, replay]);
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, 'INVALID_OPTIONS');
    assert.match(missing.json().error.message, /not installed/);
    const traversal = await post(app, '/api/renders', [{ name: 'options', data: '{"skin":"../x"}' }, replay]);
    assert.equal(traversal.json().error.code, 'INVALID_OPTIONS');
    await mkdir(path.join(skins, 'Nope'));
    await writeFile(path.join(skins, 'Nope', 'skin.ini'), '');
    const installed = await post(app, '/api/renders', [{ name: 'options', data: '{"skin":"Nope"}' }, replay]);
    // The skin passes; the fake replay is what fails next.
    assert.equal(installed.json().error.code, 'INVALID_REPLAY');
    assert.deepEqual(created, []);
  });
});
