import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { settings } from '../src/config.js';
import { createHttpServer, type HttpDependencies } from '../src/http.js';
import type { PreflightResult } from '../src/types.js';

const READY: PreflightResult = { renderer: true, display: true, encoder: 'libx264', probes: [] };

async function withServer(
  run: (app: Awaited<ReturnType<typeof createHttpServer>>, counters: { probeAll: number }) => Promise<void>,
  rendering = false,
  reporter?: HttpDependencies['reporter'],
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-http-'));
  const counters = { probeAll: 0 };
  const dependencies = {
    database: {
      recentRenders: () => [], queuedCount: () => 0,
      db: { prepare: () => ({ get: () => (rendering ? { 1: 1 } : undefined) }) },
    },
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
    reporter,
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

test('diagnostics endpoint shares one in-flight collection and caches the report', async () => {
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
    const cached = await app.inject({ method: 'GET', url: '/api/diagnostics', headers: auth });
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.json().generatedAt, first.json().generatedAt);
    assert.equal(counters.probeAll, 1);
    assert.equal(first.json().probesSkipped, undefined);
  });
});

test('diagnostics endpoint skips encoder probes while a render is active', async () => {
  await withServer(async (app, counters) => {
    const response = await app.inject({ method: 'GET', url: '/api/diagnostics', headers: auth });
    assert.equal(response.statusCode, 200);
    assert.equal(counters.probeAll, 0);
    assert.equal(response.json().probesSkipped, 'render_active');
    assert.deepEqual(response.json().encoderProbes, []);
  }, true);
});

test('health reports whether webhook reporting is enabled', async () => {
  await withServer(async (app) => {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/health' })).json(), { status: 'ok', reportWebhook: false, bloomOffProfiles: ['fast'] });
  });
  await withServer(async (app) => {
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().reportWebhook, true);
  }, false, { send: async () => undefined });
});

test('send to developer is rejected when no webhook is configured', async () => {
  await withServer(async (app, counters) => {
    const response = await app.inject({ method: 'POST', url: '/api/diagnostics/send', headers: auth });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'REPORT_WEBHOOK_DISABLED');
    assert.equal(counters.probeAll, 0);
  });
});

test('send to developer posts the shared report once per click burst', async () => {
  const sent: Array<{ trigger: string; schema: number }> = [];
  const reporter: HttpDependencies['reporter'] = {
    send: async (report, trigger) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sent.push({ trigger, schema: report.schema });
    },
  };
  await withServer(async (app, counters) => {
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/diagnostics/send', headers: auth }),
      app.inject({ method: 'POST', url: '/api/diagnostics/send', headers: auth }),
    ]);
    assert.deepEqual(first.json(), { sent: true });
    assert.deepEqual(second.json(), { sent: true });
    assert.deepEqual(sent, [{ trigger: 'manual', schema: 1 }]);
    assert.equal(counters.probeAll, 1);
    const cached = await app.inject({ method: 'GET', url: '/api/diagnostics', headers: auth });
    assert.equal(cached.statusCode, 200);
    assert.equal(counters.probeAll, 1);
  }, false, reporter);
});

test('send to developer surfaces REPORT_SEND_FAILED without internals', async () => {
  const { ReportSendError } = await import('../src/report-webhook.js');
  const reporter: HttpDependencies['reporter'] = { send: async () => { throw new ReportSendError('HTTP 404: Unknown Webhook'); } };
  await withServer(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/api/diagnostics/send', headers: auth });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: { code: 'REPORT_SEND_FAILED', message: 'The report could not be sent to the developer.' } });
  }, false, reporter);
});

test('page assets come from an allowlist with a strict content security policy', async () => {
  await withServer(async (app) => {
    for (const [url, type] of [['/', /^text\/html/], ['/app.css', /^text\/css/], ['/app.js', /^text\/javascript/]] as const) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, url);
      assert.match(String(response.headers['content-type']), type, url);
      assert.equal(response.headers['cache-control'], 'no-cache', url);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', url);
      const csp = String(response.headers['content-security-policy']);
      for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "connect-src 'self'"]) {
        assert.ok(csp.includes(directive), `${url}: ${directive}`);
      }
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    }
    for (const url of ['/app.ts', '/index.html', '/../package.json', '/%2E%2E/package.json', '/public/app.js', '/i18n/app.js']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
      assert.ok(!response.body.includes('"version"'), url);
    }
  });
});
