import { appConfig, type AppConfig } from './app-config.js';
import { renderSummary, scrubSecrets, type DiagnosticsReport } from './diagnostics.js';
import { AppError } from './errors.js';
import { log } from './logger.js';
import type { RenderFinishedEvent, RenderReporter } from './types.js';

/** Discord protocol limits. */
const CONTENT_MAX_CHARS = 2000;
const ERROR_BODY_CHARS = 200;

export type ReportTrigger = 'manual' | 'render_completed' | 'render_failed' | 'render_timeout';

const TRIGGER_LABELS: Record<ReportTrigger, string> = {
  manual: 'manual report',
  render_completed: 'render completed',
  render_failed: 'render failed',
  render_timeout: 'render timeout',
};

const OUTCOME_TRIGGERS: Record<RenderFinishedEvent['outcome'], ReportTrigger> = {
  completed: 'render_completed', failed: 'render_failed', timeout: 'render_timeout',
};

export type WebhookConfig = AppConfig['reportWebhook'];
export type FetchLike = (url: string, init: { method: string; body: FormData; signal: AbortSignal }) => Promise<Response>;

export interface WebhookPayload {
  content: string;
  username: string;
  allowed_mentions: { parse: never[] };
}

export interface WebhookMessage {
  payload: WebhookPayload;
  fileName: string;
  fileJson: string;
}

/** Report shape attached to Discord: the diagnostics report plus why it was sent. */
export type DeliveredReport = DiagnosticsReport & { delivery: { trigger: ReportTrigger } };

export class ReportSendError extends AppError {
  constructor(readonly detail: string) {
    super('REPORT_SEND_FAILED', 'The report could not be sent to the developer.', 502);
  }
}

/** Builds the Discord message: a short summary as content and the full JSON report as an attachment. */
export function buildWebhookMessage(
  report: DiagnosticsReport, trigger: ReportTrigger, options: { username: string; secrets: readonly string[] },
): WebhookMessage {
  const scrub = (text: string): string => scrubSecrets(text, options.secrets);
  const focus = report.focusRender === undefined ? undefined : report.renders[report.focusRender - 1];
  const header = [
    `**osu-render ${report.app.version}** · ${TRIGGER_LABELS[trigger]}`,
    ...(focus ? [`Render #${focus.index}: ${renderSummary(focus)}`] : []),
    ...(focus?.status === 'failed' && focus.errorDetail ? [`Detail: ${focus.errorDetail.replaceAll('`', "'")}`] : []),
  ].join('\n');
  const body = report.issue.body.replace(/^### .*\n/, '').replaceAll('```', "'''");
  const room = CONTENT_MAX_CHARS - header.length - '\n```\n\n```'.length;
  const fitted = body.length <= room ? body : `${body.slice(0, Math.max(0, room - 1))}…`;
  const delivered: DeliveredReport = { ...report, delivery: { trigger } };
  return {
    payload: {
      content: scrub(`${header}\n\`\`\`\n${fitted}\n\`\`\``).slice(0, CONTENT_MAX_CHARS),
      username: options.username,
      allowed_mentions: { parse: [] },
    },
    fileName: `osu-render-report-${report.generatedAt.replace(/[:.]/g, '-')}.json`,
    fileJson: scrub(`${JSON.stringify(delivered, null, 2)}\n`),
  };
}

export interface PostOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs: number;
  retryAfterCapMs: number;
}

/** Posts one message (multipart: payload_json + files[0]); retries once after a 429. Errors never contain the URL. */
export async function postWebhook(url: string, message: WebhookMessage, options: PostOptions): Promise<void> {
  const fetchImpl = options.fetch ?? ((target, init) => fetch(target, init));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(message.payload));
    form.append('files[0]', new Blob([message.fileJson], { type: 'application/json' }), message.fileName);
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (error) {
      throw new ReportSendError(requestErrorText(error));
    }
    if (response.ok) return;
    const text = await response.text().catch(() => '');
    if (response.status === 429 && attempt === 0) {
      await sleep(Math.min(retryAfterMs(text, response.headers.get('retry-after')), options.retryAfterCapMs));
      continue;
    }
    throw new ReportSendError(`HTTP ${response.status}${text ? `: ${text.slice(0, ERROR_BODY_CHARS)}` : ''}`);
  }
}

export interface WebhookReporterOptions {
  url: string;
  /** Strings scrubbed from everything sent or logged (see webhookSecrets). */
  secrets: readonly string[];
  /** Collects a report for an auto send, focused on the finished render. */
  collect: (focus: { id: string; logTailBytes: number }) => Promise<DiagnosticsReport>;
  config?: WebhookConfig;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Sends reports to one Discord webhook, one at a time, spaced by minIntervalMs. */
export class WebhookReporter implements RenderReporter {
  private chain: Promise<void> = Promise.resolve();
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly config: WebhookConfig;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: WebhookReporterOptions) {
    this.config = options.config ?? appConfig.reportWebhook;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Queues a send behind earlier ones; rejects with ReportSendError (already logged) on failure. */
  send(report: DiagnosticsReport, trigger: ReportTrigger): Promise<void> {
    const run = this.chain.then(() => this.post(report, trigger));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Fire-and-forget auto report after a render ends; never throws. */
  renderFinished(event: RenderFinishedEvent): void {
    const trigger = OUTCOME_TRIGGERS[event.outcome];
    const logTailBytes = this.config.autoLogTailBytes[event.outcome === 'completed' ? 'completed' : 'failed'];
    void this.options.collect({ id: event.id, logTailBytes })
      .then((report) => this.send(report, trigger))
      .catch((error: unknown) => {
        if (!(error instanceof ReportSendError)) this.warn(trigger, error instanceof Error ? error.message : String(error));
      });
  }

  private async post(report: DiagnosticsReport, trigger: ReportTrigger): Promise<void> {
    const wait = this.lastSentAt + this.config.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    try {
      const message = buildWebhookMessage(report, trigger, { username: this.config.username, secrets: this.options.secrets });
      await postWebhook(this.options.url, message, {
        fetch: this.options.fetch, sleep: this.sleep,
        timeoutMs: this.config.timeoutMs, retryAfterCapMs: this.config.retryAfterCapMs,
      });
      log('info', 'report_sent', { component: 'report', trigger });
    } catch (error) {
      const failure = error instanceof ReportSendError ? error : new ReportSendError(requestErrorText(error));
      this.warn(trigger, failure.detail);
      throw failure;
    } finally {
      this.lastSentAt = this.now();
    }
  }

  private warn(trigger: ReportTrigger, detail: string): void {
    log('warn', 'report_send_failed', { component: 'report', trigger, detail: scrubSecrets(detail, this.options.secrets) });
  }
}

function retryAfterMs(body: string, header: string | null): number {
  try {
    const seconds = (JSON.parse(body) as { retry_after?: unknown }).retry_after;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  } catch { /* fall back to the header */ }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000;
}

/** fetch errors: name + cause code only (undici messages and causes can include the request URL). */
function requestErrorText(error: unknown): string {
  if (!(error instanceof Error)) return 'request failed';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'request timed out';
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.name}: ${code}` : error.name;
}
