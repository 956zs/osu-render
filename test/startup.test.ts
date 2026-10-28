import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const START_TIMEOUT_MS = 15_000;

test('compiled service starts with the public UI available', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-startup-'));
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: dataDirectory,
      DANSER_DIR: path.join(dataDirectory, 'danser'),
      DANSER_BIN: path.join(dataDirectory, 'danser', 'danser-cli'),
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const output = await waitForStartup(child);
    assert.match(output, /"event":"service_started"/);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

function waitForStartup(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), START_TIMEOUT_MS);
    const consume = (chunk: Buffer): void => {
      output += chunk.toString();
      if (!output.includes('"event":"service_started"')) return;
      clearTimeout(timer);
      resolve(output);
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('exit', (code) => {
      if (!output.includes('"event":"service_started"')) {
        clearTimeout(timer);
        reject(new Error(`service exited with code ${code}: ${output}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
