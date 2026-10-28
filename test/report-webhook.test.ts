import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIssue, type DiagnosticsReport } from '../src/diagnostics.js';
import {
  ReportSendError, WebhookReporter, buildWebhookMessage, postWebhook, type FetchLike, type WebhookConfig,
} from '../src/report-webhook.js';
import { parseWebhookUrl, webhookSecrets } from '../src/webhook-url.js';

const TOKEN = 'tokenPart_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const URL_OK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const CONFIG: WebhookConfig = {
  username: 'osu-render', timeoutMs: 1000, retryAfterCapMs: 3000, minIntervalMs: 0,
  autoLogTailBytes: { failed: 4096, completed: 1024 },
};

function fakeReport(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  const base: Omit<DiagnosticsReport, 'issue'> = {
    schema: 1, generatedAt: '2026-10-28T01:02:03.456Z', app: { version: '0.3.0', node: 'v24.0.0' },
    system: { platform: 'win32', release: '10.0.22631', arch: 'x64', cpu: 'Ryzen', cores: 8, memoryBytes: 1 },
    gpus: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', driver: '560.94', source: 'cim' }],
    danser: {
      dir: '~/danser', layout: 'bin-lib', offscreenCapable: false, files: { danserCli: true, ffmpeg: true, ffprobe: true },
      version: '0.12.1', log: { glRenderer: 'NVIDIA GeForce RTX 3060/PCIe/SSE2' }, ffmpegEncoders: ['h264_nvenc', 'libx264'],
    },
    preflight: { renderer: true, display: true, encoder: 'h264_nvenc', probes: [{ encoder: 'h264_nvenc', ok: true, durationMs: 5 }] },
    encoderProbes: [],
    config: { host: 'loopback', port: 3030, renderEncoder: 'auto', oauthConfigured: true, authTokenSet: false, reportWebhook: true, mirrors: [] },
    storage: { freeBytes: 1 },
    renders: [{
      index: 1, status: 'failed', encoder: 'h264_nvenc', width: 1920, height: 1080, createdAt: 1, startedAt: 1000,
      completedAt: 13300, renderMs: 12300, errorCode: 'RENDER_FAILED', logTail: 'nvenc init failed',
    }],
    errors: [],
    ...overrides,
  };
  return { ...base, issue: buildIssue(base) } as DiagnosticsReport;
}

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : body, { status, headers });
}

test('parseWebhookUrl accepts Discord webhook URLs only', () => {
  for (const [input, expected] of [
    ['https://discord.com/api/webhooks/123/abc', 'https://discord.com/api/webhooks/123/abc'],
    ['  https://discordapp.com/api/webhooks/123/abc  ', 'https://discordapp.com/api/webhooks/123/abc'],
    ['https://ptb.discord.com/api/webhooks/123/a-b_c', 'https://ptb.discord.com/api/webhooks/123/a-b_c'],
    ['https://canary.discord.com/api/webhooks/123/abc/', 'https://canary.discord.com/api/webhooks/123/abc'],
    ['https://DISCORD.com/api/v10/webhooks/123/abc', 'https://discord.com/api/webhooks/123/abc'],
    [URL_OK, URL_OK],
  ]) assert.equal(parseWebhookUrl(input), expected, input);
  for (const input of [
    undefined, '', '   ', 'not a url', 'http://discord.com/api/webhooks/123/abc', 'https://example.com/api/webhooks/123/abc',
    'https://discord.com/api/webhooks/123', 'https://discord.com/api/webhooks/123/', 'https://discord.com/api/webhooks/abc/def',
    'https://discord.com/api/webhooks/123/abc/slack', 'https://evil.com/?x=discord.com/api/webhooks/1/a',
    'https://discord.com@evil.com/api/webhooks/1/a', 'https://user:pass@discord.com/api/webhooks/1/a',
    'https://discord.com.evil.com/api/webhooks/1/a', 'https://evil-discord.com/api/webhooks/1/a',
    'https://discord.com:8443/api/webhooks/1/a', 'https://discord.com/api/webhooks/1/a?wait=true',
    'https://discord.com/api/webhooks/1/a#x', 'https://discord.com/api/webhooks/1/a%2F..%2Fx',
    'https://discord.com/x/api/webhooks/1/a', 'ftp://discord.com/api/webhooks/1/a',
  ]) assert.equal(parseWebhookUrl(input), undefined, String(input));
});

test('webhookSecrets covers the raw value, canonical URL and token', () => {
  assert.deepEqual(webhookSecrets(undefined), []);
  assert.deepEqual(webhookSecrets(''), []);
  assert.deepEqual(webhookSecrets(` ${URL_OK} `), [URL_OK, TOKEN]);
  assert.deepEqual(webhookSecrets('https://discordapp.com/api/v10/webhooks/1/tok_en'),
    ['https://discordapp.com/api/v10/webhooks/1/tok_en', 'https://discordapp.com/api/webhooks/1/tok_en', 'tok_en']);
  assert.deepEqual(webhookSecrets('http://discord.com/api/webhooks/1/abcdef'), ['http://discord.com/api/webhooks/1/abcdef', 'abcdef']);
});

test('buildWebhookMessage: summary content, no mentions, attachment, secrets scrubbed', () => {
  const report = fakeReport({ focusRender: 1, errors: [{ source: 'x', error: `leaked ${URL_OK} and ${TOKEN}` }] });
  const message = buildWebhookMessage(report, 'render_failed', { username: 'osu-render', secrets: webhookSecrets(URL_OK) });
  assert.deepEqual(message.payload.allowed_mentions, { parse: [] });
  assert.equal(message.payload.username, 'osu-render');
  const content = message.payload.content;
  assert.ok(content.length <= 2000);
  assert.match(content, /^\*\*osu-render 0\.3\.0\*\* · render failed\nRender #1: failed \(h264_nvenc, 1920x1080, 12\.3 s, RENDER_FAILED\)\n```\n/);
  assert.match(content, /- Platform: win32 10\.0\.22631/);
  assert.match(content, /- GPUs: NVIDIA GeForce RTX 3060/);
  assert.match(content, /- Encoder: h264_nvenc \(hardware\)/);
  assert.match(content, /- danser: 0\.12\.1 \(bin-lib\), GL: NVIDIA GeForce RTX 3060/);
  assert.match(content, /```$/);
  assert.equal(message.fileName, 'osu-render-report-2026-10-28T01-02-03-456Z.json');
  const file = JSON.parse(message.fileJson) as DiagnosticsReport & { delivery: { trigger: string } };
  assert.equal(file.delivery.trigger, 'render_failed');
  assert.equal(file.schema, 1);
  for (const text of [content, message.fileJson]) {
    assert.ok(!text.includes(TOKEN) && !text.includes('discord.com/api'), 'webhook URL must never be sent');
  }
  assert.equal(file.errors[0].error, 'leaked <secret> and <secret>');

  const manual = buildWebhookMessage(fakeReport(), 'manual', { username: 'u', secrets: [] });
  assert.match(manual.payload.content, /^\*\*osu-render 0\.3\.0\*\* · manual report\n```\n/);
  for (const [trigger, label] of [['render_completed', 'render completed'], ['render_timeout', 'render timeout']] as const) {
    assert.match(buildWebhookMessage(fakeReport(), trigger, { username: 'u', secrets: [] }).payload.content, new RegExp(` · ${label}\\n`));
  }
});

test('buildWebhookMessage caps content at 2000 characters and neutralizes code fences', () => {
  const long = fakeReport();
  long.issue = { ...long.issue, body: `### osu-render diagnostics\n- GPUs: \`\`\`${'x'.repeat(5000)}` };
  const content = buildWebhookMessage(long, 'manual', { username: 'u', secrets: [] }).payload.content;
  assert.equal(content.length <= 2000, true);
  assert.ok(content.endsWith('…\n```'));
  assert.equal(content.match(/```/g)?.length, 2);
});

test('postWebhook sends multipart payload_json + files[0]', async () => {
  const calls: Array<{ url: string; body: FormData; signal: AbortSignal }> = [];
  const fetch: FetchLike = async (url, init) => { calls.push({ url, ...init }); return response(204); };
  const message = buildWebhookMessage(fakeReport(), 'manual', { username: 'osu-render', secrets: [] });
  await postWebhook(URL_OK, message, { fetch, timeoutMs: 1000, retryAfterCapMs: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_OK);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls[0].body.get('payload_json'))), message.payload);
  const file = calls[0].body.get('files[0]') as File;
  assert.equal(file.name, message.fileName);
  assert.equal(file.type, 'application/json');
  assert.equal(await file.text(), message.fileJson);
});

test('postWebhook retries once after 429 with capped retry_after', async () => {
  const message = buildWebhookMessage(fakeReport(), 'manual', { username: 'u', secrets: [] });
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
  let calls = 0;
  await postWebhook(URL_OK, message, {
    fetch: async () => (++calls === 1 ? response(429, '{"retry_after":1.25,"global":false}') : response(200, '{}')),
    sleep, timeoutMs: 1000, retryAfterCapMs: 3000,
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1250]);

  calls = 0;
  await assert.rejects(postWebhook(URL_OK, message, {
    fetch: async () => { calls += 1; return response(429, 'nope', { 'retry-after': '60' }); },
    sleep, timeoutMs: 1000, retryAfterCapMs: 3000,
  }), (error: unknown) => error instanceof ReportSendError && error.code === 'REPORT_SEND_FAILED' && /HTTP 429/.test(error.detail));
  assert.equal(calls, 2);
  assert.equal(sleeps[1], 3000);
});

test('postWebhook failures never include the URL', async () => {
  const message = buildWebhookMessage(fakeReport(), 'manual', { username: 'u', secrets: [] });
  const options = { timeoutMs: 1000, retryAfterCapMs: 0 };
  const cases: FetchLike[] = [
    async () => response(404, '{"message": "Unknown Webhook", "code": 10015}'),
    async () => { throw new TypeError(`fetch failed ${URL_OK}`, { cause: Object.assign(new Error(URL_OK), { code: 'ENOTFOUND' }) }); },
    async () => { throw new DOMException(`timeout ${URL_OK}`, 'TimeoutError'); },
    async () => { throw `string ${URL_OK}`; },
  ];
  const details: string[] = [];
  for (const fetch of cases) {
    await assert.rejects(postWebhook(URL_OK, message, { ...options, fetch }), (error: unknown) => {
      assert.ok(error instanceof ReportSendError);
      assert.equal(error.statusCode, 502);
      details.push(error.detail);
      for (const text of [error.message, error.detail, error.stack ?? '']) assert.ok(!text.includes(TOKEN), text);
      return true;
    });
  }
  assert.deepEqual(details, ['HTTP 404: {"message": "Unknown Webhook", "code": 10015}', 'TypeError: ENOTFOUND', 'request timed out', 'request failed']);
});

test('postWebhook aborts a hung request after timeoutMs', async () => {
  const message = buildWebhookMessage(fakeReport(), 'manual', { username: 'u', secrets: [] });
  const fetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  await assert.rejects(postWebhook(URL_OK, message, { fetch, timeoutMs: 20, retryAfterCapMs: 0 }),
    (error: unknown) => error instanceof ReportSendError && error.detail === 'request timed out');
});

test('WebhookReporter serializes sends and spaces them by minIntervalMs', async () => {
  let clock = 1000;
  const events: string[] = [];
  const sleeps: number[] = [];
  let active = 0;
  const fetch: FetchLike = async (_url, init) => {
    active += 1;
    assert.equal(active, 1, 'sends must not overlap');
    const payload = JSON.parse(String(init.body.get('payload_json'))) as { content: string };
    events.push(/· (\w+ ?\w*)\n/.exec(payload.content)?.[1] ?? '?');
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return events.length === 2 ? response(500, 'boom') : response(204);
  };
  const reporter = new WebhookReporter({
    url: URL_OK, secrets: webhookSecrets(URL_OK), collect: async () => fakeReport(), fetch,
    config: { ...CONFIG, minIntervalMs: 400 }, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  const results = await Promise.allSettled([
    reporter.send(fakeReport(), 'manual'), reporter.send(fakeReport(), 'render_failed'), reporter.send(fakeReport(), 'render_completed'),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(events, ['manual report', 'render failed', 'render completed']);
  assert.deepEqual(sleeps, [400, 400]);
});

test('WebhookReporter.renderFinished collects a focused report and never throws', async () => {
  const collected: Array<{ id: string; logTailBytes: number }> = [];
  const sent: string[] = [];
  let failCollect = false;
  const reporter = new WebhookReporter({
    url: URL_OK, secrets: [], config: CONFIG,
    collect: async (focus) => {
      collected.push(focus);
      if (failCollect) throw new Error('collect failed');
      return fakeReport({ focusRender: 1 });
    },
    fetch: async (_url, init) => {
      sent.push(String(init.body.get('payload_json')));
      return sent.length === 2 ? response(400, 'bad') : response(204);
    },
  });
  reporter.renderFinished({ id: 'a', outcome: 'completed' });
  reporter.renderFinished({ id: 'b', outcome: 'timeout' });
  failCollect = true;
  reporter.renderFinished({ id: 'c', outcome: 'failed' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(collected, [
    { id: 'a', logTailBytes: 1024 }, { id: 'b', logTailBytes: 4096 }, { id: 'c', logTailBytes: 4096 },
  ]);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /render completed/);
  assert.match(sent[1], /render timeout/);
});
