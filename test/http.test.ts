import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { settings } from '../src/config.js';
import { createHttpServer, type HttpDependencies } from '../src/http.js';
import type { PreflightResult } from '../src/types.js';

const READY: PreflightResult = { renderer: true, display: true, encoder: 'libx264', probes: [] };

async function withServer(run: (app: Awaited<ReturnType<typeof createHttpServer>>, counters: { probeAll: number }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-http-'));
  const counters = { probeAll: 0 };
  const dependencies = {
    database: { recentRenders: () => [], queuedCount: () => 0 },
    queue: {},
    storage: { freeBytes: async () => 1024 ** 4 },
    preflight: {
      run: async () => READY,
      probeAll: async () => {
        counters.probeAll += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ encoder: 'libx264', ok: true, durationMs: 1 }];
      },
      tools: async () => ({
        danserCli: path.join(directory, 'danser-cli'), ffmpeg: path.join(directory, 'ffmpeg'),
        ffprobe: path.join(directory, 'ffprobe'), libraryDirs: [], layout: 'path', offscreenCapable: false,
      }),
      health: async () => ({ status: 'ok' }),
    },
    preflightState: { current: () => READY, refreshIfNeeded: async () => READY },
    paths: { replays: directory, videos: directory, data: directory, logs: directory },
  } as unknown as HttpDependencies;
  const app = await createHttpServer(dependencies);
  try { await run(app, counters); } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const auth = settings.authToken ? { authorization: `Bearer ${settings.authToken}` } : {};

test('serves allowlisted i18n files only', async () => {
  await withServer(async (app) => {
    const ok = await app.inject({ method: 'GET', url: '/i18n/zh-TW.json' });
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers['content-type']), /^application\/json/);
    assert.equal(typeof ok.json(), 'object');
    for (const url of ['/i18n/fr.json', '/i18n/en', '/i18n/..%2Fpackage.json', '/i18n/..%2F..%2Fpackage.json', '/i18n/%2E%2E%2Fen.json', '/i18n/../package.json']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
      assert.ok(!response.body.includes('"version"'), url);
    }
  });
});

test('diagnostics endpoint shares one in-flight collection', async () => {
  await withServer(async (app, counters) => {
    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/diagnostics', headers: auth }),
      app.inject({ method: 'GET', url: '/api/diagnostics', headers: auth }),
    ]);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(counters.probeAll, 1);
    assert.equal(first.json().schema, 1);
    assert.equal(first.json().preflight.encoder, 'libx264');
    await app.inject({ method: 'GET', url: '/api/diagnostics', headers: auth });
    assert.equal(counters.probeAll, 2);
  });
});
