import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DOCTOR = path.resolve('dist/src/doctor.js');

test('doctor --json prints only the JSON report and exits 1 without an encoder', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-doctor-'));
  const emptyPath = path.join(directory, 'empty-path');
  await mkdir(emptyPath);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(path|service_root|danser_bin|render_encoder)$/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    PATH: emptyPath, DATA_DIR: path.join(directory, 'data'), DANSER_DIR: path.join(directory, 'no-danser'),
    OSU_CLIENT_SECRET: 'doctor-secret-value', AUTH_TOKEN: 'doctor-token-value',
    REPORT_WEBHOOK_URL: 'https://discord.com/api/webhooks/1234567890/doctor-webhook-token',
  });
  try {
    const child = spawn(process.execPath, [DOCTOR, '--json'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    const report = JSON.parse(stdout);
    assert.equal(code, 1, stderr);
    assert.equal(report.schema, 1);
    assert.equal(report.preflight.encoder, 'unknown');
    assert.equal(report.preflight.renderer, false);
    assert.deepEqual(report.danser.files, { danserCli: false, ffmpeg: false, ffprobe: false });
    assert.equal(report.config.oauthConfigured, false);
    assert.equal(report.config.authTokenSet, true);
    assert.equal(report.config.reportWebhook, true);
    for (const secret of ['doctor-secret-value', 'doctor-token-value', 'doctor-webhook-token']) {
      assert.ok(!stdout.includes(secret) && !stderr.includes(secret), secret);
    }
    assert.match(stderr, /Report written to/);
    const files = await readdir(path.join(directory, 'data', 'diagnostics'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^doctor-.*\.json$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
