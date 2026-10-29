import { execFile } from 'node:child_process';
import { open, readFile, readdir, readlink, stat, statfs } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT, appConfig } from './app-config.js';
import { SUPPORTED_ENCODERS, encoderKind } from './encoders.js';
import { libraryEnvironment, redactText, type DanserTools } from './platform.js';
import { parseWebhookUrl, webhookSecrets } from './webhook-url.js';
import type { EncoderProbe, Paths, PreflightResult, RenderRow } from './types.js';
import type { LocalSongsStatus } from './local-songs.js';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const POWERSHELL_TIMEOUT_MS = 20_000;
const DANSER_LOG_READ_BYTES = 1024 * 1024;
const FIELD_CHARS = 200;
const ISSUE_BODY_CHARS = 1500;
const ISSUE_URL_MAX = 8000;
const RENDER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Report keys holding free text (logs, error output) where player names may appear. */
const FREE_TEXT_KEYS = new Set(['logTail', 'error', 'displayDetail', 'errorDetail']);
const WINDOWS_GPU_COMMAND = 'ConvertTo-Json -Compress @(Get-CimInstance Win32_VideoController'
  + ' | Select-Object Name,AdapterCompatibility,DriverVersion,PNPDeviceID,Status)';

export const ISSUE_OS_OPTIONS = {
  windows11: 'Windows 11', windows10: 'Windows 10', linux: 'Linux', other: 'Other / Otro',
} as const;
export const ISSUE_RESULT_OPTIONS = {
  doctorOnly: 'Doctor only, no render / Solo doctor, sin render',
  succeeded: 'Render succeeded / Render correcto',
  failed: 'Render failed / Render fallido',
  selfTestFailed: 'Encoder self-test failed / Falló la autoprueba del codificador',
} as const;

export type DiagnosticsCommandRunner = (
  file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface DiagnosticsPreflight {
  run(): Promise<PreflightResult>;
  probeAll(): Promise<EncoderProbe[]>;
  tools(): Promise<DanserTools>;
}

export interface DiagnosticsSettings {
  host: string;
  port: number;
  renderEncoder: string;
  danserDir: string;
  osuClientId: string;
  osuClientSecret: string;
  authToken: string;
  mirrors: readonly string[];
  /** Raw REPORT_WEBHOOK_URL value; only used to scrub it and to report whether reporting is on. */
  reportWebhookUrl?: string;
}

export interface DiagnosticsOptions {
  preflight: DiagnosticsPreflight;
  settings: DiagnosticsSettings;
  paths: Pick<Paths, 'data' | 'logs'>;
  /** Current service preflight result; when omitted preflight.run() is called. */
  preflightResult?: PreflightResult;
  database?: { recentRenders(limit: number): RenderRow[]; getRender?(id: string): RenderRow | undefined };
  storage?: { freeBytes(): Promise<number> };
  runCommand?: DiagnosticsCommandRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  sysDrmDir?: string;
  now?: Date;
  /** Skip the encoder self-tests (e.g. while a render is using the GPU) and report the preflight probes instead. */
  skipProbes?: ProbesSkipped;
  /** Render the report is about (auto reports): included even if older than the recent list, with its own log tail size. */
  focusRender?: { id: string; logTailBytes: number };
  /** Local osu!stable Songs index (counts only, no paths). */
  localSongs?: { status(): LocalSongsStatus };
}

export type ProbesSkipped = 'render_active' | 'auto_report';

export interface GpuInfo {
  name: string;
  vendor?: string;
  driver?: string;
  pciId?: string;
  bootVga?: boolean;
  source: 'cim' | 'nvidia-smi' | 'sysfs';
}

export interface DanserLogSummary {
  version?: string;
  commit?: string;
  glVendor?: string;
  glRenderer?: string;
  glVersion?: string;
  ffmpegLocation?: string;
}

export interface RenderDiagnostics {
  /** 1-based position, newest first; render ids are download/cancel credentials and never leave the service. */
  index: number;
  status: string;
  encoder: string;
  width: number;
  height: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  renderMs: number | null;
  errorCode: string | null;
  /** Redacted internal cause (error name + message) of unexpected failures. */
  errorDetail: string | null;
  /** Average render speed danser reported (1 = real time). */
  avgSpeed: number | null;
  logTail?: string;
}

export interface DiagnosticsReport {
  schema: 1;
  generatedAt: string;
  app: { version: string; node: string };
  system: { platform: NodeJS.Platform; release: string; arch: string; cpu: string; cores: number; memoryBytes: number };
  gpus: GpuInfo[];
  danser: {
    dir: string;
    layout: DanserTools['layout'] | 'unknown';
    offscreenCapable: boolean;
    files: { danserCli: boolean; ffmpeg: boolean; ffprobe: boolean };
    version?: string;
    log?: DanserLogSummary;
    ffmpegVersion?: string;
    ffmpegEncoders: string[];
  };
  preflight: PreflightResult;
  encoderProbes: EncoderProbe[];
  probesSkipped?: ProbesSkipped;
  /** Index (in `renders`) of the render this report is about. */
  focusRender?: number;
  config: {
    host: HostScope; port: number; renderEncoder: string; oauthConfigured: boolean; authTokenSet: boolean;
    reportWebhook: boolean; mirrors: string[];
  };
  storage: { freeBytes: number | null };
  localSongs?: LocalSongsStatus;
  renders: RenderDiagnostics[];
  errors: Array<{ source: string; error: string }>;
  issue: { url: string; title: string; body: string };
}

type Errors = DiagnosticsReport['errors'];
export type HostScope = 'loopback' | 'any' | 'other';

export async function collectDiagnostics(options: DiagnosticsOptions): Promise<DiagnosticsReport> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const errors: Errors = [];
  const attempt = async <T>(source: string, fallback: T, action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) {
      errors.push({ source, error: errorText(error) });
      return fallback;
    }
  };

  const tools = await attempt<DanserTools | undefined>('danser.tools', undefined, () => options.preflight.tools());
  const preflight = options.preflightResult ?? await attempt<PreflightResult>('preflight', {
    renderer: false, display: false, encoder: 'unknown', probes: [], reason: 'renderer_unavailable',
  }, () => options.preflight.run());
  const encoderProbes = options.skipProbes ? preflight.probes
    : await attempt<EncoderProbe[]>('encoderProbes', [], () => options.preflight.probeAll());
  const toolEnv = tools ? libraryEnvironment(tools.libraryDirs, env, platform) : env;
  const rows = await attempt<RenderRow[]>('renders', [], async () => {
    const recent = options.database?.recentRenders(appConfig.diagnostics.recentRenders) ?? [];
    const focusId = options.focusRender?.id;
    if (!focusId || recent.some((row) => row.id === focusId)) return recent;
    const focused = options.database?.getRender?.(focusId);
    return focused ? [...recent, focused] : recent;
  });
  const [gpus, danser, freeBytes, renders, version] = await Promise.all([
    collectGpus({ platform, env, runCommand, errors, sysDrmDir: options.sysDrmDir ?? '/sys/class/drm' }),
    collectDanser(options.settings.danserDir, tools, toolEnv, runCommand, errors),
    attempt<number | null>('storage', null, () => options.storage?.freeBytes() ?? freeBytesOf(options.paths.data)),
    collectRenders(rows, options.paths.logs, errors, options.focusRender),
    appVersion(),
  ]);
  const playerNames = rows.map((row) => row.player_name ?? '').filter(Boolean);

  const settings = options.settings;
  const focusIndex = rows.findIndex((row) => row.id === options.focusRender?.id) + 1;
  const unsanitized: Omit<DiagnosticsReport, 'issue'> = {
    schema: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    app: { version, node: process.version },
    system: {
      platform, release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
      cores: os.availableParallelism(), memoryBytes: os.totalmem(),
    },
    gpus,
    danser,
    preflight,
    encoderProbes,
    ...(options.skipProbes ? { probesSkipped: options.skipProbes } : {}),
    ...(focusIndex > 0 ? { focusRender: focusIndex } : {}),
    config: {
      host: classifyHost(settings.host), port: settings.port, renderEncoder: settings.renderEncoder,
      oauthConfigured: Boolean(settings.osuClientId && settings.osuClientSecret),
      authTokenSet: Boolean(settings.authToken),
      reportWebhook: parseWebhookUrl(settings.reportWebhookUrl) !== undefined,
      mirrors: settings.mirrors.map(mirrorHost),
    },
    storage: { freeBytes },
    ...(options.localSongs ? { localSongs: options.localSongs.status() } : {}),
    renders,
    errors,
  };
  const scrub = createScrubber({
    secrets: [settings.authToken, settings.osuClientSecret, ...webhookSecrets(settings.reportWebhookUrl)], renderIds: rows.map((row) => row.id),
    dataDir: options.paths.data,
  });
  const report = sanitizeValue(unsanitized, scrub, (text) => scrubPlayerNames(text, playerNames));
  return { ...report, issue: buildIssue(report) };
}

// ---------------------------------------------------------------- redaction

export interface ScrubOptions {
  secrets?: readonly string[];
  renderIds?: readonly string[];
  dataDir?: string;
}

/** Scrubber applied to every string in the report (player names are handled separately, free text only). */
export function createScrubber(options: ScrubOptions = {}): (text: string) => string {
  return (text) => {
    let result = scrubSecrets(text, options.secrets ?? []);
    for (const id of options.renderIds ?? []) result = replaceLiteral(result, id, '<render-id>', true);
    if (options.dataDir) result = replaceLiteral(result, options.dataDir, '<data>', process.platform === 'win32');
    return scrubIpAddresses(redactText(result));
  };
}

export function classifyHost(host: string): HostScope {
  const value = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (value === '' || value === '0.0.0.0' || value === '::') return 'any';
  if (value === 'localhost' || value === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return 'loopback';
  return 'other';
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) {
    result = replaceLiteral(result, secret, '<secret>', false);
  }
  return result;
}

export function scrubPlayerNames(text: string, names: readonly string[]): string {
  let result = text;
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 2))];
  for (const name of unique.sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), '<player>');
  }
  return result;
}

export function scrubIpAddresses(text: string): string {
  return text
    .replace(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)/g, (match) => (net.isIPv4(match) ? '<ip>' : match))
    .replace(/(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g,
      (match) => (net.isIPv6(match) ? '<ip>' : match));
}

function replaceLiteral(text: string, needle: string, replacement: string, ignoreCase: boolean): string {
  if (!needle) return text;
  return text.replace(new RegExp(escapeRegExp(needle), ignoreCase ? 'gi' : 'g'), replacement);
}

function sanitizeValue<T>(value: T, scrub: (text: string) => string, scrubFreeText: (text: string) => string, key = ''): T {
  if (typeof value === 'string') return (FREE_TEXT_KEYS.has(key) ? scrubFreeText(scrub(value)) : scrub(value)) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, scrub, scrubFreeText, key)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .map(([name, item]) => [name, sanitizeValue(item, scrub, scrubFreeText, name)])) as T;
  }
  return value;
}

function mirrorHost(template: string): string {
  try { return new URL(template.replaceAll('{id}', '1')).hostname; } catch { return 'invalid'; }
}

// ---------------------------------------------------------------- GPUs

interface GpuContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  runCommand: DiagnosticsCommandRunner;
  errors: Errors;
  sysDrmDir: string;
}

async function collectGpus(context: GpuContext): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];
  if (context.platform === 'win32') {
    try {
      const { stdout } = await context.runCommand('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', WINDOWS_GPU_COMMAND,
      ], { env: context.env, timeoutMs: POWERSHELL_TIMEOUT_MS });
      gpus.push(...parseWindowsGpuJson(stdout));
    } catch (error) {
      context.errors.push({ source: 'gpus.cim', error: errorText(error) });
    }
  } else if (context.platform === 'linux') {
    try { gpus.push(...await readLinuxGpus(context.sysDrmDir, context.runCommand, context.env)); } catch (error) {
      context.errors.push({ source: 'gpus.sysfs', error: errorText(error) });
    }
  }
  try {
    const { stdout } = await context.runCommand('nvidia-smi', [
      '--query-gpu=name,driver_version', '--format=csv,noheader',
    ], { env: context.env, timeoutMs: COMMAND_TIMEOUT_MS });
    gpus.push(...parseNvidiaSmi(stdout));
  } catch (error) {
    if (!isMissingCommand(error)) context.errors.push({ source: 'gpus.nvidia-smi', error: errorText(error) });
  }
  return gpus;
}

export function pciVendorName(id: string | undefined): string | undefined {
  switch (id?.toLowerCase().replace(/^0x/, '')) {
    case '10de': return 'NVIDIA';
    case '1002': return 'AMD';
    case '8086': return 'Intel';
    default: return undefined;
  }
}

export function parseWindowsGpuJson(stdout: string): GpuInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const pnp = typeof item.PNPDeviceID === 'string' ? item.PNPDeviceID : '';
      const vendorId = /VEN_([0-9A-F]{4})/i.exec(pnp)?.[1];
      const deviceId = /DEV_([0-9A-F]{4})/i.exec(pnp)?.[1];
      const compatibility = typeof item.AdapterCompatibility === 'string' ? item.AdapterCompatibility : undefined;
      return compact<GpuInfo>({
        name: field(item.Name) ?? 'unknown',
        vendor: pciVendorName(vendorId) ?? field(compatibility),
        driver: field(item.DriverVersion),
        pciId: vendorId && deviceId ? `${vendorId}:${deviceId}`.toLowerCase() : undefined,
        source: 'cim',
      });
    });
}

export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.lastIndexOf(',');
    const name = separator >= 0 ? line.slice(0, separator).trim() : line;
    const driver = separator >= 0 ? line.slice(separator + 1).trim() : '';
    return compact<GpuInfo>({ name: field(name) ?? 'unknown', vendor: 'NVIDIA', driver: field(driver), source: 'nvidia-smi' });
  });
}

/** Parses one line of `lspci -mm` output into "<vendor> <device>". */
export function parseLspciName(stdout: string): string | undefined {
  const quoted = [...(stdout.split(/\r?\n/)[0] ?? '').matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  if (quoted.length < 3) return undefined;
  return field(`${quoted[1]} ${quoted[2]}`.trim());
}

export function parseNvidiaProcVersion(text: string): string | undefined {
  return /Kernel Module(?:\s+for\s+\S+)?\s+([\d.]+)/.exec(text)?.[1];
}

export async function readLinuxGpus(
  drmDir: string,
  runCommand: DiagnosticsCommandRunner = defaultRunCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GpuInfo[]> {
  const cards = (await readdir(drmDir)).filter((name) => /^card\d+$/.test(name)).sort();
  const nvidiaVersion = parseNvidiaProcVersion(await readFile('/proc/driver/nvidia/version', 'utf8').catch(() => ''));
  const gpus: GpuInfo[] = [];
  for (const card of cards) {
    const device = path.join(drmDir, card, 'device');
    const vendorId = (await readSmall(path.join(device, 'vendor')))?.replace(/^0x/, '');
    const deviceId = (await readSmall(path.join(device, 'device')))?.replace(/^0x/, '');
    const bootVga = await readSmall(path.join(device, 'boot_vga'));
    const driverName = await readlink(path.join(device, 'driver')).then((target) => path.basename(target)).catch(() => undefined);
    const slot = await readlink(device).then((target) => path.basename(target)).catch(() => undefined);
    let name: string | undefined;
    if (slot && /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(slot)) {
      name = await runCommand('lspci', ['-mm', '-s', slot], { env, timeoutMs: COMMAND_TIMEOUT_MS })
        .then(({ stdout }) => parseLspciName(stdout)).catch(() => undefined);
    }
    const vendor = pciVendorName(vendorId);
    const driverVersion = driverName === 'nvidia' && nvidiaVersion ? `nvidia ${nvidiaVersion}` : driverName;
    gpus.push(compact<GpuInfo>({
      name: name ?? `${vendor ?? 'Unknown'} GPU`,
      vendor,
      driver: driverVersion,
      pciId: vendorId && deviceId ? `${vendorId}:${deviceId}` : undefined,
      bootVga: bootVga === undefined ? undefined : bootVga === '1',
      source: 'sysfs',
    }));
  }
  return gpus;
}

async function readSmall(file: string): Promise<string | undefined> {
  try { return (await readFile(file, 'utf8')).trim() || undefined; } catch { return undefined; }
}

// ---------------------------------------------------------------- danser / ffmpeg

export function parseDanserLog(text: string): DanserLogSummary {
  const keys: Record<string, keyof DanserLogSummary> = {
    'danser-go version': 'version', 'Build commit hash': 'commit', 'GL Vendor': 'glVendor',
    'GL Renderer': 'glRenderer', 'GL Version': 'glVersion', 'FFmpeg exec location': 'ffmpegLocation',
  };
  const summary: DanserLogSummary = {};
  const pattern = /^(?:\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+)?(danser-go version|Build commit hash|GL Vendor|GL Renderer|GL Version|FFmpeg exec location):\s*(.*)$/;
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    const value = match ? field(match[2]) : undefined;
    if (match && value) summary[keys[match[1]]] = value;
  }
  return summary;
}

export function parseFfmpegEncoders(stdout: string): string[] {
  const supported = new Set<string>(SUPPORTED_ENCODERS);
  const found = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*V[A-Z.]{5}\s+(\S+)/.exec(line);
    if (match && supported.has(match[1])) found.add(match[1]);
  }
  return SUPPORTED_ENCODERS.filter((encoder) => found.has(encoder));
}

async function collectDanser(
  danserDir: string,
  tools: DanserTools | undefined,
  env: NodeJS.ProcessEnv,
  runCommand: DiagnosticsCommandRunner,
  errors: Errors,
): Promise<DiagnosticsReport['danser']> {
  const logText = await readHead(path.join(danserDir, 'danser.log'), DANSER_LOG_READ_BYTES).catch(() => undefined);
  const log = logText === undefined ? undefined : parseDanserLog(logText);
  const result: DiagnosticsReport['danser'] = {
    dir: danserDir,
    layout: tools?.layout ?? 'unknown',
    offscreenCapable: tools?.offscreenCapable ?? false,
    files: { danserCli: false, ffmpeg: false, ffprobe: false },
    ...(log?.version ? { version: log.version } : {}),
    ...(log ? { log } : {}),
    ffmpegEncoders: [],
  };
  if (!tools) return result;
  const [danserCli, ffmpegFile, ffprobeFile] = await Promise.all([
    isFile(tools.danserCli), isFile(tools.ffmpeg), isFile(tools.ffprobe),
  ]);
  const options = { env, timeoutMs: COMMAND_TIMEOUT_MS };
  let ffmpegRuns = false;
  try {
    const { stdout } = await runCommand(tools.ffmpeg, ['-version'], options);
    ffmpegRuns = true;
    const first = field(stdout.split(/\r?\n/)[0]);
    if (first) result.ffmpegVersion = first;
  } catch (error) {
    errors.push({ source: 'ffmpeg.version', error: errorText(error) });
  }
  if (ffmpegRuns) {
    try {
      const { stdout } = await runCommand(tools.ffmpeg, ['-hide_banner', '-encoders'], options);
      result.ffmpegEncoders = parseFfmpegEncoders(stdout);
    } catch (error) {
      errors.push({ source: 'ffmpeg.encoders', error: errorText(error) });
    }
  }
  let ffprobe = ffprobeFile;
  if (!ffprobe && tools.layout === 'path') {
    ffprobe = await runCommand(tools.ffprobe, ['-version'], options).then(() => true, () => false);
  }
  result.files = { danserCli, ffmpeg: ffmpegFile || (tools.layout === 'path' && ffmpegRuns), ffprobe };
  return result;
}

async function readHead(file: string, bytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readLogTail(file: string, bytes: number): Promise<string | undefined> {
  if (bytes <= 0) return undefined;
  let handle;
  try { handle = await open(file, 'r'); } catch { return undefined; }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : text.replace(/^�+/, '');
    }
    return text;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- renders

async function collectRenders(
  rows: readonly RenderRow[], logsDir: string, errors: Errors, focus?: DiagnosticsOptions['focusRender'],
): Promise<RenderDiagnostics[]> {
  const renders: RenderDiagnostics[] = [];
  for (const [position, row] of rows.entries()) {
    const render: RenderDiagnostics = {
      index: position + 1, status: row.status, encoder: row.encoder, width: row.width, height: row.height,
      createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
      renderMs: row.started_at !== null && row.completed_at !== null ? Math.max(0, row.completed_at - row.started_at) : null,
      errorCode: row.error_code, errorDetail: row.error_detail ?? null, avgSpeed: row.avg_speed ?? null,
    };
    const tailBytes = row.id === focus?.id ? focus.logTailBytes
      : row.status === 'failed' ? appConfig.diagnostics.reportLogTailBytes : 0;
    if (tailBytes > 0 && RENDER_ID_PATTERN.test(row.id)) {
      try {
        const tail = await readLogTail(path.join(logsDir, `${row.id}.log`), tailBytes);
        if (tail !== undefined) render.logTail = scrubPlayerNames(tail, row.player_name ? [row.player_name] : []);
      } catch (error) {
        errors.push({ source: `renders.${position + 1}.log`, error: errorText(error) });
      }
    }
    renders.push(render);
  }
  return renders;
}

// ---------------------------------------------------------------- issue

export function issueOsOption(platform: NodeJS.Platform, release: string): string {
  if (platform === 'win32') {
    const build = Number(release.split('.')[2]);
    return Number.isFinite(build) && build >= 22000 ? ISSUE_OS_OPTIONS.windows11 : ISSUE_OS_OPTIONS.windows10;
  }
  return platform === 'linux' ? ISSUE_OS_OPTIONS.linux : ISSUE_OS_OPTIONS.other;
}

export function issueResultOption(report: Pick<DiagnosticsReport, 'renders' | 'preflight'>): string {
  const last = report.renders.find((render) => render.status === 'completed' || render.status === 'failed');
  if (last) return last.status === 'completed' ? ISSUE_RESULT_OPTIONS.succeeded : ISSUE_RESULT_OPTIONS.failed;
  const reason = report.preflight.reason;
  if (report.preflight.encoder === 'unknown' || reason === 'hardware_encoder_unavailable' || reason === 'encoder_unavailable') {
    return ISSUE_RESULT_OPTIONS.selfTestFailed;
  }
  return ISSUE_RESULT_OPTIONS.doctorOnly;
}

export type IssueInput = Omit<DiagnosticsReport, 'issue'>;

export function buildIssueBody(report: IssueInput): string {
  const lastRender = report.renders.find((render) => render.status === 'completed' || render.status === 'failed');
  const probes = report.encoderProbes.length > 0 ? report.encoderProbes : report.preflight.probes;
  const lines = [
    '### osu-render diagnostics',
    `- Platform: ${report.system.platform} ${report.system.release} (${report.system.arch}), ${report.system.cpu}, ${report.system.cores} cores`,
    `- GPUs: ${gpuSummary(report.gpus) || 'none detected'}`,
    `- Driver: ${driverSummary(report) || 'unknown'}`,
    `- Encoder: ${report.preflight.encoder} (${encoderKind(report.preflight.encoder)})${report.preflight.reason ? `, reason: ${report.preflight.reason}` : ''}`,
    `- Renderer: ${report.preflight.renderer ? 'ok' : 'missing'}, display: ${report.preflight.display ? 'ok' : 'unavailable'}${report.preflight.displayDetail ? ` (${report.preflight.displayDetail})` : ''}`,
    `- Probes: ${probes.map((probe) => `${probe.encoder} ${probe.ok ? 'ok' : 'FAIL'}`).join(', ') || 'none'}`,
    `- danser: ${report.danser.version ?? 'unknown'} (${report.danser.layout}), GL: ${report.danser.log?.glRenderer ?? 'unknown'}`,
    `- ffmpeg: ${report.danser.ffmpegVersion ?? 'not found'}; encoders: ${report.danser.ffmpegEncoders.join(', ') || 'none'}`,
    `- Last render: ${lastRender ? renderSummary(lastRender) : 'none'}`,
    `- App: ${report.app.version}, Node ${report.app.node}`,
  ];
  return truncate(lines.join('\n'), ISSUE_BODY_CHARS);
}

export function issueSummary(report: IssueInput): Record<string, unknown> {
  const lastRender = report.renders.find((render) => render.status === 'completed' || render.status === 'failed');
  return {
    schema: report.schema,
    app: report.app.version,
    system: { platform: report.system.platform, release: report.system.release, arch: report.system.arch, cpu: report.system.cpu },
    gpus: report.gpus.map((gpu) => compact({ name: gpu.name, vendor: gpu.vendor, driver: gpu.driver })),
    danser: compact({
      version: report.danser.version, layout: report.danser.layout, files: report.danser.files,
      gl: report.danser.log?.glRenderer, glVersion: report.danser.log?.glVersion,
    }),
    ffmpeg: compact({ version: report.danser.ffmpegVersion, encoders: report.danser.ffmpegEncoders }),
    preflight: compact({
      encoder: report.preflight.encoder, reason: report.preflight.reason,
      renderer: report.preflight.renderer, display: report.preflight.display, displayDetail: report.preflight.displayDetail,
    }),
    probes: Object.fromEntries(report.encoderProbes.map((probe) => [probe.encoder, probe.ok ? 'ok' : `fail: ${(probe.error ?? '').slice(-160)}`])),
    lastRender: lastRender ? compact({
      status: lastRender.status, encoder: lastRender.encoder, size: `${lastRender.width}x${lastRender.height}`,
      renderMs: lastRender.renderMs, avgSpeed: lastRender.avgSpeed, errorCode: lastRender.errorCode,
    }) : null,
    errors: report.errors.map((error) => error.source),
  };
}

export interface IssueUrlOptions {
  issueUrl?: string;
  issueTemplate?: string;
  maxLength?: number;
}

export function buildIssue(report: IssueInput, options: IssueUrlOptions = {}): DiagnosticsReport['issue'] {
  const body = buildIssueBody(report);
  const gpuNames = gpuSummary(report.gpus);
  const title = truncate(`[GPU] ${issueOsOption(report.system.platform, report.system.release).split(' / ')[0]}`
    + ` · ${gpuNames || 'no GPU'} · ${report.preflight.encoder}`, 120);
  const url = buildIssueUrl({
    title,
    os: issueOsOption(report.system.platform, report.system.release),
    gpu: gpuNames,
    driver: driverSummary(report),
    danser: report.danser.version ?? '',
    result: issueResultOption(report),
    diagnostics: JSON.stringify(issueSummary(report)),
  }, options);
  return { url, title, body };
}

/** Builds the prefilled issue-form URL; the `diagnostics` field is truncated to keep the URL below maxLength. */
export function buildIssueUrl(fields: Record<string, string>, options: IssueUrlOptions = {}): string {
  const base = options.issueUrl ?? appConfig.diagnostics.issueUrl;
  const template = options.issueTemplate ?? appConfig.diagnostics.issueTemplate;
  const maxLength = options.maxLength ?? ISSUE_URL_MAX;
  const make = (values: Record<string, string>): string => {
    const query = new URLSearchParams({ template });
    for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
    return `${base}?${query.toString().replaceAll('+', '%20')}`;
  };
  const values = { ...fields };
  let url = make(values);
  for (const key of ['diagnostics', 'driver', 'gpu', 'title'] as const) {
    if (url.length < maxLength || !values[key]) continue;
    const original = fields[key];
    const withLength = (keep: number): string => make({ ...values, [key]: keep > 0 ? `${original.slice(0, keep)}…` : '' });
    let low = 0;
    let high = original.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (withLength(middle).length < maxLength) low = middle; else high = middle - 1;
    }
    values[key] = low > 0 ? `${original.slice(0, low)}…` : '';
    url = make(values);
  }
  return url;
}

function gpuSummary(gpus: readonly GpuInfo[]): string {
  return [...new Set(gpus.map((gpu) => gpu.name))].join(' + ');
}

function driverSummary(report: IssueInput): string {
  const drivers = new Map<string, string>();
  for (const gpu of report.gpus) {
    if (!gpu.driver) continue;
    const key = gpu.vendor ?? gpu.name;
    if (!drivers.has(key) || gpu.source === 'nvidia-smi') drivers.set(key, gpu.driver);
  }
  const parts = [...drivers].map(([vendor, driver]) => `${vendor} ${driver}`);
  if (report.system.platform !== 'win32' && report.danser.log?.glVersion) parts.push(`GL ${report.danser.log.glVersion}`);
  return truncate(parts.join('; '), 300);
}

export function renderSummary(render: RenderDiagnostics): string {
  const seconds = render.renderMs === null ? '' : `, ${(render.renderMs / 1000).toFixed(1)} s`;
  const speed = render.avgSpeed === null ? '' : `, ${render.avgSpeed.toFixed(2)}x avg`;
  return `${render.status} (${render.encoder}, ${render.width}x${render.height}${seconds}${speed}${render.errorCode ? `, ${render.errorCode}` : ''})`;
}

// ---------------------------------------------------------------- helpers

async function defaultRunCommand(
  file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    env: options.env, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
}

async function freeBytesOf(directory: string): Promise<number | null> {
  let current = path.resolve(directory);
  while (true) {
    try {
      const info = await statfs(current);
      return info.bavail * info.bsize;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function appVersion(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch { return 'unknown'; }
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

function isMissingCommand(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function errorText(error: unknown): string {
  const failure = error as { stderr?: unknown; killed?: boolean; signal?: string; code?: unknown; message?: string };
  const stderr = typeof failure?.stderr === 'string' ? failure.stderr.trim() : '';
  if (failure?.killed) return `timed out (${failure.signal ?? 'killed'})`;
  const text = stderr || (typeof failure?.code === 'string' ? `${failure.code}: ` : '') + String(failure?.message ?? error);
  return text.slice(-500);
}

function field(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, FIELD_CHARS) : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
