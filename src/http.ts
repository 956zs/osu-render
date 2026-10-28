import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { limits, settings } from './config.js';
import { AppError, StorageLowError, publicError } from './errors.js';
import { parseReplayFile } from './replay.js';
import type { RenderDatabase } from './database.js';
import type { RenderQueue } from './queue.js';
import type { StorageManager } from './storage.js';
import { isPreflightReady, type PreflightService, type PreflightState } from './preflight.js';
import type { Paths, RenderRow } from './types.js';
import { parseRenderOptions, type RenderOptions } from './render-options.js';
import { appConfig } from './app-config.js';
import { collectDiagnostics, type DiagnosticsReport } from './diagnostics.js';
import type { ReportTrigger } from './report-webhook.js';
import type { Updater } from './updater.js';
import type { LocalSongsStatus } from './local-songs.js';
import { removeRenderFiles } from './storage.js';
import { createPreviewSigner, type PreviewSigner } from './preview-url.js';
import { DEFAULT_SKIN, installSkin, listSkins, skinInvalid, skinNameFromFilename, skinTooLarge, skinUploadPath, syncSkins } from './skins.js';

const uploadAttempts = new Map<string, number[]>();
const UPLOAD_WINDOW_MS = 60_000;
const DIAGNOSTICS_CACHE_MS = 30_000;
const MAX_UPLOADS_PER_WINDOW = 5;
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; "
  + "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** The only files served from public/ besides the i18n JSON: route → [file, content type]. */
const PAGE_FILES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
});
const SIGNED_VIDEO_PATH = /^\/api\/renders\/[a-f0-9-]{36}\/video\?/i;

export interface HttpDependencies {
  database: RenderDatabase;
  queue: RenderQueue;
  storage: StorageManager;
  preflight: PreflightService;
  preflightState: PreflightState;
  paths: Pick<Paths, 'replays' | 'videos' | 'data' | 'logs'>;
  /** Present only when REPORT_WEBHOOK_URL is valid. */
  reporter?: { send(report: DiagnosticsReport, trigger: ReportTrigger): Promise<void> };
  /** Defaults to settings.danserSkinsDir. */
  skinsDir?: string;
  /** In-app updates; the /api/update routes exist only when present. */
  updater?: Pick<Updater, 'applying' | 'checkLatest' | 'apply' | 'restartIfPending'>;
  /** Local osu!stable Songs index; its status goes into diagnostics. */
  localSongs?: { status(): LocalSongsStatus };
  /** Signs the video URLs that <video> previews load without the Bearer header; defaults to a per-process key. */
  previewSigner?: PreviewSigner;
}

export async function createHttpServer(dependencies: HttpDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: limits.maxOsrBytes + 1024 * 1024 });
  await app.register(multipart, {
    limits: { fileSize: limits.maxOsrBytes, files: 1, fields: 1, fieldSize: 4096, parts: 2 },
    throwFileSizeLimit: true,
  });
  const pageFiles = new Map(await Promise.all(Object.entries(PAGE_FILES).map(async ([route, [file, type]]) =>
    [route, { type, body: await readFile(path.resolve(settings.root, 'public', file)) }] as const)));
  const previewSigner = dependencies.previewSigner ?? createPreviewSigner({ ttlSeconds: appConfig.preview.ttlSeconds });
  const deps = { ...dependencies, previewSigner };
  const translations = await loadTranslations(path.resolve(settings.root, 'public/i18n'));
  let diagnosticsInFlight: Promise<DiagnosticsReport> | undefined;
  let diagnosticsCache: { at: number; report: DiagnosticsReport } | undefined;
  let manualSend: Promise<void> | undefined;
  const diagnostics = async (): Promise<DiagnosticsReport> => {
    if (!diagnosticsCache || Date.now() - diagnosticsCache.at >= DIAGNOSTICS_CACHE_MS) {
      diagnosticsInFlight ??= collectDiagnostics({
        preflight: dependencies.preflight, preflightResult: dependencies.preflightState.current(),
        settings, paths: dependencies.paths, database: dependencies.database, storage: dependencies.storage,
        localSongs: dependencies.localSongs,
        ...(renderActive(dependencies.database) ? { skipProbes: 'render_active' as const } : {}),
      }).then((report) => {
        diagnosticsCache = { at: Date.now(), report };
        return report;
      }).finally(() => { diagnosticsInFlight = undefined; });
      return diagnosticsInFlight;
    }
    return diagnosticsCache.report;
  };
  app.addHook('onRequest', async (request) => {
    // A signed video URL replaces the Bearer header; getVideo checks the signature.
    if (request.url.startsWith('/api/') && !isSignedVideoRequest(request)) authorize(request);
  });
  app.setErrorHandler((error, request, reply) => {
    const safe = publicError(error);
    if (safe.statusCode >= 500) request.log.error({ err: error }, safe.code);
    reply.code(safe.statusCode).send({ error: { code: safe.code, message: safe.publicMessage } });
  });

  app.get('/health', async () => ({
    ...await dependencies.preflight.health(
      await dependencies.preflightState.refreshIfNeeded(),
      dependencies.database.queuedCount(),
      await dependencies.storage.freeBytes(),
      limits.hardMinFreeBytes,
    ),
    reportWebhook: dependencies.reporter !== undefined,
  }));
  for (const [route, file] of pageFiles) {
    app.get(route, async (_request, reply) => reply.type(file.type).header('Cache-Control', 'no-cache')
      .header('Content-Security-Policy', CONTENT_SECURITY_POLICY).header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer').send(file.body));
  }
  app.get('/i18n/:file', async (request, reply) => {
    const text = translations.get((request.params as { file?: string }).file ?? '');
    if (text === undefined) throw new AppError('NOT_FOUND', 'Language is not available.', 404);
    return reply.type('application/json; charset=utf-8').header('Cache-Control', 'no-cache').send(text);
  });
  app.get('/api/diagnostics', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(await diagnostics()));
  app.post('/api/diagnostics/send', async () => {
    const reporter = dependencies.reporter;
    if (!reporter) throw new AppError('REPORT_WEBHOOK_DISABLED', 'Reporting to the developer is not configured on this server.', 409);
    // Repeated clicks while a send is running share it instead of posting the same report twice.
    manualSend ??= diagnostics().then((report) => reporter.send(report, 'manual'))
      .finally(() => { manualSend = undefined; });
    await manualSend;
    return { sent: true };
  });

  app.get('/api/skins', async (_request, reply) => reply.header('Cache-Control', 'no-store')
    .send({ skins: (await syncSkins(skinsDirOf(dependencies), appConfig.skins)).map((name) => ({ name })) }));
  app.post('/api/skins', async (request) => uploadSkin(request, dependencies));
  const updater = dependencies.updater;
  if (updater) {
    app.get('/api/update', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(await updater.checkLatest()));
    // The restart runs from onResponse so the browser gets the answer before the server goes away.
    app.post('/api/update/apply', { onResponse: async () => { updater.restartIfPending(); } }, async () => updater.apply());
  }
  app.post('/api/renders', async (request) => createRender(request, dependencies));
  app.get('/api/renders', async (request, reply) => reply.header('Cache-Control', 'no-store')
    .send(listHistory(request, deps)));
  app.get('/api/renders/:id', async (request, reply) => getRender(request, reply, deps));
  app.get('/api/renders/:id/video', async (request, reply) => getVideo(request, reply, deps));
  app.delete('/api/renders/:id', async (request, reply) => cancelRender(request, reply, dependencies));
  app.delete('/api/renders/:id/files', async (request) => deleteRenderFiles(request, dependencies));
  return app;
}

async function createRender(request: FastifyRequest, dependencies: HttpDependencies): Promise<object> {
  const clientKey = clientKeyFor(request);
  enforceUploadRate(clientKey);
  if (dependencies.updater?.applying) throw new AppError('RENDERER_UNAVAILABLE', 'The service is installing an update.', 503);
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
    if (options.skin !== DEFAULT_SKIN
      && !(await listSkins(skinsDirOf(dependencies), appConfig.skins.maxNameLength)).includes(options.skin)) {
      throw new AppError('INVALID_OPTIONS', 'The selected skin is not installed on this server.', 400);
    }
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

async function uploadSkin(request: FastifyRequest, dependencies: HttpDependencies): Promise<object> {
  enforceUploadRate(clientKeyFor(request));
  if (await dependencies.storage.freeBytes() < limits.hardMinFreeBytes) throw new StorageLowError();
  const upload = await request.file({ limits: { fileSize: appConfig.skins.maxOskBytes } });
  if (!upload || upload.fieldname !== 'skin') throw skinInvalid('Upload a file field named skin.');
  if (!upload.filename.toLowerCase().endsWith('.osk')) throw skinInvalid('Only .osk skin files are accepted.');
  skinNameFromFilename(upload.filename, appConfig.skins.maxNameLength);
  const skinsDir = skinsDirOf(dependencies);
  const archive = await skinUploadPath(skinsDir);
  try {
    const { createWriteStream } = await import('node:fs');
    try {
      await pipeline(upload.file, createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw skinTooLarge(skinSizeMessage());
      throw error;
    }
    if (upload.file.truncated) throw skinTooLarge(skinSizeMessage());
    return { name: await installSkin(archive, upload.filename, skinsDir, appConfig.skins) };
  } finally {
    await rm(archive, { force: true });
  }
}

function skinsDirOf(dependencies: HttpDependencies): string {
  return dependencies.skinsDir ?? settings.danserSkinsDir;
}

function skinSizeMessage(): string {
  return `Skin files are limited to ${Math.floor(appConfig.skins.maxOskBytes / 1024 ** 2)} MiB.`;
}

type SignedDependencies = HttpDependencies & { previewSigner: PreviewSigner };

async function getRender(request: FastifyRequest, _reply: FastifyReply, dependencies: SignedDependencies): Promise<object> {
  const id = routeId(request);
  const row = requireRender(dependencies.database.getRender(id));
  const queue = dependencies.queue as Partial<Pick<RenderQueue, 'liveStats'>>;
  const stats = row.status === 'rendering' ? queue.liveStats?.(id) : undefined;
  const available = videoAvailable(row);
  return {
    ...serializeRender(row, dependencies.database.queuePosition(id)),
    speed: stats?.speed ?? null, eta: stats?.eta ?? null,
    previewUrl: available ? dependencies.previewSigner.url(row.id) : null,
    videoBytes: available && row.video_path ? await stat(row.video_path).then((info) => info.size, () => null) : null,
  };
}

async function getVideo(request: FastifyRequest, reply: FastifyReply, dependencies: SignedDependencies): Promise<FastifyReply> {
  const id = routeId(request);
  const signed = isSignedVideoRequest(request);
  if (signed) {
    const query = request.query as { sig?: unknown; exp?: unknown };
    if (!dependencies.previewSigner.verify(id, query.sig, query.exp)) {
      throw new AppError('UNAUTHORIZED', 'The video link is invalid or expired.', 403);
    }
  }
  const row = requireRender(dependencies.database.getRender(id));
  if (row.files_deleted_at) throw new AppError('RENDER_EXPIRED', 'The video was deleted.', 410);
  if (row.status !== 'completed' || !row.video_path) throw new AppError('RENDER_FAILED', 'Video is not ready.', 409);
  const size = (await stat(row.video_path)).size;
  const range = request.headers.range;
  reply.type('video/mp4').header('Accept-Ranges', 'bytes')
    .header('Content-Disposition', contentDisposition(signed ? 'inline' : 'attachment', row));
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

function listHistory(request: FastifyRequest, dependencies: SignedDependencies): object {
  const { defaultLimit, maxLimit } = appConfig.history;
  const raw = (request.query as { limit?: unknown }).limit;
  const requested = typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : defaultLimit;
  const limit = Math.min(maxLimit, Math.max(1, requested));
  return {
    renders: dependencies.database.rendersForClient(clientKeyFor(request), limit).map((row) => ({
      ...serializeHistory(row), previewUrl: videoAvailable(row) ? dependencies.previewSigner.url(row.id) : null,
    })),
  };
}

/** Frees disk space now instead of waiting for retention; the history row stays, marked as deleted. */
async function deleteRenderFiles(request: FastifyRequest, dependencies: HttpDependencies): Promise<object> {
  const id = routeId(request);
  const found = dependencies.database.getRender(id);
  // Other clients' renders look the same as missing ones.
  const render = requireRender(found?.client_key === clientKeyFor(request) ? found : undefined);
  if (!['completed', 'failed', 'cancelled'].includes(render.status)) {
    throw new AppError('RENDER_ACTIVE', 'Cancel the render before deleting its files.', 409);
  }
  if (!render.files_deleted_at) {
    await removeRenderFiles(render, dependencies.paths);
    dependencies.database.markFilesDeleted(id);
  }
  return serializeHistory(requireRender(dependencies.database.getRender(id)));
}

/** Encoder self-tests would compete with an active render for the GPU encoder, so diagnostics skip them then. */
function renderActive(database: RenderDatabase): boolean {
  return database.db.prepare("SELECT 1 FROM renders WHERE status IN ('rendering','finalizing') LIMIT 1").get() !== undefined;
}

async function loadTranslations(directory: string): Promise<Map<string, string>> {
  const translations = new Map<string, string>();
  for (const language of appConfig.i18n.languages) {
    const text = await readFile(path.join(directory, `${language}.json`), 'utf8').catch(() => undefined);
    if (text !== undefined) translations.set(`${language}.json`, text);
  }
  return translations;
}

function isSignedVideoRequest(request: FastifyRequest): boolean {
  return request.method === 'GET' && SIGNED_VIDEO_PATH.test(request.url)
    && (request.query as { sig?: unknown } | undefined)?.sig !== undefined;
}

/** ASCII fallback is the render id; browsers that read filename* save it as "Artist - Title [Version].mp4". */
export function contentDisposition(type: 'inline' | 'attachment', row: RenderRow): string {
  const fallback = `${type}; filename="${row.id}.mp4"`;
  if (!row.beatmap_title) return fallback;
  const name = `${row.beatmap_artist ? `${row.beatmap_artist} - ` : ''}${row.beatmap_title}${row.beatmap_version ? ` [${row.beatmap_version}]` : ''}`
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').trim().slice(0, 150);
  if (!name) return fallback;
  const encoded = encodeURIComponent(`${name}.mp4`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${fallback}; filename*=UTF-8''${encoded}`;
}

function filesDeleted(row: RenderRow, now = Date.now()): boolean {
  return Boolean(row.files_deleted_at) || (row.expires_at !== null && row.expires_at <= now);
}

function videoAvailable(row: RenderRow): boolean {
  return row.status === 'completed' && Boolean(row.video_path) && !filesDeleted(row);
}

function renderMs(row: RenderRow): number | null {
  return row.started_at !== null && row.completed_at !== null && row.status === 'completed'
    ? row.completed_at - row.started_at : null;
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

function serializeHistory(row: RenderRow): object {
  const deleted = filesDeleted(row);
  return {
    id: row.id, status: row.status, progress: row.progress,
    createdAt: row.created_at, completedAt: row.completed_at, expiresAt: row.expires_at,
    beatmap: row.beatmap_checksum || row.beatmap_title ? {
      id: row.beatmap_id, beatmapsetId: row.beatmapset_id,
      title: row.beatmap_title ?? null, artist: row.beatmap_artist ?? null, version: row.beatmap_version ?? null,
      creator: row.beatmap_creator ?? null, length: row.beatmap_length ?? null,
    } : null,
    player: row.player_name, mods: row.mods,
    resolution: `${row.height}p`, encoder: row.encoder,
    renderMs: renderMs(row),
    videoAvailable: videoAvailable(row),
    filesDeleted: deleted,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
  };
}

function serializeRender(row: RenderRow, queuePosition: number | null): object {
  return {
    id: row.id, status: row.status, progress: row.progress,
    queuePosition: row.status === 'queued' ? queuePosition : 0,
    player: row.player_name,
    beatmap: row.beatmap_id || row.beatmap_title ? {
      id: row.beatmap_id, beatmapsetId: row.beatmapset_id, checksum: row.beatmap_checksum,
      title: row.beatmap_title ?? null, artist: row.beatmap_artist ?? null, version: row.beatmap_version ?? null,
      creator: row.beatmap_creator ?? null, length: row.beatmap_length ?? null,
    } : null,
    output: { width: row.width, height: row.height, fps: row.fps, encoder: row.encoder },
    mods: row.mods,
    options: parseRenderOptions(row.options_json),
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, renderMs: renderMs(row),
    expiresAt: row.expires_at,
  };
}
