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

export class MirrorChain {
  constructor(private readonly mirrors: readonly BeatmapMirror[]) {}

  async download(beatmapsetId: number, destination: string, maxBytes: number): Promise<void> {
    const failures: string[] = [];
    for (const mirror of this.mirrors) {
      try {
        await mirror.downloadBeatmapset(beatmapsetId, destination, maxBytes);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${mirror.name}: ${reason}`);
        log('warn', 'beatmap_mirror_failed', { component: 'mirror', mirror: mirror.name, beatmapsetId, reason });
      }
    }
    throw new AppError('BEATMAP_DOWNLOAD_FAILED', `All beatmap mirrors failed: ${failures.join('; ')}`, 502);
  }
}
