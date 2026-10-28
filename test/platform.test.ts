import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  executableName, libraryEnvironment, redactText, renameWithRetry, resolveDanserTools, terminateProcessTree,
} from '../src/platform.js';

async function withDanserDir(files: string[], run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-platform-'));
  try {
    for (const file of files) {
      const target = path.join(directory, ...file.split('/'));
      if (file.endsWith('/')) await mkdir(target, { recursive: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, '');
      }
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('executable names gain .exe only on Windows', () => {
  assert.equal(executableName('ffmpeg', 'win32'), 'ffmpeg.exe');
  assert.equal(executableName('ffmpeg', 'linux'), 'ffmpeg');
  assert.equal(executableName('danser-cli', 'darwin'), 'danser-cli');
});

test('danser 0.12 linux layout uses ffmpeg/bin and ffmpeg/lib and records offscreen', async () => {
  await withDanserDir(['ffmpeg/bin/ffmpeg', 'ffmpeg/bin/ffprobe', 'ffmpeg/lib/', 'libSDL3.so.0'], async (directory) => {
    const tools = await resolveDanserTools(directory, undefined, 'linux');
    assert.equal(tools.danserCli, path.join(directory, 'danser-cli'));
    assert.equal(tools.ffmpeg, path.join(directory, 'ffmpeg', 'bin', 'ffmpeg'));
    assert.equal(tools.ffprobe, path.join(directory, 'ffmpeg', 'bin', 'ffprobe'));
    assert.deepEqual(tools.libraryDirs, [path.join(directory, 'ffmpeg', 'lib'), path.join(directory, 'ffmpeg')]);
    assert.equal(tools.layout, 'bin-lib');
    assert.equal(tools.offscreenCapable, true);
  });
});

test('danser 0.11 linux layout is flat and needs a display', async () => {
  await withDanserDir(['ffmpeg/ffmpeg', 'ffmpeg/ffprobe', 'ffmpeg/libavcodec.so.61'], async (directory) => {
    const tools = await resolveDanserTools(directory, undefined, 'linux');
    assert.equal(tools.ffmpeg, path.join(directory, 'ffmpeg', 'ffmpeg'));
    assert.deepEqual(tools.libraryDirs, [path.join(directory, 'ffmpeg')]);
    assert.equal(tools.layout, 'flat');
    assert.equal(tools.offscreenCapable, false);
  });
});

test('windows layout uses .exe tools and no library dirs', async () => {
  await withDanserDir(['ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe', 'libSDL3.so'], async (directory) => {
    const tools = await resolveDanserTools(directory, undefined, 'win32');
    assert.equal(tools.danserCli, path.join(directory, 'danser-cli.exe'));
    assert.equal(tools.ffmpeg, path.join(directory, 'ffmpeg', 'ffmpeg.exe'));
    assert.equal(tools.ffprobe, path.join(directory, 'ffmpeg', 'ffprobe.exe'));
    assert.deepEqual(tools.libraryDirs, []);
    assert.equal(tools.layout, 'flat');
    assert.equal(tools.offscreenCapable, false);
  });
});

test('ffmpeg beside danser is found before PATH', async () => {
  await withDanserDir(['ffmpeg.exe'], async (directory) => {
    const tools = await resolveDanserTools(directory, undefined, 'win32');
    assert.equal(tools.ffmpeg, path.join(directory, 'ffmpeg.exe'));
    assert.equal(tools.ffprobe, 'ffprobe');
  });
});

test('missing bundled ffmpeg falls back to PATH and honours DANSER_BIN', async () => {
  await withDanserDir([], async (directory) => {
    const custom = path.join(directory, 'custom-danser');
    const tools = await resolveDanserTools(directory, custom, 'linux');
    assert.deepEqual(tools, {
      danserCli: custom, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', libraryDirs: [], layout: 'path', offscreenCapable: false,
    });
  });
  const missing = await resolveDanserTools(path.join(os.tmpdir(), 'osu-render-does-not-exist'), undefined, 'linux');
  assert.equal(missing.layout, 'path');
});

test('library environment prepends dirs per platform without mutating the input', () => {
  const env = { LD_LIBRARY_PATH: '/usr/lib', DYLD_LIBRARY_PATH: '/opt/lib', KEEP: '1' };
  assert.equal(libraryEnvironment(['/a', '/b'], env, 'linux').LD_LIBRARY_PATH, '/a:/b:/usr/lib');
  assert.equal(libraryEnvironment(['/a'], {}, 'linux').LD_LIBRARY_PATH, '/a');
  assert.equal(libraryEnvironment(['/a'], env, 'darwin').DYLD_LIBRARY_PATH, '/a:/opt/lib');
  const windows = libraryEnvironment(['C:\\x'], env, 'win32');
  assert.deepEqual(windows, env);
  assert.notEqual(windows, env);
  assert.deepEqual(libraryEnvironment([], env, 'linux'), env);
  assert.equal(env.LD_LIBRARY_PATH, '/usr/lib');
});

function fakeChild(pid?: number): ChildProcess & { signals: unknown[] } {
  const signals: unknown[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid, exitCode: null, signalCode: null, signals,
    kill(signal?: unknown) { signals.push(signal); return true; },
  });
  return child as unknown as ChildProcess & { signals: unknown[] };
}

function fakeSpawner(calls: Array<{ command: string; args: string[] }>, exitCode = 0) {
  return (command: string, args: string[]) => {
    calls.push({ command, args });
    const killer = new EventEmitter();
    setImmediate(() => killer.emit('exit', exitCode));
    return killer as ChildProcess;
  };
}

test('windows process trees are always force-terminated with taskkill', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  terminateProcessTree(fakeChild(123), true, 'win32', fakeSpawner(calls));
  terminateProcessTree(fakeChild(124), false, 'win32', fakeSpawner(calls));
  assert.deepEqual(calls, [
    { command: 'taskkill', args: ['/PID', '123', '/T', '/F'] },
    { command: 'taskkill', args: ['/PID', '124', '/T', '/F'] },
  ]);
});

test('failed taskkill falls back to killing the child', async () => {
  const child = fakeChild(125);
  terminateProcessTree(child, true, 'win32', fakeSpawner([], 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.signals.length, 1);
});

test('posix termination uses signals and skips exited children', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const child = fakeChild(200);
  terminateProcessTree(child, false, 'linux', fakeSpawner(calls));
  terminateProcessTree(child, true, 'linux', fakeSpawner(calls));
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  const exited = Object.assign(fakeChild(201), { exitCode: 0 });
  terminateProcessTree(exited, true, 'win32', fakeSpawner(calls));
  assert.deepEqual(exited.signals, []);
  assert.deepEqual(calls, []);
});

test('redaction replaces the posix home dir and username', () => {
  const context = { home: '/home/alice', user: 'alice', platform: 'linux' as const };
  assert.equal(redactText('open /home/alice/danser/x.osr by alice@host', context), 'open ~/danser/x.osr by <user>@host');
  assert.equal(redactText('/home/alice', context), '~');
  assert.equal(redactText('/home/alicebob/x malice', context), '/home/alicebob/x malice');
  assert.equal(redactText('/HOME/ALICE/x', context), '/HOME/ALICE/x');
  assert.equal(redactText('', context), '');
});

test('redaction handles windows separators and case', () => {
  const context = { home: 'C:\\Users\\Bob', user: 'Bob', platform: 'win32' as const };
  assert.equal(redactText('c:\\users\\bob\\AppData\\danser', context), '~\\AppData\\danser');
  assert.equal(redactText('C:/Users/Bob/danser', context), '~/danser');
  assert.equal(redactText('"C:\\\\Users\\\\Bob\\\\x"', context), '"~\\\\x"');
  assert.equal(redactText('user BOB failed', context), 'user <user> failed');
});

test('redaction skips filesystem roots and one-letter usernames', () => {
  assert.equal(redactText('/x a b', { home: '/', user: 'a', platform: 'linux' }), '/x a b');
  assert.equal(redactText('C:\\x', { home: 'C:\\', user: '', platform: 'win32' }), 'C:\\x');
  assert.match(redactText(path.join(os.homedir(), 'x')), /^~/);
});

test('windows DANSER_BIN without an extension gains .exe', async () => {
  await withDanserDir([], async (directory) => {
    const bare = path.join(directory, 'danser-cli');
    assert.equal((await resolveDanserTools(directory, bare, 'win32')).danserCli, `${bare}.exe`);
    assert.equal((await resolveDanserTools(directory, `${bare}.EXE`, 'win32')).danserCli, `${bare}.EXE`);
    assert.equal((await resolveDanserTools(directory, bare, 'linux')).danserCli, bare);
  });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('renameWithRetry retries transient windows lock errors', async () => {
  const calls: string[] = [];
  const failures = ['EBUSY', 'EPERM', 'EACCES'];
  await renameWithRetry('a', 'b', {
    delayMs: 1,
    renameFile: async (from, to) => { calls.push(`${from}>${to}`); const code = failures.shift(); if (code) throw errno(code); },
  });
  assert.equal(calls.length, 4);
});

test('renameWithRetry gives up after the attempt limit and on other errors', async () => {
  let calls = 0;
  const failing = async () => { calls += 1; throw errno('EBUSY'); };
  await assert.rejects(renameWithRetry('a', 'b', { attempts: 3, delayMs: 1, renameFile: failing }), { code: 'EBUSY' });
  assert.equal(calls, 3);
  calls = 0;
  const missing = async () => { calls += 1; throw errno('ENOENT'); };
  await assert.rejects(renameWithRetry('a', 'b', { delayMs: 1, renameFile: missing }), { code: 'ENOENT' });
  assert.equal(calls, 1);
});
