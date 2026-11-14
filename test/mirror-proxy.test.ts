import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, appConfig } from '../src/app-config.js';
import { HttpBeatmapMirror, mirrorDispatcher, parseProxyUrl } from '../src/mirrors.js';

interface ProxyModule {
  DEFAULT_ALLOW: string[];
  parseConnectTarget(target: unknown, ports?: number[]): { host: string; port: number } | null;
  isAllowed(host: string, allow: string[]): boolean;
  parseListen(value: string | undefined): { host: string; port: number };
  createProxy(options: { allow?: string[]; ports?: number[]; max?: number; idleMs?: number; log?: (entry: Record<string, unknown>) => void }): Server;
}

const load = async (): Promise<ProxyModule> =>
  await import(pathToFileURL(path.join(APP_ROOT, 'scripts', 'mirror-proxy.mjs')).href) as ProxyModule;

const listen = (server: Server): Promise<number> => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});
const close = (server: Server): Promise<void> => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

test('parseConnectTarget accepts hostnames on allowed ports only', async () => {
  const { parseConnectTarget } = await load();
  assert.deepEqual(parseConnectTarget('catboy.best:443'), { host: 'catboy.best', port: 443 });
  assert.deepEqual(parseConnectTarget('CatBoy.Best.:443'), { host: 'catboy.best', port: 443 });
  assert.deepEqual(parseConnectTarget('localhost:8080', [8080]), { host: 'localhost', port: 8080 });
  for (const bad of ['catboy.best:80', 'catboy.best', '195.3.222.136:443', '[::1]:443', 'a b:443', '', undefined, 443]) {
    assert.equal(parseConnectTarget(bad), null, String(bad));
  }
});

test('isAllowed matches exact names, not subdomains or suffixes', async () => {
  const { isAllowed, DEFAULT_ALLOW } = await load();
  assert.equal(isAllowed('catboy.best', DEFAULT_ALLOW), true);
  assert.equal(isAllowed('evil.catboy.best', DEFAULT_ALLOW), false);
  assert.equal(isAllowed('catboy.best.evil.com', DEFAULT_ALLOW), false);
  assert.equal(isAllowed('osu.ppy.sh', DEFAULT_ALLOW), false);
  assert.equal(isAllowed('', DEFAULT_ALLOW), false);
});

test('the proxy allowlist covers every built-in mirror host', async () => {
  const { DEFAULT_ALLOW } = await load();
  for (const template of appConfig.mirrors.fallback) {
    const host = new URL(template.replace('{id}', '1')).hostname;
    assert(DEFAULT_ALLOW.includes(host), `${host} is missing from DEFAULT_ALLOW`);
  }
});

test('parseListen needs host:port', async () => {
  const { parseListen } = await load();
  assert.deepEqual(parseListen('100.121.52.116:8319'), { host: '100.121.52.116', port: 8319 });
  assert.deepEqual(parseListen('[fd7a::1]:8319'), { host: 'fd7a::1', port: 8319 });
  assert.throws(() => parseListen(undefined), /host:port/);
  assert.throws(() => parseListen('8319'), /host:port/);
});

test('parseProxyUrl validates MIRROR_PROXY', () => {
  assert.equal(parseProxyUrl(undefined), undefined);
  assert.equal(parseProxyUrl('  '), undefined);
  assert.equal(parseProxyUrl('http://100.121.52.116:8319'), 'http://100.121.52.116:8319/');
  assert.equal(parseProxyUrl('https://user:pass@proxy.example:3128/'), 'https://user:pass@proxy.example:3128/');
  for (const bad of ['proxy:8319', 'socks5://127.0.0.1:1080', 'http://proxy/path', 'http://proxy:1?x=1', 'not a url']) {
    assert.throws(() => parseProxyUrl(bad), /MIRROR_PROXY/, bad);
  }
});

test('mirror downloads go through the proxy and blocked targets are refused', async () => {
  const { createProxy } = await load();
  const mirror = createServer((_request, response) => { response.writeHead(200).end('PK\x03\x04 proxied archive'); });
  const mirrorPort = await listen(mirror);
  const events: Array<Record<string, unknown>> = [];
  const proxy = createProxy({ allow: ['localhost'], ports: [mirrorPort], log: (entry) => events.push(entry) });
  const proxyPort = await listen(proxy);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-proxy-'));
  const dispatcher = mirrorDispatcher({ connectTimeoutMs: 5000, proxy: `http://127.0.0.1:${proxyPort}` });
  try {
    const allowed = new HttpBeatmapMirror(`http://localhost:${mirrorPort}/d/{id}`, 10_000, dispatcher);
    await allowed.downloadBeatmapset(1, path.join(directory, 'ok.osz'), 1024);
    assert.equal(await readFile(path.join(directory, 'ok.osz'), 'utf8'), 'PK\x03\x04 proxied archive');
    assert(events.some((entry) => entry.event === 'tunnel' && entry.host === 'localhost'));

    const blocked = new HttpBeatmapMirror(`http://127.0.0.1:${mirrorPort}/d/{id}`, 10_000, dispatcher);
    await assert.rejects(blocked.downloadBeatmapset(1, path.join(directory, 'blocked.osz'), 1024));
    assert(events.some((entry) => entry.event === 'refused'));

    const plain = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port: proxyPort, path: 'http://localhost/', method: 'GET' }, (response) => {
        response.resume(); resolve(response.statusCode ?? 0);
      }).on('error', reject).end();
    });
    assert.equal(plain, 405, 'plain HTTP proxying is not offered');
  } finally {
    await dispatcher.close();
    await close(proxy);
    await close(mirror);
    await rm(directory, { recursive: true, force: true });
  }
});

test('mirror downloads without a proxy still use the longer connect limit', async () => {
  const mirror = createServer((_request, response) => { response.writeHead(200).end('direct'); });
  const port = await listen(mirror);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-direct-'));
  const dispatcher = mirrorDispatcher({ connectTimeoutMs: 30_000 });
  try {
    await new HttpBeatmapMirror(`http://127.0.0.1:${port}/d/{id}`, 10_000, dispatcher)
      .downloadBeatmapset(1, path.join(directory, 'a.osz'), 1024);
    assert.equal(await readFile(path.join(directory, 'a.osz'), 'utf8'), 'direct');
  } finally {
    await dispatcher.close();
    await close(mirror);
    await rm(directory, { recursive: true, force: true });
  }
});
