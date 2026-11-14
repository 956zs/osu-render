import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { AppError } from './errors.js';
import { log } from './logger.js';

export const MIRROR_USER_AGENT = 'osu-render-service/1.0 (private deployment)';

export interface BeatmapMirror {
  readonly name: string;
  downloadBeatmapset(beatmapsetId: number, destination: string, maxBytes: number): Promise<void>;
}

/**
 * Parses MIRROR_PROXY: an http(s) proxy URL with only a host and port (credentials allowed). Returns undefined
 * when unset, throws a readable error when malformed so startup fails instead of silently going direct.
 */
export function parseProxyUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('MIRROR_PROXY must be a URL like http://100.64.0.1:8319'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || (url.pathname !== '/' && url.pathname !== '')
    || url.search || url.hash) {
    throw new Error('MIRROR_PROXY must be http:// or https:// with only a host and port');
  }
  return url.href;
}

/** Connection pool for mirror downloads: a longer TCP+TLS connect limit than fetch's 10 s, optionally via a proxy. */
export function mirrorDispatcher(options: { connectTimeoutMs: number; proxy?: string }): Dispatcher {
  const connect = { timeout: options.connectTimeoutMs };
  return options.proxy
    ? new ProxyAgent({ uri: options.proxy, connect, proxyTls: connect, requestTls: connect })
    : new Agent({ connect });
}

export class HttpBeatmapMirror implements BeatmapMirror {
  readonly name: string;

  constructor(
    private readonly template: string,
    private readonly timeoutMs = 300_000,
    private readonly dispatcher?: Dispatcher,
  ) {
    this.name = new URL(template.replace('{id}', '1')).hostname;
  }

  async downloadBeatmapset(beatmapsetId: number, destination: string, maxBytes: number): Promise<void> {
    const url = this.template.replace('{id}', String(beatmapsetId));
    const response = await undiciFetch(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': MIRROR_USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > maxBytes) throw new Error('archive exceeds compressed size limit');
    const partPath = `${destination}.part`;
    await rm(partPath, { force: true });
    try {
      await pipeline(Readable.fromWeb(response.body as never), byteLimiter(maxBytes),
        createWriteStream(partPath, { flags: 'wx', mode: 0o600 }));
      const downloaded = (await stat(partPath)).size;
      if (downloaded > maxBytes) throw new Error('archive exceeds compressed size limit');
      await rename(partPath, destination);
    } catch (error) {
      await rm(partPath, { force: true });
      throw error;
    }
  }
}

function byteLimiter(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(total > maxBytes ? new Error('archive exceeds compressed size limit') : null, chunk);
    },
  });
}

/**
 * Mirror URL templates to use: the configured ones (BEATMAP_MIRRORS, comma-separated) first, then the built-in
 * fallbacks unless `only` is set. Mirrors lag behind osu! for freshly updated maps, so one mirror is rarely enough.
 */
export function mirrorTemplates(configured: string | undefined, fallback: readonly string[], only: boolean): string[] {
  const own = (configured ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const list = only && own.length > 0 ? own : [...own, ...fallback];
  return [...new Set(list)];
}

/** Network codes that usually clear up on a second try (slow TLS handshakes, dropped sockets, DNS hiccups). */
const TRANSIENT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
]);

/** True for connection-level failures worth retrying; HTTP errors and size limits are not. */
export function isTransientNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  return cause !== undefined && cause !== error && isTransientNetworkError(cause);
}

export interface MirrorChainOptions {
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class MirrorChain {
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly mirrors: readonly BeatmapMirror[], options: MirrorChainOptions = {}) {
    this.attempts = Math.max(1, options.attempts ?? 1);
    this.retryDelayMs = options.retryDelayMs ?? 0;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async fetchWithRetry(mirror: BeatmapMirror, beatmapsetId: number, archive: string, maxBytes: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await mirror.downloadBeatmapset(beatmapsetId, archive, maxBytes);
        return;
      } catch (error) {
        if (attempt >= this.attempts || !isTransientNetworkError(error)) throw error;
        log('warn', 'beatmap_mirror_retry', { component: 'mirror', mirror: mirror.name, beatmapsetId, attempt });
        await this.sleep(this.retryDelayMs * attempt);
      }
    }
  }

  /**
   * Downloads the set from each mirror in turn until `accept` returns a result. `accept` returns null when the
   * archive holds another version of the map (mirror not updated yet), so the next mirror gets a chance.
   */
  async download<T>(
    beatmapsetId: number, maxBytes: number, archivePath: () => string,
    accept: (archive: string) => Promise<T | null>,
  ): Promise<T> {
    const failures: string[] = [];
    const outdated: string[] = [];
    for (const mirror of this.mirrors) {
      const archive = archivePath();
      try {
        await this.fetchWithRetry(mirror, beatmapsetId, archive, maxBytes);
        const result = await accept(archive);
        if (result !== null) return result;
        outdated.push(mirror.name);
        log('warn', 'beatmap_mirror_outdated', { component: 'mirror', mirror: mirror.name, beatmapsetId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${mirror.name}: ${reason}`);
        log('warn', 'beatmap_mirror_failed', { component: 'mirror', mirror: mirror.name, beatmapsetId, reason });
      } finally {
        await rm(archive, { force: true });
      }
    }
    if (outdated.length > 0) {
      throw new AppError('BEATMAP_CHECKSUM_MISMATCH',
        `No mirror has this version of the beatmap yet (outdated: ${outdated.join(', ')}).`, 422);
    }
    throw new AppError('BEATMAP_DOWNLOAD_FAILED', `All beatmap mirrors failed: ${failures.join('; ')}`, 502);
  }
}
