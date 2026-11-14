import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.js';
import { log } from './logger.js';

export const MIRROR_USER_AGENT = 'osu-render-service/1.0 (private deployment)';

export interface BeatmapMirror {
  readonly name: string;
  downloadBeatmapset(beatmapsetId: number, destination: string, maxBytes: number): Promise<void>;
}

export class HttpBeatmapMirror implements BeatmapMirror {
  readonly name: string;

  constructor(private readonly template: string) {
    this.name = new URL(template.replace('{id}', '1')).hostname;
  }

  async downloadBeatmapset(beatmapsetId: number, destination: string, maxBytes: number): Promise<void> {
    const url = this.template.replace('{id}', String(beatmapsetId));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': MIRROR_USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
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

export class MirrorChain {
  constructor(private readonly mirrors: readonly BeatmapMirror[]) {}

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
        await mirror.downloadBeatmapset(beatmapsetId, archive, maxBytes);
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
