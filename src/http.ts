import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { limits, settings } from './config.js';
import { AppError, publicError } from './errors.js';
import { parseReplayFile } from './replay.js';
import type { RenderDatabase } from './database.js';
import type { RenderQueue } from './queue.js';
import type { StorageManager } from './storage.js';
import { isPreflightReady, type PreflightService, type PreflightState } from './preflight.js';
import type { RenderRow } from './types.js';
import { parseRenderOptions, type RenderOptions } from './render-options.js';

const uploadAttempts = new Map<string, number[]>();
const UPLOAD_WINDOW_MS = 60_000;
const MAX_UPLOADS_PER_WINDOW = 5;

export interface HttpDependencies {
  database: RenderDatabase;
  queue: RenderQueue;
  storage: StorageManager;
  preflight: PreflightService;
  preflightState: PreflightState;
  paths: { replays: string; videos: string };
}

export async function createHttpServer(dependencies: HttpDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: limits.maxOsrBytes + 1024 * 1024 });
  await app.register(multipart, {
    limits: { fileSize: limits.maxOsrBytes, files: 1, fields: 1, fieldSize: 4096, parts: 2 },
    throwFileSizeLimit: true,
  });
  const indexHtml = await readFile(path.resolve(settings.root, 'public/index.html'), 'utf8');
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/')) authorize(request);
  });
  app.setErrorHandler((error, request, reply) => {
    const safe = publicError(error);
    if (safe.statusCode >= 500) request.log.error({ err: error }, safe.code);
    reply.code(safe.statusCode).send({ error: { code: safe.code, message: safe.publicMessage } });
  });

  app.get('/health', async () => dependencies.preflight.health(
    await dependencies.preflightState.refreshIfNeeded(),
    dependencies.database.queuedCount(),
    await dependencies.storage.freeBytes(),
    limits.hardMinFreeBytes,
  ));
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));

  app.post('/api/renders', async (request) => createRender(request, dependencies));
  app.get('/api/renders/:id', async (request, reply) => getRender(request, reply, dependencies));
  app.get('/api/renders/:id/video', async (request, reply) => getVideo(request, reply, dependencies));
  app.delete('/api/renders/:id', async (request, reply) => cancelRender(request, reply, dependencies));
  return app;
}

async function createRender(request: FastifyRequest, dependencies: HttpDependencies): Promise<object> {
  const clientKey = clientKeyFor(request);
  enforceUploadRate(clientKey);
  if (dependencies.database.activeCountForClient(clientKey) >= limits.maxOutstandingPerClient) {
    throw new AppError('TOO_MANY_REQUESTS', 'This client already has too many outstanding jobs.', 429);
  }
  const preflightResult = await dependencies.preflightState.refreshIfNeeded(
    !isPreflightReady(dependencies.preflightState.current()),
  );
  if (!isPreflightReady(preflightResult)) {
    throw new AppError('RENDERER_UNAVAILABLE', 'Renderer is not ready.', 503);
  }
  await dependencies.storage.guardNewRender();
  if (dependencies.database.activeCount() >= limits.maxQueue) throw new AppError('QUEUE_FULL', 'Render queue is full.', 429);
  const upload = await request.file();
  if (!upload || upload.fieldname !== 'replay') throw new AppError('INVALID_REPLAY', 'Upload a file field named replay.', 400);
  if (!upload.filename.toLowerCase().endsWith('.osr')) throw new AppError('INVALID_REPLAY', 'Only .osr files are accepted.', 400);
  const id = randomUUID();
  const replayPath = path.join(dependencies.paths.replays, `${id}.osr`);
  await mkdir(dependencies.paths.replays, { recursive: true });
  try {
    const { createWriteStream } = await import('node:fs');
    await pipeline(upload.file, createWriteStream(replayPath, { flags: 'wx', mode: 0o600 }));
    const options = renderOptionsFrom(upload.fields);
    const metadata = await parseReplayFile(replayPath);
    if (metadata.playMode !== 0) throw new AppError('UNSUPPORTED_MODE', 'Only osu!standard replays are supported.', 400);
    dependencies.database.createRender({
      id, replayPath, clientKey, encoder: preflightResult.encoder, options,
    });
    await dependencies.queue.enqueue(id, metadata);
    return { id, status: 'resolving' };
  } catch (error) {
    await rm(replayPath, { force: true });
    throw error;
  }
}

async function getRender(request: FastifyRequest, _reply: FastifyReply, dependencies: HttpDependencies): Promise<object> {
  const id = routeId(request);
  const row = requireRender(dependencies.database.getRender(id));
  return serializeRender(row, dependencies.database.queuePosition(id));
}

async function getVideo(request: FastifyRequest, reply: FastifyReply, dependencies: HttpDependencies): Promise<FastifyReply> {
  const row = requireRender(dependencies.database.getRender(routeId(request)));
  if (row.status !== 'completed' || !row.video_path) throw new AppError('RENDER_FAILED', 'Video is not ready.', 409);
  const size = (await stat(row.video_path)).size;
  const range = request.headers.range;
  reply.type('video/mp4').header('Accept-Ranges', 'bytes')
    .header('Content-Disposition', `attachment; filename="${row.id}.mp4"`);
  if (!range) return reply.header('Content-Length', size).send(createReadStream(row.video_path));
  const selected = parseRange(range, size);
  return reply.code(206)
    .header('Content-Range', `bytes ${selected.start}-${selected.end}/${size}`)
    .header('Content-Length', selected.end - selected.start + 1)
    .send(createReadStream(row.video_path, selected));
}

async function cancelRender(request: FastifyRequest, _reply: FastifyReply, dependencies: HttpDependencies): Promise<object> {
  const id = routeId(request);
  requireRender(dependencies.database.getRender(id));
  await dependencies.queue.cancel(id);
  return { id, status: 'cancelled' };
}

function requireRender(row: RenderRow | undefined): RenderRow {
  if (!row) throw new AppError('INTERNAL_ERROR', 'Render job was not found.', 404);
  return row;
}

function routeId(request: FastifyRequest): string {
  const params = request.params as { id?: string };
  if (!params.id || !/^[a-f0-9-]{36}$/i.test(params.id)) throw new AppError('INTERNAL_ERROR', 'Invalid render id.', 404);
  return params.id;
}

function clientKeyFor(request: FastifyRequest): string {
  return request.ip ?? 'unknown';
}

function renderOptionsFrom(fields: Record<string, unknown>): Readonly<RenderOptions> {
  const unsupported = Object.keys(fields).filter((key) => key !== 'options' && key !== 'replay');
  if (unsupported.length > 0) throw new AppError('INVALID_OPTIONS', `Unsupported form field: ${unsupported[0]}.`, 400);
  const field = fields.options;
  if (field === undefined) return parseRenderOptions(undefined);
  if (Array.isArray(field) || typeof field !== 'object' || field === null) {
    throw new AppError('INVALID_OPTIONS', 'Render options field is invalid.', 400);
  }
  const value = (field as { type?: unknown; value?: unknown; valueTruncated?: unknown });
  if (value.type !== 'field' || typeof value.value !== 'string' || value.valueTruncated === true) {
    throw new AppError('INVALID_OPTIONS', 'Render options field is invalid.', 400);
  }
  return parseRenderOptions(value.value);
}

function authorize(request: FastifyRequest): void {
  if (!settings.authToken) return;
  const header = request.headers.authorization;
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedHash = createHash('sha256').update(settings.authToken).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(expectedHash, suppliedHash)) throw new AppError('UNAUTHORIZED', 'Authorization is required.', 401);
}

function enforceUploadRate(clientKey: string): void {
  const now = Date.now();
  const current = (uploadAttempts.get(clientKey) ?? []).filter((time) => now - time < UPLOAD_WINDOW_MS);
  if (current.length >= MAX_UPLOADS_PER_WINDOW) {
    throw new AppError('TOO_MANY_REQUESTS', 'Upload rate limit exceeded.', 429);
  }
  current.push(now);
  uploadAttempts.set(clientKey, current);
}

function parseRange(value: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) throw new AppError('RENDER_FAILED', 'Invalid HTTP range.', 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
    throw new AppError('RENDER_FAILED', 'Requested range is outside the video.', 416);
  }
  return { start, end };
}

function serializeRender(row: RenderRow, queuePosition: number | null): object {
  return {
    id: row.id, status: row.status, progress: row.progress,
    queuePosition: row.status === 'queued' ? queuePosition : 0,
    player: row.player_name,
    beatmap: row.beatmap_id ? { id: row.beatmap_id, beatmapsetId: row.beatmapset_id, checksum: row.beatmap_checksum } : null,
    output: { width: row.width, height: row.height, fps: row.fps, encoder: row.encoder },
    mods: row.mods,
    options: parseRenderOptions(row.options_json),
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}
