import { ensureDirectories, getPaths, limits, settings } from './config.js';
import { RenderDatabase } from './database.js';
import { BeatmapResolver } from './beatmap-resolver.js';
import { HttpBeatmapMirror, MirrorChain } from './mirrors.js';
import { OsuApiClient } from './osu-api.js';
import { PreflightService, PreflightState } from './preflight.js';
import { writeDanserSettings } from './danser-config.js';
import { DanserRenderer } from './renderer.js';
import { StorageManager } from './storage.js';
import { RenderQueue } from './queue.js';
import { createHttpServer } from './http.js';
import { startCleanupScheduler } from './cleanup.js';
import { log } from './logger.js';
import { encoderKind, type EncoderSetting } from './encoders.js';

const paths = getPaths();
await ensureDirectories(paths);
const database = new RenderDatabase(paths.db);
const storage = new StorageManager(paths, database, limits.softMinFreeBytes, limits.hardMinFreeBytes);
const preflight = new PreflightService({
  danserDir: settings.danserDir, danserBin: settings.danserBin, renderEncoder: settings.renderEncoder,
});
const preflightResult = await preflight.run();
const tools = await preflight.tools();
log(preflightResult.reason ? 'warn' : 'info', 'preflight_completed', {
  component: 'preflight', platform: process.platform, renderEncoder: settings.renderEncoder,
  encoder: preflightResult.encoder, encoderKind: encoderKind(preflightResult.encoder), reason: preflightResult.reason,
  renderer: preflightResult.renderer, display: preflightResult.display, displayDetail: preflightResult.displayDetail,
  layout: tools.layout, offscreenCapable: tools.offscreenCapable, probes: preflightResult.probes,
});
const writeSettings = (encoder: EncoderSetting): Promise<void> => writeDanserSettings({
  paths, encoder, baseSettingsPath: settings.danserBaseSettings, skinsDir: settings.danserSkinsDir,
});
await writeSettings(preflightResult.encoder);
const preflightState = new PreflightState(preflight, preflightResult, {
  onChange: async (result) => { await writeSettings(result.encoder); },
});
const osuApi = new OsuApiClient({ clientId: settings.osuClientId, clientSecret: settings.osuClientSecret });
const mirrors = new MirrorChain(settings.mirrors.map((template) => new HttpBeatmapMirror(template)));
const resolver = new BeatmapResolver(paths, database, osuApi, mirrors, {
  maxCompressedBytes: limits.maxOszCompressedBytes,
  maxExtractedBytes: limits.maxOszExtractedBytes,
  maxEntries: limits.maxArchiveEntries,
});
const renderer = new DanserRenderer({
  danserBin: settings.danserBin, danserDir: settings.danserDir, settingsName: settings.danserSettingsName, paths,
  timeoutMs: limits.maxRenderMinutes * 60 * 1000,
});
const queue = new RenderQueue({ database, resolver, renderer, storage });
for (const interrupted of database.recoverInterrupted()) {
  try { await queue.recover(interrupted); } catch { database.markFailed(interrupted.id, 'INVALID_REPLAY', 'Interrupted job could not be recovered.'); }
}
queue.start();
const app = await createHttpServer({ database, queue, storage, preflight, preflightState, paths });
const cleanupTimer = startCleanupScheduler(database, paths, async () => {
  await storage.cleanupTemp();
  await storage.evictBeatmaps();
});
await app.listen({ host: settings.host, port: settings.port });
log('info', 'service_started', {
  component: 'server', host: settings.host, port: settings.port,
  renderer: preflightResult.renderer, display: preflightResult.display, encoder: preflightResult.encoder,
  encoderKind: encoderKind(preflightResult.encoder), platform: process.platform, layout: tools.layout,
  freeDiskBytes: await storage.freeBytes(),
});

async function shutdown(signal: string): Promise<void> {
  log('info', 'service_stopping', { component: 'server', signal });
  clearInterval(cleanupTimer);
  await app.close();
  database.close();
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
