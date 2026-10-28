import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('compiled config loads OAuth credentials from .env', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-env-'));
  const configModule = path.resolve('dist/src/config.js');
  await writeFile(path.join(directory, '.env'), 'OSU_CLIENT_ID=123\nOSU_CLIENT_SECRET=test-secret\n');
  try {
    const script = `import(${JSON.stringify(`file://${configModule}`)}).then(({ settings }) => `
      + `console.log(JSON.stringify([settings.osuClientId, settings.osuClientSecret])))`;
    const env = { ...process.env, OSU_CLIENT_ID: undefined, OSU_CLIENT_SECRET: undefined };
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory, env,
    });
    assert.deepEqual(JSON.parse(stdout), ['123', 'test-secret']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
