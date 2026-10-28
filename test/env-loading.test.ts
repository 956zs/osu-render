import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CONFIG_VARIABLES = [
  'SERVICE_ROOT', 'DATA_DIR', 'DANSER_DIR', 'DANSER_BIN', 'DANSER_BASE_SETTINGS', 'DANSER_SKINS_DIR',
  'RENDER_ENCODER', 'DANSER_SETTINGS_NAME', 'OSU_CLIENT_ID', 'OSU_CLIENT_SECRET',
];

async function loadConfig(dotenv: string, overrides: NodeJS.ProcessEnv, expression: string): Promise<unknown> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-env-'));
  const configModule = pathToFileURL(path.resolve('dist/src/config.js')).href;
  await writeFile(path.join(directory, '.env'), dotenv);
  try {
    const script = `import(${JSON.stringify(configModule)}).then(({ settings, getPaths }) => {`
      + `const paths = getPaths(); const rel = (value) => value && require('node:path').relative(process.cwd(), value);`
      + `console.log(JSON.stringify(${expression})); })`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of CONFIG_VARIABLES) delete env[name];
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=commonjs', '-e', script], {
      cwd: directory, env: { ...env, ...overrides },
    });
    return JSON.parse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('compiled config loads OAuth credentials from .env', async () => {
  const values = await loadConfig('OSU_CLIENT_ID=123\nOSU_CLIENT_SECRET=test-secret\n', {},
    '[settings.osuClientId, settings.osuClientSecret]');
  assert.deepEqual(values, ['123', 'test-secret']);
});

test('shell environment wins over .env', async () => {
  const values = await loadConfig('OSU_CLIENT_ID=from-file\n', { OSU_CLIENT_ID: 'from-shell' }, 'settings.osuClientId');
  assert.equal(values, 'from-shell');
});

test('paths default to the service root on every platform', async () => {
  const values = await loadConfig('', {}, `{ data: rel(settings.dataDir), danser: rel(settings.danserDir),
    bin: settings.danserBin ?? null, base: rel(settings.danserBaseSettings), skins: rel(settings.danserSkinsDir),
    encoder: settings.renderEncoder, danserSettings: rel(paths.danserSettings), logs: rel(paths.logs),
    diagnostics: rel(paths.diagnostics) }`);
  assert.deepEqual(values, {
    data: 'data', danser: 'danser', bin: null, base: path.join('danser', 'settings', 'default.json'),
    skins: path.join('data', 'skins'), encoder: 'auto', danserSettings: path.join('danser', 'settings', 'service.json'),
    logs: path.join('data', 'logs'), diagnostics: path.join('data', 'diagnostics'),
  });
});

test('relative paths, settings name and encoder override are honoured', async () => {
  const values = await loadConfig('DANSER_DIR=engines/danser\nDANSER_BIN=bin/danser-cli\n', {
    DANSER_SETTINGS_NAME: 'osu_render-2', RENDER_ENCODER: 'H264_NVENC',
  }, '[rel(settings.danserBin), rel(paths.danserSettings), settings.renderEncoder]');
  assert.deepEqual(values, [
    path.join('bin', 'danser-cli'), path.join('engines', 'danser', 'settings', 'osu_render-2.json'), 'h264_nvenc',
  ]);
});

test('invalid encoder and settings name fail at startup with a clear error', async () => {
  await assert.rejects(loadConfig('', { RENDER_ENCODER: 'h264_vaapi' }, 'null'), { stderr: /RENDER_ENCODER must be "auto"/ });
  await assert.rejects(loadConfig('', { DANSER_SETTINGS_NAME: '../evil' }, 'null'), { stderr: /DANSER_SETTINGS_NAME must match/ });
});
