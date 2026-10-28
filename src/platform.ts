import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ToolsLayout = 'bin-lib' | 'flat' | 'path';

export interface DanserTools {
  danserCli: string;
  ffmpeg: string;
  ffprobe: string;
  libraryDirs: string[];
  layout: ToolsLayout;
  offscreenCapable: boolean;
}

export interface RedactionContext {
  home: string;
  user: string;
  platform: NodeJS.Platform;
}

type Spawner = (command: string, args: string[], options: { windowsHide: boolean; stdio: 'ignore' }) => ChildProcess;

export function executableName(base: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${base}.exe` : base;
}

export async function resolveDanserTools(
  danserDir: string,
  danserBin?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<DanserTools> {
  const ffmpegDir = path.join(danserDir, 'ffmpeg');
  const ffmpeg = await findTool(danserDir, 'ffmpeg', platform);
  const ffprobe = await findTool(danserDir, 'ffprobe', platform);
  const libraryDirs = platform === 'win32' ? [] : await existingDirectories([path.join(ffmpegDir, 'lib'), ffmpegDir]);
  return {
    danserCli: danserBin || path.join(danserDir, executableName('danser-cli', platform)),
    ffmpeg: ffmpeg.file, ffprobe: ffprobe.file, libraryDirs, layout: ffmpeg.layout,
    offscreenCapable: platform === 'linux' && await hasSdl3(danserDir),
  };
}

export function libraryEnvironment(
  libraryDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === 'win32' || libraryDirs.length === 0) return { ...env };
  const variable = platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  const current = env[variable];
  return { ...env, [variable]: [...libraryDirs, ...(current ? [current] : [])].join(':') };
}

export function terminateProcessTree(
  child: ChildProcess,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
  spawner: Spawner = spawn,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    return;
  }
  const args = ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])];
  const killer = spawner('taskkill', args, { windowsHide: true, stdio: 'ignore' });
  killer.once('error', () => { child.kill(); });
  killer.once('exit', (code) => { if (code !== 0 && force) child.kill(); });
}

export function redactText(text: string, context: RedactionContext = defaultRedactionContext()): string {
  let result = text;
  const { home, user, platform } = context;
  const flags = platform === 'win32' ? 'gi' : 'g';
  const parser = platform === 'win32' ? path.win32 : path.posix;
  if (home && parser.parse(home).root !== home) {
    const forms = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\')]);
    for (const form of [...forms].sort((left, right) => right.length - left.length)) {
      result = result.replace(new RegExp(`${escapeRegExp(form)}(?![\\w-])`, flags), '~');
    }
  }
  if (user.length >= 2) {
    result = result.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`, flags), '<user>');
  }
  return result;
}

function defaultRedactionContext(): RedactionContext {
  let user = process.env.USER ?? process.env.USERNAME ?? '';
  try { user = os.userInfo().username || user; } catch { /* keep environment fallback */ }
  return { home: os.homedir(), user, platform: process.platform };
}

async function findTool(
  danserDir: string,
  name: 'ffmpeg' | 'ffprobe',
  platform: NodeJS.Platform,
): Promise<{ file: string; layout: ToolsLayout }> {
  const executable = executableName(name, platform);
  const candidates: Array<{ file: string; layout: ToolsLayout }> = [
    { file: path.join(danserDir, 'ffmpeg', 'bin', executable), layout: 'bin-lib' },
    { file: path.join(danserDir, 'ffmpeg', executable), layout: 'flat' },
    { file: path.join(danserDir, executable), layout: 'flat' },
  ];
  for (const candidate of candidates) if (await isFile(candidate.file)) return candidate;
  return { file: name, layout: 'path' };
}

async function existingDirectories(directories: string[]): Promise<string[]> {
  const checks = await Promise.all(directories.map(async (directory) => {
    try { return (await stat(directory)).isDirectory(); } catch { return false; }
  }));
  return directories.filter((_directory, index) => checks[index]);
}

async function hasSdl3(danserDir: string): Promise<boolean> {
  try { return (await readdir(danserDir)).some((name) => /^libSDL3\.so(\.|$)/.test(name)); } catch { return false; }
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
