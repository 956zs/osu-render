import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ISSUE_OS_OPTIONS, ISSUE_RESULT_OPTIONS, buildIssueUrl, classifyHost, collectDiagnostics, createScrubber, issueOsOption,
  issueResultOption, parseDanserLog, parseFfmpegEncoders, parseLspciName, parseNvidiaProcVersion, parseNvidiaSmi,
  parseWindowsGpuJson, pciVendorName, readLinuxGpus, readLogTail, scrubIpAddresses, scrubPlayerNames, scrubSecrets,
  type DiagnosticsCommandRunner, type DiagnosticsSettings,
} from '../src/diagnostics.js';
import type { DanserTools } from '../src/platform.js';
import type { PreflightResult, RenderRow } from '../src/types.js';

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-diag-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('scrubIpAddresses replaces IPv4 and IPv6 but keeps versions and times', () => {
  assert.equal(scrubIpAddresses('client 192.168.1.20 connected'), 'client <ip> connected');
  assert.equal(scrubIpAddresses('from 2001:db8::1 and ::1 and fe80::a:b'), 'from <ip> and <ip> and <ip>');
  assert.equal(scrubIpAddresses('[10.0.0.1]:3030.'), '[<ip>]:3030.');
  assert.equal(scrubIpAddresses('11:53:50 GL 4.6.0 driver 31.0.101.5186 v1.2.3.4x'), '11:53:50 GL 4.6.0 driver 31.0.101.5186 v1.2.3.4x');
  assert.equal(scrubIpAddresses('999.1.1.1'), '999.1.1.1');
  assert.equal(scrubIpAddresses(''), '');
});

test('scrubPlayerNames only matches whole names', () => {
  assert.equal(scrubPlayerNames('using h264_nvenc for nv', ['nv']), 'using h264_nvenc for <player>');
  assert.equal(scrubPlayerNames('libx264 x264 amdgpu amd', ['x264', 'amd']), 'libx264 <player> amdgpu <player>');
  assert.equal(scrubPlayerNames('Ünter Über', ['Über']), 'Ünter <player>');
});

test('scrubPlayerNames is case-insensitive, escapes regex characters and ignores tiny names', () => {
  assert.equal(scrubPlayerNames('Loading replay by Cookiezi, cookiezi wins', ['Cookiezi']), 'Loading replay by <player>, <player> wins');
  assert.equal(scrubPlayerNames('player [Hd]Rafis (x)', ['[Hd]Rafis (x)']), 'player <player>');
  assert.equal(scrubPlayerNames('a b c', ['a', '']), 'a b c');
  assert.equal(scrubPlayerNames('nothing', []), 'nothing');
  assert.equal(scrubPlayerNames('', ['someone']), '');
});

test('scrubSecrets removes secret values and skips short or empty ones', () => {
  assert.equal(scrubSecrets('token=abcd1234 and abcd1234', ['abcd1234']), 'token=<secret> and <secret>');
  assert.equal(scrubSecrets('abc', ['abc', '']), 'abc');
});

test('createScrubber combines secrets, players, data dir, home and IP redaction', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const scrub = createScrubber({ secrets: ['s3cr3t-value'], dataDir: '/srv/osu/data', renderIds: [id] });
  const text = `${os.homedir()}/x /srv/osu/data/replays/${id}.osr 8.8.8.8 s3cr3t-value ${id.toUpperCase()}`;
  assert.equal(scrub(text), '~/x <data>/replays/<render-id>.osr <ip> <secret> <render-id>');
  assert.equal(createScrubber()('plain'), 'plain');
});

test('classifyHost never exposes the bind address', () => {
  assert.equal(classifyHost('127.0.0.1'), 'loopback');
  assert.equal(classifyHost('localhost'), 'loopback');
  assert.equal(classifyHost('[::1]'), 'loopback');
  assert.equal(classifyHost('0.0.0.0'), 'any');
  assert.equal(classifyHost('::'), 'any');
  assert.equal(classifyHost(''), 'any');
  assert.equal(classifyHost('192.168.1.50'), 'other');
  assert.equal(classifyHost('my-host.lan'), 'other');
});

test('parseDanserLog extracts version, GL and ffmpeg location and skips extensions', () => {
  const log = [
    '2026/10/28 11:53:50 danser-go version: 0.11.0',
    '2026/10/28 11:53:50 Build commit hash: 8331b0ff',
    '2026/10/28 11:53:51 GL Vendor:     Intel',
    '2026/10/28 11:53:51 GL Renderer:   Mesa Intel(R) Iris(R) Xe Graphics',
    '2026/10/28 11:53:51 GL Version:    4.6 (Core Profile) Mesa 26.2.5',
    '2026/10/28 11:53:51 GL Extensions: GL_ARB_a GL_ARB_b',
    '2026/10/28 11:53:52 FFmpeg exec location: /opt/danser/ffmpeg/ffmpeg\r',
  ].join('\r\n');
  assert.deepEqual(parseDanserLog(log), {
    version: '0.11.0', commit: '8331b0ff', glVendor: 'Intel', glRenderer: 'Mesa Intel(R) Iris(R) Xe Graphics',
    glVersion: '4.6 (Core Profile) Mesa 26.2.5', ffmpegLocation: '/opt/danser/ffmpeg/ffmpeg',
  });
  assert.deepEqual(parseDanserLog(''), {});
  assert.deepEqual(parseDanserLog('danser-go version:   \nrandom'), {});
  assert.equal(parseDanserLog('danser-go version: 0.11.0\ndanser-go version: 0.12.1').version, '0.12.1');
});

test('parseFfmpegEncoders keeps supported video encoders in canonical order', () => {
  const output = [
    'Encoders:', ' V..... = Video', ' ------',
    ' V....D libx264              libx264 H.264 (codec h264)',
    ' V....D h264_qsv             H.264 (Intel Quick Sync Video acceleration) (codec h264)',
    ' V....D libsvtav1            SVT-AV1',
    ' A....D aac                  AAC',
    ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
  ].join('\n');
  assert.deepEqual(parseFfmpegEncoders(output), ['h264_nvenc', 'h264_qsv', 'libx264']);
  assert.deepEqual(parseFfmpegEncoders(''), []);
});

test('GPU parsers handle Windows CIM, nvidia-smi, lspci and NVIDIA proc output', () => {
  const cim = JSON.stringify([
    { Name: 'NVIDIA GeForce RTX 3060', AdapterCompatibility: 'NVIDIA', DriverVersion: '32.0.15.6094', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2504&SUBSYS_1', Status: 'OK' },
    { Name: 'Intel(R) UHD Graphics 770', AdapterCompatibility: 'Intel Corporation', DriverVersion: '31.0.101.5186', PNPDeviceID: 'PCI\\VEN_8086&DEV_4680', Status: 'OK' },
  ]);
  const parsed = parseWindowsGpuJson(cim);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', driver: '32.0.15.6094', pciId: '10de:2504', source: 'cim' });
  assert.equal(parsed[1].vendor, 'Intel');
  assert.deepEqual(parseWindowsGpuJson('{"Name":"Microsoft Basic Display Adapter","PNPDeviceID":"ROOT\\\\BASIC"}'),
    [{ name: 'Microsoft Basic Display Adapter', source: 'cim' }]);
  assert.deepEqual(parseWindowsGpuJson('  '), []);
  assert.throws(() => parseWindowsGpuJson('not json'));

  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 560.94\r\n\r\n'),
    [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', driver: '560.94', source: 'nvidia-smi' }]);
  assert.deepEqual(parseNvidiaSmi(''), []);

  assert.equal(parseLspciName('00:02.0 "VGA compatible controller" "Intel Corporation" "Raptor Lake-P [Iris Xe Graphics]" -r04 "Lenovo" "x"'),
    'Intel Corporation Raptor Lake-P [Iris Xe Graphics]');
  assert.equal(parseLspciName(''), undefined);
  assert.equal(parseNvidiaProcVersion('NVRM version: NVIDIA UNIX x86_64 Kernel Module  560.35.03  Fri Aug 16 2024'), '560.35.03');
  assert.equal(parseNvidiaProcVersion('NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  570.86.16  Release Build'), '570.86.16');
  assert.equal(parseNvidiaProcVersion(''), undefined);
  assert.equal(pciVendorName('0x10de'), 'NVIDIA');
  assert.equal(pciVendorName('1002'), 'AMD');
  assert.equal(pciVendorName('8086'), 'Intel');
  assert.equal(pciVendorName('1234'), undefined);
  assert.equal(pciVendorName(undefined), undefined);
});

test('readLinuxGpus reads sysfs cards and ignores connectors', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (directory) => {
    const pciDevice = path.join(directory, 'devices', '0000:00:02.0');
    await mkdir(path.join(pciDevice), { recursive: true });
    await mkdir(path.join(directory, 'drivers', 'i915'), { recursive: true });
    await writeFile(path.join(pciDevice, 'vendor'), '0x8086\n');
    await writeFile(path.join(pciDevice, 'device'), '0xa7a0\n');
    await writeFile(path.join(pciDevice, 'boot_vga'), '1\n');
    await symlink(path.join(directory, 'drivers', 'i915'), path.join(pciDevice, 'driver'));
    const drm = path.join(directory, 'drm');
    await mkdir(path.join(drm, 'card1'), { recursive: true });
    await mkdir(path.join(drm, 'card1-eDP-1'), { recursive: true });
    await symlink(pciDevice, path.join(drm, 'card1', 'device'));
    const runner: DiagnosticsCommandRunner = async (_file, args) => {
      assert.deepEqual(args, ['-mm', '-s', '0000:00:02.0']);
      return { stdout: '00:02.0 "VGA" "Intel Corporation" "Iris Xe"\n', stderr: '' };
    };
    assert.deepEqual(await readLinuxGpus(drm, runner), [{
      name: 'Intel Corporation Iris Xe', vendor: 'Intel', driver: 'i915', pciId: '8086:a7a0', bootVga: true, source: 'sysfs',
    }]);
    const missing: DiagnosticsCommandRunner = async () => { throw Object.assign(new Error('spawn lspci ENOENT'), { code: 'ENOENT' }); };
    assert.equal((await readLinuxGpus(drm, missing))[0].name, 'Intel GPU');
  });
  await assert.rejects(readLinuxGpus(path.join(os.tmpdir(), 'osu-render-no-such-drm')));
});

test('readLogTail returns the last bytes starting at a whole line', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'job.log');
    await writeFile(file, 'first line\nsecond line\nthird\n');
    assert.equal(await readLogTail(file, 1000), 'first line\nsecond line\nthird\n');
    assert.equal(await readLogTail(file, 15), 'third\n');
    assert.equal(await readLogTail(file, 0), undefined);
    assert.equal(await readLogTail(path.join(directory, 'missing.log'), 100), undefined);
    await writeFile(file, '');
    assert.equal(await readLogTail(file, 100), '');
  });
});

test('issue option mapping matches the issue form', async () => {
  const form = await readFile(path.join('.github', 'ISSUE_TEMPLATE', 'gpu-report.yml'), 'utf8');
  for (const option of [...Object.values(ISSUE_OS_OPTIONS), ...Object.values(ISSUE_RESULT_OPTIONS)]) {
    assert.ok(form.includes(`        - ${option}\n`), `issue form is missing option "${option}"`);
  }
  for (const id of ['os', 'gpu', 'driver', 'danser', 'result', 'diagnostics']) assert.ok(form.includes(`id: ${id}\n`));
  assert.equal(issueOsOption('win32', '10.0.22631'), 'Windows 11');
  assert.equal(issueOsOption('win32', '10.0.22000'), 'Windows 11');
  assert.equal(issueOsOption('win32', '10.0.21999'), 'Windows 10');
  assert.equal(issueOsOption('win32', 'garbage'), 'Windows 10');
  assert.equal(issueOsOption('linux', '6.0'), 'Linux');
  assert.equal(issueOsOption('darwin', '24.0'), 'Other / Otro');

  const ok: PreflightResult = { renderer: true, display: true, encoder: 'h264_nvenc', probes: [] };
  const render = { status: 'completed' } as never;
  assert.equal(issueResultOption({ renders: [], preflight: ok }), ISSUE_RESULT_OPTIONS.doctorOnly);
  assert.equal(issueResultOption({ renders: [], preflight: { ...ok, encoder: 'libx264', reason: 'hardware_encoder_unavailable' } }),
    ISSUE_RESULT_OPTIONS.selfTestFailed);
  assert.equal(issueResultOption({ renders: [], preflight: { ...ok, encoder: 'unknown' } }), ISSUE_RESULT_OPTIONS.selfTestFailed);
  assert.equal(issueResultOption({ renders: [{ status: 'queued' } as never, render], preflight: ok }), ISSUE_RESULT_OPTIONS.succeeded);
  assert.equal(issueResultOption({ renders: [{ status: 'failed' } as never, render], preflight: ok }), ISSUE_RESULT_OPTIONS.failed);
});

test('buildIssueUrl prefills fields and truncates the diagnostics field to the limit', () => {
  const base = { issueUrl: 'https://github.com/o/r/issues/new', issueTemplate: 'gpu-report.yml' };
  const url = buildIssueUrl({ title: '[GPU] a b', os: 'Linux', gpu: '', diagnostics: '{"a":1}' }, base);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('template'), 'gpu-report.yml');
  assert.equal(parsed.searchParams.get('title'), '[GPU] a b');
  assert.equal(parsed.searchParams.has('gpu'), false);
  assert.ok(!url.includes('+'), 'spaces are percent-encoded');

  const huge = buildIssueUrl({ title: 't', os: 'Linux', diagnostics: 'é'.repeat(20_000) }, { ...base, maxLength: 8000 });
  assert.ok(huge.length < 8000, `url length ${huge.length}`);
  assert.ok(huge.length > 7000, 'truncation keeps most of the budget');
  assert.ok(new URL(huge).searchParams.get('diagnostics')?.endsWith('…'));
  assert.equal(new URL(huge).searchParams.get('os'), 'Linux');

  const tiny = buildIssueUrl({ title: 'x'.repeat(500), diagnostics: 'y'.repeat(500) }, { ...base, maxLength: 200 });
  assert.ok(tiny.length < 200);
});

const SECRET = 'super-secret-oauth-value-123';
const TOKEN = 'auth-token-value-456';

function fakeTools(directory: string): DanserTools {
  return {
    danserCli: path.join(directory, 'danser-cli'), ffmpeg: path.join(directory, 'ffmpeg', 'ffmpeg'),
    ffprobe: path.join(directory, 'ffmpeg', 'ffprobe'), libraryDirs: [], layout: 'flat', offscreenCapable: false,
  };
}

function settingsFor(danserDir: string): DiagnosticsSettings {
  return {
    host: '192.168.1.50', port: 3030, renderEncoder: 'auto', danserDir, osuClientId: '12345',
    osuClientSecret: SECRET, authToken: TOKEN, mirrors: ['https://mirror.example.com/d/{id}', 'not a url'],
  };
}

function row(overrides: Partial<RenderRow>): RenderRow {
  return {
    id: 'id', created_at: 1, updated_at: 1, status: 'completed', progress: 100, replay_path: '/r.osr', video_path: null,
    client_key: '10.1.2.3', player_name: null, beatmap_checksum: null, beatmap_id: null, beatmapset_id: null, mods: null,
    width: 1920, height: 1080, fps: 60, encoder: 'h264_nvenc', options_json: '{}', error_code: null, error_message: null,
    started_at: null, completed_at: null, expires_at: null, ...overrides,
  };
}

test('collectDiagnostics builds a redacted report from fake services', async () => {
  await withTempDir(async (directory) => {
    const danserDir = path.join(directory, 'danser');
    const logs = path.join(directory, 'data', 'logs');
    await mkdir(path.join(danserDir, 'ffmpeg'), { recursive: true });
    await mkdir(logs, { recursive: true });
    for (const file of ['danser-cli', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe']) await writeFile(path.join(danserDir, file), '');
    await writeFile(path.join(danserDir, 'danser.log'), [
      '2026/10/28 11:53:50 danser-go version: 0.12.1',
      '2026/10/28 11:53:50 GL Renderer:   NVIDIA GeForce RTX 3060/PCIe/SSE2',
      `2026/10/28 11:53:52 FFmpeg exec location: ${os.homedir()}/danser/ffmpeg/ffmpeg`,
    ].join('\n'));
    const failedId = '11111111-1111-4111-8111-111111111111';
    await writeFile(path.join(logs, `${failedId}.log`),
      `Loading replay of SecretPlayer from ${os.homedir()}/x.osr\nout=${failedId}.mp4\nclient 203.0.113.9 token ${TOKEN}\nnvenc init failed\n`);
    const okId = '22222222-2222-4222-8222-222222222222';
    await writeFile(path.join(logs, `${okId}.log`), 'should not be included\n');

    let probeAllCalls = 0;
    const preflight = {
      run: async (): Promise<PreflightResult> => { throw new Error('run must not be called when a result is given'); },
      probeAll: async () => {
        probeAllCalls += 1;
        return [
          { encoder: 'h264_nvenc' as const, ok: true, durationMs: 50 },
          { encoder: 'h264_qsv' as const, ok: false, durationMs: 10, error: 'Error from 198.51.100.7' },
          { encoder: 'libx264' as const, ok: true, durationMs: 20 },
        ];
      },
      tools: async () => fakeTools(danserDir),
    };
    const commands: string[] = [];
    const runCommand: DiagnosticsCommandRunner = async (file, args) => {
      commands.push(`${path.basename(file)} ${args.join(' ')}`);
      if (file === 'powershell') {
        return { stdout: JSON.stringify({ Name: 'NVIDIA GeForce RTX 3060', DriverVersion: '32.0.15.6094', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2504' }), stderr: '' };
      }
      if (file === 'nvidia-smi') return { stdout: 'NVIDIA GeForce RTX 3060, 560.94\n', stderr: '' };
      if (args[0] === '-version') return { stdout: 'ffmpeg version 7.1 Copyright\nbuilt with gcc\n', stderr: '' };
      if (args.includes('-encoders')) return { stdout: ' V....D h264_nvenc  NVENC\n V....D libx264  x264\n', stderr: '' };
      throw new Error(`unexpected ${file}`);
    };
    const report = await collectDiagnostics({
      preflight,
      preflightResult: { renderer: true, display: true, encoder: 'h264_nvenc', probes: [{ encoder: 'h264_nvenc', ok: true, durationMs: 50 }] },
      settings: settingsFor(danserDir),
      paths: { data: path.join(directory, 'data'), logs },
      database: {
        recentRenders: (limit) => [
          row({ id: failedId, status: 'failed', player_name: 'SecretPlayer', error_code: 'RENDER_FAILED', started_at: 1000, completed_at: 4000, created_at: 900 }),
          row({ id: okId, status: 'completed', player_name: 'OtherPlayer', started_at: 100, completed_at: 600, created_at: 50 }),
        ].slice(0, limit),
      },
      storage: { freeBytes: async () => 42 },
      runCommand,
      platform: 'win32',
      now: new Date('2026-10-28T00:00:00Z'),
    });

    assert.equal(probeAllCalls, 1);
    assert.equal(report.schema, 1);
    assert.equal(report.generatedAt, '2026-10-28T00:00:00.000Z');
    assert.equal(report.system.platform, 'win32');
    assert.ok(commands.some((command) => command.startsWith('powershell -NoProfile -NonInteractive -Command')));
    assert.deepEqual(report.gpus.map((gpu) => [gpu.source, gpu.vendor, gpu.driver]),
      [['cim', 'NVIDIA', '32.0.15.6094'], ['nvidia-smi', 'NVIDIA', '560.94']]);
    assert.deepEqual(report.danser.files, { danserCli: true, ffmpeg: true, ffprobe: true });
    assert.equal(report.danser.version, '0.12.1');
    assert.equal(report.danser.log?.ffmpegLocation, '~/danser/ffmpeg/ffmpeg');
    assert.equal(report.danser.ffmpegVersion, 'ffmpeg version 7.1 Copyright');
    assert.deepEqual(report.danser.ffmpegEncoders, ['h264_nvenc', 'libx264']);
    assert.equal(report.encoderProbes.length, 3);
    assert.equal(report.encoderProbes[1].error, 'Error from <ip>');
    assert.deepEqual(report.config, {
      host: 'other', port: 3030, renderEncoder: 'auto', oauthConfigured: true, authTokenSet: true,
      mirrors: ['mirror.example.com', 'invalid'],
    });
    assert.deepEqual(report.storage, { freeBytes: 42 });
    assert.equal(report.renders.length, 2);
    assert.deepEqual(report.renders.map((render) => render.index), [1, 2]);
    assert.equal(report.renders[0].renderMs, 3000);
    assert.equal(report.renders[0].errorCode, 'RENDER_FAILED');
    assert.match(report.renders[0].logTail ?? '', /Loading replay of <player> from ~\/x\.osr\nout=<render-id>\.mp4\nclient <ip> token <secret>\nnvenc init failed/);
    assert.equal(report.renders[1].logTail, undefined);
    assert.equal(report.errors.length, 0);

    const json = JSON.stringify(report);
    assert.match(report.renders[0].logTail ?? '', /out=<render-id>\.mp4/);
    for (const forbidden of [failedId, okId, SECRET, TOKEN, 'SecretPlayer', 'OtherPlayer', '10.1.2.3', '203.0.113.9', '198.51.100.7', '192.168.1.50', '/r.osr', os.homedir()]) {
      assert.ok(!json.includes(forbidden), `report must not contain ${forbidden}`);
    }
    for (const id of [failedId, okId]) {
      assert.ok(!report.issue.url.includes(id) && !report.issue.url.includes(encodeURIComponent(id)), 'issue url must not contain render ids');
    }
    assert.ok(!json.includes('client_key') && !json.includes('player_name') && !json.includes('replay_path'));

    const url = new URL(report.issue.url);
    assert.ok(report.issue.url.length < 8000);
    assert.equal(url.searchParams.get('template'), 'gpu-report.yml');
    assert.equal(url.searchParams.get('result'), ISSUE_RESULT_OPTIONS.failed);
    assert.equal(url.searchParams.get('gpu'), 'NVIDIA GeForce RTX 3060');
    assert.equal(url.searchParams.get('driver'), 'NVIDIA 560.94');
    assert.equal(url.searchParams.get('danser'), '0.12.1');
    assert.ok(['Windows 10', 'Windows 11'].includes(url.searchParams.get('os') ?? ''));
    assert.equal(JSON.parse(url.searchParams.get('diagnostics') ?? '{}').preflight.encoder, 'h264_nvenc');
    assert.ok(report.issue.body.length <= 1500);
    assert.match(report.issue.body, /Encoder: h264_nvenc \(hardware\)/);
    assert.match(report.issue.body, /h264_qsv FAIL/);
    assert.match(report.issue.body, /Last render: failed \(h264_nvenc, 1920x1080, 3\.0 s, RENDER_FAILED\)/);
  });
});

test('collectDiagnostics tolerates every probe failing', async () => {
  await withTempDir(async (directory) => {
    const failing: DiagnosticsCommandRunner = async () => { throw Object.assign(new Error('boom'), { stderr: 'bad things' }); };
    const report = await collectDiagnostics({
      preflight: {
        run: async () => { throw new Error('preflight exploded'); },
        probeAll: async () => { throw new Error('probe exploded'); },
        tools: async () => fakeTools(path.join(directory, 'missing')),
      },
      settings: { ...settingsFor(path.join(directory, 'missing')), osuClientSecret: '', authToken: '' },
      paths: { data: path.join(directory, 'nope', 'data'), logs: path.join(directory, 'nope', 'logs') },
      database: { recentRenders: () => { throw new Error('database locked'); } },
      runCommand: failing,
      platform: 'linux',
      sysDrmDir: path.join(directory, 'no-drm'),
    });
    assert.equal(report.preflight.encoder, 'unknown');
    assert.deepEqual(report.encoderProbes, []);
    assert.deepEqual(report.renders, []);
    assert.deepEqual(report.gpus, []);
    assert.deepEqual(report.danser.files, { danserCli: false, ffmpeg: false, ffprobe: false });
    assert.equal(report.config.oauthConfigured, false);
    assert.equal(typeof report.storage.freeBytes, 'number');
    const sources = report.errors.map((error) => error.source);
    for (const source of ['preflight', 'encoderProbes', 'renders', 'gpus.sysfs', 'gpus.nvidia-smi', 'ffmpeg.version']) {
      assert.ok(sources.includes(source), `missing error for ${source}: ${sources.join(', ')}`);
    }
    assert.equal(new URL(report.issue.url).searchParams.get('result'), ISSUE_RESULT_OPTIONS.selfTestFailed);
  });
});

test('player names matching encoder or GPU words only scrub free text', async () => {
  await withTempDir(async (directory) => {
    const logs = path.join(directory, 'logs');
    await mkdir(logs, { recursive: true });
    const names = ['nv', 'amd', 'x264', 'intel'];
    const rows = names.map((name, index) => row({
      id: `4444444${index}-4444-4444-8444-444444444444`, status: 'failed', player_name: name, encoder: 'h264_nvenc',
      error_code: 'RENDER_FAILED', created_at: 100 - index,
    }));
    for (const [index, name] of names.entries()) {
      await writeFile(path.join(logs, `${rows[index].id}.log`), `Replay by ${name} loaded\nh264_nvenc libx264 amdgpu\n`);
    }
    const report = await collectDiagnostics({
      preflight: {
        run: async () => ({ renderer: true, display: true, encoder: 'h264_qsv', probes: [] }),
        probeAll: async () => [
          { encoder: 'h264_nvenc' as const, ok: false, durationMs: 1, error: 'nv driver missing for intel' },
          { encoder: 'libx264' as const, ok: true, durationMs: 1 },
        ],
        tools: async () => fakeTools(path.join(directory, 'danser')),
      },
      settings: settingsFor(path.join(directory, 'danser')),
      paths: { data: directory, logs },
      database: { recentRenders: () => rows },
      runCommand: async (file) => {
        if (file === 'powershell') return { stdout: '{"Name":"Intel(R) UHD Graphics","AdapterCompatibility":"Intel Corporation","PNPDeviceID":"PCI\\\\VEN_8086&DEV_4680"}', stderr: '' };
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      platform: 'win32',
    });
    assert.deepEqual(report.gpus.map((gpu) => [gpu.name, gpu.vendor]), [['Intel(R) UHD Graphics', 'Intel']]);
    assert.deepEqual(report.encoderProbes.map((probe) => probe.encoder), ['h264_nvenc', 'libx264']);
    assert.equal(report.encoderProbes[0].error, '<player> driver missing for <player>');
    assert.equal(report.preflight.encoder, 'h264_qsv');
    for (const render of report.renders) {
      assert.equal(render.encoder, 'h264_nvenc');
      assert.equal(render.status, 'failed');
      assert.equal(render.logTail, 'Replay by <player> loaded\nh264_nvenc libx264 amdgpu\n');
    }
    assert.equal(new URL(report.issue.url).searchParams.get('gpu'), 'Intel(R) UHD Graphics');
  });
});

test('skipProbes reports the preflight probes instead of running new ones', async () => {
  await withTempDir(async (directory) => {
    const preflightProbes = [{ encoder: 'h264_qsv' as const, ok: true, durationMs: 5 }];
    const report = await collectDiagnostics({
      preflight: {
        run: async () => { throw new Error('unused'); },
        probeAll: async () => { throw new Error('probeAll must not run during a render'); },
        tools: async () => fakeTools(path.join(directory, 'danser')),
      },
      preflightResult: { renderer: true, display: true, encoder: 'h264_qsv', probes: preflightProbes },
      settings: settingsFor(path.join(directory, 'danser')),
      paths: { data: directory, logs: directory },
      runCommand: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      platform: 'darwin',
      skipProbes: 'render_active',
    });
    assert.equal(report.probesSkipped, 'render_active');
    assert.deepEqual(report.encoderProbes, preflightProbes);
    assert.ok(!report.errors.some((error) => error.source === 'encoderProbes'));
  });
});
