import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { appConfig, APP_ROOT, type AppConfig } from './app-config.js';
import { extractOsz } from './archive.js';
import { AppError } from './errors.js';
import { log } from './logger.js';

/** start.bat runs apply-update.ps1 and relaunches when node exits with this code. */
export const UPDATE_EXIT_CODE = 75;
/** start.bat sets OSU_RENDER_LAUNCHER to this value; without it nothing would restart the server after exit 75. */
export const LAUNCHER_ENV = 'OSU_RENDER_LAUNCHER';
const LAUNCHER_VALUE = 'start.bat';
const PORTABLE_MARKERS = ['runtime/node.exe', 'start.bat', 'VERSION.json'];
const STAGED_REQUIRED = ['VERSION.json', 'start.bat', 'runtime/node.exe', 'dist/src/main.js', 'scripts/windows/apply-update.ps1'];
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CHECKSUM_BYTES = 4096;
const MAX_REDIRECTS = 5;

type UpdateConfig = AppConfig['update'];
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface VersionInfo { app: string; node?: string; danser?: string }

export interface ReleaseAsset { name: string; url: string; size: number }

export interface LatestRelease { version: string; notesUrl: string; assets: ReleaseAsset[] }

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  portable: boolean;
  enabled: boolean;
  notesUrl: string | null;
  checkedAt: number | null;
  error?: string;
}

export interface UpdaterOptions {
  /** Defaults to the folder that holds config/defaults.json. */
  appRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  config?: Readonly<UpdateConfig>;
  fetch?: FetchLike;
  now?: () => number;
  /** True while any render job is unfinished. */
  isBusy: () => boolean;
  /** Called once the apply response was sent: close the server and exit with UPDATE_EXIT_CODE. */
  restart: () => void;
}

export function parseVersion(value: string): { core: [number, number, number]; pre: string[] } | null {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. Unparsable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function assetNames(version: string): { zip: string; checksum: string } {
  const zip = `osu-render-${version}-win-x64.zip`;
  return { zip, checksum: `${zip}.sha256` };
}

/** Picks the zip and its .sha256 by exact name; any other asset (or a look-alike name) is ignored. */
export function selectAssets(release: LatestRelease): { zip: ReleaseAsset; checksum: ReleaseAsset } {
  const names = assetNames(release.version);
  const zip = release.assets.find((asset) => asset.name === names.zip);
  const checksum = release.assets.find((asset) => asset.name === names.checksum);
  if (!zip || !checksum) throw new Error(`release ${release.version} has no ${names.zip} with a .sha256 file`);
  return { zip, checksum };
}

export function isAllowedDownloadUrl(value: string, hosts: readonly string[]): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === ''
    && hosts.includes(url.hostname.toLowerCase());
}

/** Reads "<hex>  <file name>" (sha256sum format). The name, when present, must be the expected zip. */
export function parseChecksumFile(text: string, expectedName: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== '') ?? '';
  const [hash, name] = line.trim().split(/\s+\*?/, 2);
  const normalized = (hash ?? '').toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error('checksum file is malformed');
  if (name !== undefined && name !== expectedName) throw new Error('checksum file names a different file');
  return normalized;
}

/** Portable zip = bundled Node runtime + start.bat + VERSION.json next to each other. */
export function isPortableLayout(appRoot: string): boolean {
  return PORTABLE_MARKERS.every((marker) => existsSync(path.join(appRoot, ...marker.split('/'))));
}

export function readVersionInfo(appRoot: string): VersionInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(appRoot, 'VERSION.json'), 'utf8')) as Partial<VersionInfo>;
    return typeof parsed.app === 'string' && parsed.app !== '' ? parsed as VersionInfo : null;
  } catch { return null; }
}

function currentVersion(appRoot: string): string {
  const info = readVersionInfo(appRoot);
  if (info) return info.app;
  try {
    const pkg = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch { /* fall through */ }
  return '0.0.0';
}

/**
 * Extracts a release zip with the hardened archive extractor into <stagingParent>/<version> and returns the
 * folder that holds the app files (the zip wraps them in osu-render/). The staged VERSION.json must name `version`.
 */
export async function stageRelease(
  zipPath: string, stagingParent: string, version: string, limits: { maxEntries: number; maxExtractedBytes: number },
): Promise<string> {
  if (!parseVersion(version)) throw new Error('invalid version');
  const target = path.join(stagingParent, version);
  try {
    await extractOsz(zipPath, target, limits);
  } catch (error) {
    throw new Error(`release zip failed validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = path.join(target, 'osu-render');
  for (const required of STAGED_REQUIRED) {
    if (!existsSync(path.join(root, ...required.split('/')))) {
      await rm(target, { recursive: true, force: true });
      throw new Error(`release zip is missing osu-render/${required}`);
    }
  }
  const staged = readVersionInfo(root);
  if (staged?.app !== version) {
    await rm(target, { recursive: true, force: true });
    throw new Error(`release zip VERSION.json says ${staged?.app ?? 'nothing'}, expected ${version}`);
  }
  return root;
}

export class Updater {
  readonly appRoot: string;
  readonly updateDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly config: Readonly<UpdateConfig>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly isBusy: () => boolean;
  private readonly restartImpl: () => void;
  private readonly currentVersion: string;
  private cached: { at: number; release: LatestRelease | null; error?: string } | undefined;
  private inFlight: Promise<void> | undefined;
  private applyingUpdate = false;
  private restartPending = false;

  constructor(options: UpdaterOptions) {
    this.appRoot = options.appRoot ?? APP_ROOT;
    this.updateDir = path.join(this.appRoot, 'data', 'update');
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.config = options.config ?? appConfig.update;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.isBusy = options.isBusy;
    this.restartImpl = options.restart;
    this.currentVersion = currentVersion(this.appRoot);
  }

  /** Version of the running code, read once at startup so later edits to package.json can't change it. */
  get current(): string { return this.currentVersion; }

  /** In-app updates need the portable layout on Windows, started by start.bat (which installs the update on exit 75). */
  get portable(): boolean {
    return this.platform === 'win32' && this.env[LAUNCHER_ENV] === LAUNCHER_VALUE && isPortableLayout(this.appRoot);
  }

  /** While true the server refuses new renders: an update is downloading or the server is about to restart. */
  get applying(): boolean { return this.applyingUpdate; }

  /** Never throws: failures end up in `error`. Results are cached for update.checkIntervalMs. */
  async checkLatest(force = false): Promise<UpdateStatus> {
    if (this.config.enabled) {
      const stale = !this.cached || this.now() - this.cached.at >= this.config.checkIntervalMs;
      if (force || stale) {
        this.inFlight ??= this.fetchLatest().then((release) => { this.cached = { at: this.now(), release }; }, (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.cached = { at: this.now(), release: this.cached?.release ?? null, error: message };
          log('warn', 'update_check_failed', { component: 'update', error: message });
        }).finally(() => { this.inFlight = undefined; });
        await this.inFlight;
      }
    }
    return this.status();
  }

  status(): UpdateStatus {
    const current = this.current;
    const release = this.cached?.release ?? null;
    return {
      current,
      latest: release?.version ?? null,
      available: release !== null && compareVersions(release.version, current) > 0,
      portable: this.portable,
      enabled: this.config.enabled,
      notesUrl: release?.notesUrl || null,
      checkedAt: this.cached?.at ?? null,
      ...(this.cached?.error ? { error: this.cached.error } : {}),
    };
  }

  /** Downloads, verifies and stages the newest release, then arms the restart. Throws AppError. */
  async apply(): Promise<{ applying: true; version: string }> {
    if (!this.portable) {
      throw new AppError('UPDATE_NOT_PORTABLE', 'In-app updates only work in the Windows portable zip started with start.bat.', 409);
    }
    if (this.applyingUpdate || this.isBusy()) {
      throw new AppError('UPDATE_BUSY', 'Wait until the current render finishes before updating.', 409);
    }
    this.applyingUpdate = true;
    try {
      const status = await this.checkLatest(true);
      const release = this.cached?.release;
      if (status.error || !release) throw new Error(status.error ?? 'no release found');
      if (!status.available) throw new Error(`already on ${status.current}, latest is ${release.version}`);
      // A render submitted between the first busy check and now would be killed by the restart.
      if (this.isBusy()) throw new AppError('UPDATE_BUSY', 'Wait until the current render finishes before updating.', 409);
      await this.stage(release);
      this.restartPending = true;
      log('info', 'update_staged', { component: 'update', from: status.current, to: release.version });
      return { applying: true, version: release.version };
    } catch (error) {
      this.applyingUpdate = false;
      if (error instanceof AppError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log('error', 'update_failed', { component: 'update', error: message });
      throw new AppError('UPDATE_FAILED', 'The update could not be downloaded or verified. Nothing was changed.', 502);
    }
  }

  /** Runs the restart armed by apply(); a no-op otherwise. Call after the HTTP response went out. */
  restartIfPending(): void {
    if (!this.restartPending) return;
    this.restartPending = false;
    this.restartImpl();
  }

  private async fetchLatest(): Promise<LatestRelease | null> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.config.repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `osu-render/${this.current}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(this.config.apiTimeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
    return parseRelease(await response.json());
  }

  private async stage(release: LatestRelease): Promise<void> {
    const assets = selectAssets(release);
    const downloads = path.join(this.updateDir, 'downloads');
    const stagingParent = path.join(this.updateDir, 'staging');
    await rm(downloads, { recursive: true, force: true });
    await rm(stagingParent, { recursive: true, force: true });
    await rm(path.join(this.updateDir, 'pending.json'), { force: true });
    await mkdir(downloads, { recursive: true });
    try {
      const checksumPath = path.join(downloads, assets.checksum.name);
      await this.download(assets.checksum.url, checksumPath, MAX_CHECKSUM_BYTES);
      const expected = parseChecksumFile(await readFile(checksumPath, 'utf8'), assets.zip.name);
      if (assets.zip.size > this.config.maxDownloadBytes) throw new Error('release zip is larger than update.maxDownloadBytes');
      const zipPath = path.join(downloads, assets.zip.name);
      const actual = await this.download(assets.zip.url, zipPath, this.config.maxDownloadBytes);
      if (actual !== expected) throw new Error('release zip checksum does not match its .sha256 file');
      await stageRelease(zipPath, stagingParent, release.version, this.config);
      const pending = { version: release.version, from: this.current, createdAt: new Date(this.now()).toISOString() };
      const pendingPath = path.join(this.updateDir, 'pending.json');
      await writeFile(`${pendingPath}.tmp`, `${JSON.stringify(pending, null, 2)}\n`);
      await rename(`${pendingPath}.tmp`, pendingPath);
    } catch (error) {
      await rm(stagingParent, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(downloads, { recursive: true, force: true });
    }
  }

  /** Streams `url` to `target`, following redirects only to allowlisted https hosts. Returns the sha256 hex. */
  private async download(url: string, target: string, maxBytes: number): Promise<string> {
    const signal = AbortSignal.timeout(this.config.downloadTimeoutMs);
    let current = url;
    for (let hop = 0; ; hop += 1) {
      if (!isAllowedDownloadUrl(current, this.config.downloadHosts)) throw new Error(`download host is not allowed: ${hostOf(current)}`);
      const response = await this.fetchImpl(current, {
        redirect: 'manual', signal, headers: { 'user-agent': `osu-render/${this.current}`, accept: 'application/octet-stream' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hop >= MAX_REDIRECTS) throw new Error('download redirected too often or without a location');
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`download returned HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) { await response.body.cancel(); throw new Error('download is larger than allowed'); }
      const hash = createHash('sha256');
      let received = 0;
      await pipeline(response.body as unknown as AsyncIterable<Uint8Array>, async function* limit(source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          received += chunk.byteLength;
          if (received > maxBytes) throw new Error('download is larger than allowed');
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(target, { flags: 'wx' }));
      if ((await stat(target)).size !== received) throw new Error('download was not written completely');
      return hash.digest('hex');
    }
  }
}

function hostOf(value: string): string {
  try { return new URL(value).host; } catch { return 'invalid URL'; }
}

function parseRelease(value: unknown): LatestRelease {
  const body = value as { tag_name?: unknown; html_url?: unknown; assets?: unknown };
  const version = typeof body?.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
  if (!parseVersion(version)) throw new Error('latest release has an invalid tag');
  const notesUrl = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : '';
  const assets = (Array.isArray(body.assets) ? body.assets : []).flatMap((asset: unknown) => {
    const entry = asset as { name?: unknown; browser_download_url?: unknown; size?: unknown };
    return typeof entry?.name === 'string' && typeof entry.browser_download_url === 'string' && Number.isSafeInteger(entry.size)
      ? [{ name: entry.name, url: entry.browser_download_url, size: entry.size as number }] : [];
  });
  return { version, notesUrl, assets };
}
