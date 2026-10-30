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
import { collectDiagnostics } from './diagnostics.js';
import { WebhookReporter } from './report-webhook.js';
import { parseWebhookUrl, webhookSecrets } from './webhook-url.js';
import { UPDATE_EXIT_CODE, Updater } from './updater.js';
import { appConfig } from './app-config.js';
import { LocalSongsIndex, resolveSongsDirs } from './local-songs.js';

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
const localSongs = new LocalSongsIndex(database.db,
  resolveSongsDirs(process.env, process.platform, appConfig.localSongs.autoDetect), appConfig.localSongs);
const resolver = new BeatmapResolver(paths, database, osuApi, mirrors, {
  maxCompressedBytes: limits.maxOszCompressedBytes,
  maxExtractedBytes: limits.maxOszExtractedBytes,
  maxEntries: limits.maxArchiveEntries,
}, localSongs);
const renderer = new DanserRenderer({
  danserBin: settings.danserBin, danserDir: settings.danserDir, settingsName: settings.danserSettingsName, paths,
  timeoutMs: limits.maxRenderMinutes * 60 * 1000,
});
const reportWebhookUrl = parseWebhookUrl(settings.reportWebhookUrl);
if (settings.reportWebhookUrl && !reportWebhookUrl) {
  log('warn', 'report_webhook_invalid', {
    component: 'report', detail: 'REPORT_WEBHOOK_URL must be https://discord.com/api/webhooks/<id>/<token>; reporting is disabled.',
  });
  // Plain text as well: testers read the console window, not the JSON log lines.
  process.stderr.write('\nWARNING: REPORT_WEBHOOK_URL in .env is not a valid Discord webhook URL, so reports are NOT sent to the developer.\n'
    + 'It must look like https://discord.com/api/webhooks/<numbers>/<token>. Run set-webhook.bat (Windows zip) or fix .env, then restart.\n\n');
} else if (reportWebhookUrl) {
  log('info', 'report_webhook_enabled', { component: 'report' });
}
const reporter = reportWebhookUrl ? new WebhookReporter({
  url: reportWebhookUrl,
  secrets: webhookSecrets(settings.reportWebhookUrl),
  collect: (focusRender) => collectDiagnostics({
    preflight, preflightResult: preflightState.current(), settings, paths, database, storage, localSongs,
    skipProbes: 'auto_report', focusRender, updateStatus: () => updater.checkLatest(),
  }),
}) : undefined;
const queue = new RenderQueue({ database, resolver, renderer, storage, reporter });
for (const interrupted of database.recoverInterrupted()) {
  try { await queue.recover(interrupted); } catch { database.markFailed(interrupted.id, 'INVALID_REPLAY', 'Interrupted job could not be recovered.'); }
}
queue.start();
void localSongs.scan(); // background: lookups use whatever is indexed so far
const updater = new Updater({
  isBusy: () => database.activeCount() > 0,
  restart: () => {
    setTimeout(() => process.exit(UPDATE_EXIT_CODE), 10_000).unref(); // in case closing the server hangs
    void shutdown('update', UPDATE_EXIT_CODE);
  },
});
const app = await createHttpServer({ database, queue, storage, preflight, preflightState, paths, reporter, updater, localSongs });
const cleanupTimer = startCleanupScheduler(database, paths, async () => {
  await storage.cleanupTemp();
  await storage.evictBeatmaps();
});
await app.listen({ host: settings.host, port: settings.port });
log('info', 'service_started', {
  component: 'server', host: settings.host, port: settings.port,
  renderer: preflightResult.renderer, display: preflightResult.display, encoder: preflightResult.encoder,
  encoderKind: encoderKind(preflightResult.encoder), platform: process.platform, layout: tools.layout,
  reportWebhook: reporter !== undefined, freeDiskBytes: await storage.freeBytes(),
  version: updater.current, portable: updater.portable,
});
if (appConfig.update.enabled && appConfig.update.checkOnStartup) {
  void updater.checkLatest().then((status) => {
    if (status.available) log('info', 'update_available', { component: 'update', current: status.current, latest: status.latest });
  });
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  log('info', 'service_stopping', { component: 'server', signal });
  clearInterval(cleanupTimer);
  await app.close();
  database.close();
  process.exit(exitCode);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
