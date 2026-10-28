import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { DEFAULTS_FILE, appConfig, deepMerge, validateAppConfig } from '../src/app-config.js';
import { settings } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createHttpServer, type HttpDependencies } from '../src/http.js';
import {
  LAUNCHER_ENV, Updater, compareVersions, isAllowedDownloadUrl, isPortableLayout, parseChecksumFile, selectAssets,
  type LatestRelease, type UpdaterOptions,
} from '../src/updater.js';

const NEW = '0.5.0';
const ZIP_NAME = `osu-render-${NEW}-win-x64.zip`;
const ZIP_URL = `https://github.com/956zs/osu-render/releases/download/v${NEW}/${ZIP_NAME}`;
const CDN_URL = `https://objects.githubusercontent.com/release/${ZIP_NAME}`;
const API_URL = 'https://api.github.com/repos/956zs/osu-render/releases/latest';
const SUPERVISED = { [LAUNCHER_ENV]: 'start.bat' };

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

function releaseZip(version = NEW, danser = '0.12.1'): Buffer {
  return storeZip([
    { name: 'osu-render/' },
    { name: 'osu-render/VERSION.json', data: JSON.stringify({ app: version, node: 'v24.0.0', danser }) },
    { name: 'osu-render/start.bat', data: '@echo off\r\n' },
    { name: 'osu-render/runtime/node.exe', data: 'MZ' },
    { name: 'osu-render/dist/src/main.js', data: '' },
    { name: 'osu-render/scripts/windows/apply-update.ps1', data: '' },
  ]);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function releaseJson(zip: Buffer, extraAssets: object[] = []): object {
  return {
    tag_name: `v${NEW}`,
    html_url: `https://github.com/956zs/osu-render/releases/tag/v${NEW}`,
    assets: [
      ...extraAssets,
      { name: ZIP_NAME, browser_download_url: ZIP_URL, size: zip.length },
      { name: `${ZIP_NAME}.sha256`, browser_download_url: `${ZIP_URL}.sha256`, size: 90 },
    ],
  };
}

interface FakeNetwork { routes: Map<string, () => Response>; calls: string[]; fetch: UpdaterOptions['fetch'] }

/** Serves a fake GitHub: API JSON, a redirect to the CDN for the zip, and the checksum file. No real network. */
function fakeNetwork(zip = releaseZip(), checksum = `${sha256(zip)}  ${ZIP_NAME}\n`): FakeNetwork {
  const routes = new Map<string, () => Response>([
    [API_URL, () => Response.json(releaseJson(zip))],
    [ZIP_URL, () => new Response(null, { status: 302, headers: { location: CDN_URL } })],
    [CDN_URL, () => new Response(new Uint8Array(zip), { headers: { 'content-length': String(zip.length) } })],
    [`${ZIP_URL}.sha256`, () => new Response(checksum)],
  ]);
  const calls: string[] = [];
  return {
    routes, calls,
    fetch: async (url) => {
      calls.push(url);
      const route = routes.get(url);
      return route ? route() : new Response('not found', { status: 404 });
    },
  };
}

async function withAppRoot(run: (root: string) => Promise<void>, portable = true): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osu-render-updater-'));
  if (portable) {
    await mkdir(path.join(root, 'runtime'));
    await writeFile(path.join(root, 'runtime', 'node.exe'), 'MZ');
    await writeFile(path.join(root, 'start.bat'), '@echo off\r\n');
    await writeFile(path.join(root, 'VERSION.json'), JSON.stringify({ app: '0.4.0', node: 'v24.0.0', danser: '0.12.1' }));
  } else {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  }
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function makeUpdater(root: string, overrides: Partial<UpdaterOptions> = {}): Updater & { restarts: number } {
  const state = { restarts: 0 };
  const updater = new Updater({
    appRoot: root, platform: 'win32', env: SUPERVISED, fetch: fakeNetwork().fetch,
    isBusy: () => false, restart: () => { state.restarts += 1; },
    ...overrides,
  });
  return Object.defineProperty(updater, 'restarts', { get: () => state.restarts }) as Updater & { restarts: number };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);
}

test('compareVersions follows semver precedence', () => {
  assert.ok(compareVersions('0.5.0', '0.4.0') > 0);
  assert.ok(compareVersions('0.4.0', '0.10.0') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.ok(compareVersions('0.4.0', '0.4.0-abc1234') > 0, 'a release is newer than a CI build of it');
  assert.ok(compareVersions('0.4.0-alpha', '0.4.0-alpha.1') < 0);
  assert.ok(compareVersions('0.4.0-alpha.2', '0.4.0-alpha.10') < 0);
  assert.ok(compareVersions('0.4.0-1', '0.4.0-alpha') < 0, 'numeric identifiers sort before alphanumeric ones');
  assert.ok(compareVersions('0.4.0', 'garbage') > 0);
  assert.equal(compareVersions('', 'v1'), 0);
});

test('selectAssets picks the zip and checksum by exact name only', () => {
  const zip = releaseZip();
  const body = releaseJson(zip, [
    { name: `evil-${ZIP_NAME}`, browser_download_url: 'https://github.com/x', size: 1 },
    { name: `${ZIP_NAME}.sig`, browser_download_url: 'https://github.com/y', size: 1 },
  ]) as { assets: Array<{ name: string; browser_download_url: string; size: number }> };
  const release: LatestRelease = {
    version: NEW, notesUrl: '', assets: body.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size })),
  };
  const selected = selectAssets(release);
  assert.equal(selected.zip.url, ZIP_URL);
  assert.equal(selected.checksum.url, `${ZIP_URL}.sha256`);
  assert.throws(() => selectAssets({ ...release, assets: release.assets.filter((asset) => !asset.name.endsWith('.sha256')) }));
  assert.throws(() => selectAssets({ ...release, version: '0.6.0' }));
  assert.throws(() => selectAssets({ ...release, assets: [] }));
});

test('download URLs must be https on an allowlisted host', () => {
  const hosts = appConfig.update.downloadHosts;
  assert.ok(isAllowedDownloadUrl(ZIP_URL, hosts));
  assert.ok(isAllowedDownloadUrl(CDN_URL, hosts));
  assert.ok(isAllowedDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1', hosts));
  for (const url of [
    'http://github.com/956zs/osu-render', 'https://github.com.evil.example/x', 'https://evil.example/github.com',
    'https://user:pass@github.com/x', 'https://github.com:8443/x', 'https://api.github.com/x', 'ftp://github.com/x',
    'not a url', '',
  ]) {
    assert.equal(isAllowedDownloadUrl(url, hosts), false, url);
  }
});

test('parseChecksumFile accepts sha256sum output for the expected file only', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseChecksumFile(`${hash}  ${ZIP_NAME}\n`, ZIP_NAME), hash);
  assert.equal(parseChecksumFile(`${hash.toUpperCase()} *${ZIP_NAME}\r\n`, ZIP_NAME), hash);
  assert.equal(parseChecksumFile(`\n${hash}\n`, ZIP_NAME), hash);
  assert.throws(() => parseChecksumFile(`${hash}  other.zip\n`, ZIP_NAME));
  assert.throws(() => parseChecksumFile('abc  file.zip', ZIP_NAME));
  assert.throws(() => parseChecksumFile('', ZIP_NAME));
});

test('portable mode needs the portable layout, Windows and start.bat as the launcher', async () => {
  await withAppRoot(async (root) => {
    assert.equal(isPortableLayout(root), true);
    assert.equal(makeUpdater(root).portable, true);
    assert.equal(makeUpdater(root, { platform: 'linux' }).portable, false);
    assert.equal(makeUpdater(root, { env: {} }).portable, false);
    await rm(path.join(root, 'VERSION.json'));
    assert.equal(isPortableLayout(root), false);
    assert.equal(makeUpdater(root).portable, false);
  });
  await withAppRoot(async (root) => {
    assert.equal(isPortableLayout(root), false);
    assert.equal(makeUpdater(root).current, '0.4.0', 'source installs read package.json');
  }, false);
});

test('checkLatest reports a newer release and caches it', async () => {
  await withAppRoot(async (root) => {
    const network = fakeNetwork();
    let now = 1_000;
    const updater = makeUpdater(root, { fetch: network.fetch, now: () => now });
    const status = await updater.checkLatest();
    assert.deepEqual(status, {
      current: '0.4.0', latest: NEW, available: true, portable: true, enabled: true,
      notesUrl: `https://github.com/956zs/osu-render/releases/tag/v${NEW}`, checkedAt: 1_000,
    });
    await Promise.all([updater.checkLatest(), updater.checkLatest()]);
    assert.equal(network.calls.length, 1);
    now += appConfig.update.checkIntervalMs;
    await updater.checkLatest();
    assert.equal(network.calls.length, 2);
  });
});

test('checkLatest never throws and reports errors', async () => {
  await withAppRoot(async (root) => {
    const offline = makeUpdater(root, { fetch: async () => { throw new TypeError('fetch failed'); } });
    const status = await offline.checkLatest();
    assert.equal(status.error, 'fetch failed');
    assert.equal(status.available, false);
    assert.equal(status.latest, null);

    const limited = makeUpdater(root, { fetch: async () => new Response('{}', { status: 403 }) });
    assert.match((await limited.checkLatest()).error ?? '', /HTTP 403/);

    const garbage = makeUpdater(root, { fetch: async () => Response.json({ tag_name: 'nightly' }) });
    assert.match((await garbage.checkLatest()).error ?? '', /invalid tag/);

    const none = makeUpdater(root, { fetch: async () => new Response('{}', { status: 404 }) });
    const noRelease = await none.checkLatest();
    assert.equal(noRelease.error, undefined);
    assert.equal(noRelease.latest, null);

    const older = makeUpdater(root, { fetch: async () => Response.json({ tag_name: 'v0.3.0', assets: [] }) });
    assert.equal((await older.checkLatest()).available, false);
  });
});

test('disabled checks never touch the network', async () => {
  await withAppRoot(async (root) => {
    const network = fakeNetwork();
    const updater = makeUpdater(root, { fetch: network.fetch, config: { ...appConfig.update, enabled: false } });
    const status = await updater.checkLatest(true);
    assert.equal(status.enabled, false);
    assert.equal(status.available, false);
    assert.equal(network.calls.length, 0);
  });
});

test('apply downloads through allowlisted redirects, verifies, stages and arms the restart', async () => {
  await withAppRoot(async (root) => {
    const network = fakeNetwork();
    const updater = makeUpdater(root, { fetch: network.fetch });
    assert.deepEqual(await updater.apply(), { applying: true, version: NEW });
    assert.equal(updater.applying, true);
    assert.deepEqual(network.calls, [API_URL, `${ZIP_URL}.sha256`, ZIP_URL, CDN_URL]);
    const pending = JSON.parse(await readFile(path.join(root, 'data', 'update', 'pending.json'), 'utf8'));
    assert.equal(pending.version, NEW);
    assert.equal(pending.from, '0.4.0');
    const staged = JSON.parse(await readFile(path.join(root, 'data', 'update', 'staging', NEW, 'osu-render', 'VERSION.json'), 'utf8'));
    assert.equal(staged.app, NEW);
    assert.equal(existsSync(path.join(root, 'data', 'update', 'downloads')), false, 'downloads are removed');
    assert.equal(updater.restarts, 0);
    updater.restartIfPending();
    updater.restartIfPending();
    assert.equal(updater.restarts, 1);
    await rejectsWith(updater.apply(), 'UPDATE_BUSY');
  });
});

async function assertFailsCleanly(network: FakeNetwork, configOverride: Partial<UpdaterOptions['config']> = {}): Promise<void> {
  await withAppRoot(async (root) => {
    const updater = makeUpdater(root, { fetch: network.fetch, config: { ...appConfig.update, ...configOverride } });
    await rejectsWith(updater.apply(), 'UPDATE_FAILED');
    assert.equal(updater.applying, false);
    assert.equal(existsSync(path.join(root, 'data', 'update', 'pending.json')), false);
    assert.equal(existsSync(path.join(root, 'data', 'update', 'staging')), false);
    updater.restartIfPending();
    assert.equal(updater.restarts, 0);
  });
}

test('apply rejects a zip whose sha256 does not match', async () => {
  await assertFailsCleanly(fakeNetwork(releaseZip(), `${'0'.repeat(64)}  ${ZIP_NAME}\n`));
});

test('apply rejects a checksum file for another file', async () => {
  const zip = releaseZip();
  await assertFailsCleanly(fakeNetwork(zip, `${sha256(zip)}  osu-render-9.9.9-win-x64.zip\n`));
});

test('apply refuses redirects to hosts outside the allowlist', async () => {
  const network = fakeNetwork();
  network.routes.set(ZIP_URL, () => new Response(null, { status: 302, headers: { location: 'https://evil.example/osu-render.zip' } }));
  await assertFailsCleanly(network);
  assert.ok(!network.calls.includes('https://evil.example/osu-render.zip'));
});

test('apply refuses assets that are not on an allowlisted host', async () => {
  const zip = releaseZip();
  const network = fakeNetwork(zip);
  network.routes.set(API_URL, () => Response.json({
    tag_name: `v${NEW}`, html_url: 'https://github.com/956zs/osu-render/releases',
    assets: [
      { name: ZIP_NAME, browser_download_url: `http://github.com/download/${ZIP_NAME}`, size: zip.length },
      { name: `${ZIP_NAME}.sha256`, browser_download_url: `${ZIP_URL}.sha256`, size: 90 },
    ],
  }));
  await assertFailsCleanly(network);
});

test('apply enforces the download size limit', async () => {
  await assertFailsCleanly(fakeNetwork(), { maxDownloadBytes: 100 });
});

test('apply rejects a release zip whose VERSION.json names another version', async () => {
  await assertFailsCleanly(fakeNetwork(releaseZip('0.4.9')));
});

test('apply rejects a release zip with unsafe paths', async () => {
  const zip = storeZip([{ name: 'osu-render/../escape.txt', data: 'x' }]);
  await assertFailsCleanly(fakeNetwork(zip));
});

test('apply refuses when not portable or while a render is active', async () => {
  await withAppRoot(async (root) => {
    const network = fakeNetwork();
    await rejectsWith(makeUpdater(root, { fetch: network.fetch, platform: 'linux' }).apply(), 'UPDATE_NOT_PORTABLE');
    await rejectsWith(makeUpdater(root, { fetch: network.fetch, env: {} }).apply(), 'UPDATE_NOT_PORTABLE');
    const busy = makeUpdater(root, { fetch: network.fetch, isBusy: () => true });
    await rejectsWith(busy.apply(), 'UPDATE_BUSY');
    assert.equal(busy.applying, false);
    assert.equal(network.calls.length, 0);
  });
  await withAppRoot(async (root) => {
    await rejectsWith(makeUpdater(root).apply(), 'UPDATE_NOT_PORTABLE');
  }, false);
});

test('apply refuses when there is nothing newer', async () => {
  await withAppRoot(async (root) => {
    const updater = makeUpdater(root, { fetch: async () => Response.json({ tag_name: 'v0.4.0', assets: [] }) });
    await rejectsWith(updater.apply(), 'UPDATE_FAILED');
    assert.equal(updater.applying, false);
  });
});

const auth = settings.authToken ? { authorization: `Bearer ${settings.authToken}` } : {};

async function withUpdateServer(updater: Updater, run: (app: Awaited<ReturnType<typeof createHttpServer>>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-update-http-'));
  const dependencies = {
    database: { queuedCount: () => 0, activeCountForClient: () => 0, activeCount: () => 0 },
    queue: {}, storage: {}, preflight: {}, preflightState: {},
    paths: { replays: directory, videos: directory, data: directory, logs: directory },
    updater,
  } as unknown as HttpDependencies;
  const app = await createHttpServer(dependencies);
  try { await run(app); } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('GET /api/update reports the status and POST /api/update/apply restarts after responding', async () => {
  await withAppRoot(async (root) => {
    const updater = makeUpdater(root);
    await withUpdateServer(updater, async (app) => {
      const status = await app.inject({ method: 'GET', url: '/api/update', headers: auth });
      assert.equal(status.statusCode, 200);
      assert.equal(status.headers['cache-control'], 'no-store');
      assert.equal(status.json().available, true);
      assert.equal(status.json().latest, NEW);
      assert.equal(status.json().current, '0.4.0');

      const applied = await app.inject({ method: 'POST', url: '/api/update/apply', headers: auth });
      assert.equal(applied.statusCode, 200);
      assert.deepEqual(applied.json(), { applying: true, version: NEW });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(updater.restarts, 1);

      const render = await app.inject({ method: 'POST', url: '/api/renders', headers: auth });
      assert.equal(render.statusCode, 503, 'no new renders while the update installs');
      assert.equal(render.json().error.code, 'RENDERER_UNAVAILABLE');
    });
  });
});

test('POST /api/update/apply maps refusals to error codes without restarting', async () => {
  await withAppRoot(async (root) => {
    for (const [overrides, code] of [
      [{ platform: 'linux' as const }, 'UPDATE_NOT_PORTABLE'],
      [{ isBusy: () => true }, 'UPDATE_BUSY'],
      [{ fetch: fakeNetwork(releaseZip(), `${'f'.repeat(64)}  ${ZIP_NAME}\n`).fetch }, 'UPDATE_FAILED'],
    ] as const) {
      const updater = makeUpdater(root, overrides);
      await withUpdateServer(updater, async (app) => {
        const response = await app.inject({ method: 'POST', url: '/api/update/apply', headers: auth });
        assert.equal(response.json().error.code, code);
        assert.ok(response.statusCode >= 400);
        assert.ok(!JSON.stringify(response.json()).includes(root), 'no local paths in the error');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(updater.restarts, 0);
      });
    }
  });
});

test('update settings are validated', () => {
  const defaults = JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8')) as Record<string, unknown>;
  const withUpdate = (update: Record<string, unknown>): unknown => deepMerge(defaults, { update });
  assert.equal(validateAppConfig(defaults).update.repo, '956zs/osu-render');
  assert.throws(() => validateAppConfig(withUpdate({ enabled: 'yes' })), /update\.enabled must be true or false/);
  assert.throws(() => validateAppConfig(withUpdate({ repo: 'https://github.com/956zs/osu-render' })), /update\.repo/);
  assert.throws(() => validateAppConfig(withUpdate({ downloadHosts: ['https://github.com'] })), /update\.downloadHosts/);
  assert.throws(() => validateAppConfig(withUpdate({ checkIntervalMs: 1000 })), /update\.checkIntervalMs/);
  assert.throws(() => validateAppConfig(withUpdate({ autoApply: true })), /update\.autoApply is not a known setting/);
});
