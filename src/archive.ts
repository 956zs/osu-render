import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { AppError } from './errors.js';

export interface ArchiveLimits {
  maxEntries: number;
  maxExtractedBytes: number;
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('failed to open zip'));
      else resolve(zip);
    });
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry): void => { cleanup(); resolve(entry); };
    const onEnd = (): void => { cleanup(); resolve(null); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => {
      zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError);
    };
    zip.once('entry', onEntry); zip.once('end', onEnd); zip.once('error', onError);
    zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('failed to read archive entry'));
      else resolve(stream);
    });
  });
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;
const MAX_SEGMENT_LENGTH = 255;

type EntryKind = 'file' | 'directory';

export function validateArchiveEntryName(fileName: string): string {
  if (fileName === '') throw new Error('empty archive path');
  if (/[\u0000-\u001f\\:<>"|?*]/.test(fileName)) throw new Error('invalid character in archive path');
  if (fileName.startsWith('/')) throw new Error('absolute archive path');
  const segments = (fileName.endsWith('/') ? fileName.slice(0, -1) : fileName).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new Error('invalid archive path segment');
    if (segment.length > MAX_SEGMENT_LENGTH) throw new Error('archive path segment is too long');
    if (/[. ]$/.test(segment)) throw new Error('archive path segment ends with a dot or space');
    if (RESERVED_NAMES.test(segment.split('.')[0].trimEnd())) throw new Error('reserved name in archive path');
  }
  return segments.join('/');
}

function assertRegularEntry(entry: Entry): void {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error('archive contains a non-regular file');
  }
}

function recordEntry(seen: Map<string, EntryKind>, relative: string, kind: EntryKind): void {
  const segments = relative.toLowerCase().split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const key = segments.slice(0, index).join('/');
    const current = index === segments.length ? kind : 'directory';
    const previous = seen.get(key);
    if (previous && (previous === 'file' || current === 'file')) throw new Error('duplicate archive entry');
    seen.set(key, current);
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertInsideRoot(root: string, target: string): Promise<void> {
  if (!isInside(root, await realpath(path.dirname(target)))) throw new Error('archive escaped extraction root');
}

export async function extractOsz(input: string, output: string, limits: ArchiveLimits): Promise<void> {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const root = await realpath(output);
  const zip = await openZip(input);
  const seen = new Map<string, EntryKind>();
  let entries = 0;
  let extractedBytes = 0;
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      entries += 1;
      extractedBytes += entry.uncompressedSize;
      if (entries > limits.maxEntries || extractedBytes > limits.maxExtractedBytes) {
        throw new Error('archive exceeds extraction limits');
      }
      assertRegularEntry(entry);
      const relative = validateArchiveEntryName(entry.fileName);
      const kind = entry.fileName.endsWith('/') ? 'directory' : 'file';
      recordEntry(seen, relative, kind);
      const target = path.join(root, ...relative.split('/'));
      if (!isInside(root, target)) throw new Error('archive path traversal');
      if (kind === 'directory') { await mkdir(target, { recursive: true }); continue; }
      await mkdir(path.dirname(target), { recursive: true });
      await assertInsideRoot(root, target);
      await pipeline(await openEntry(zip, entry), createWriteStream(target, { flags: 'wx', mode: 0o644 }));
    }
  } catch (error) {
    zip.close();
    await rm(output, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('BEATMAP_INVALID_ARCHIVE', message, 422);
  }
}

export async function md5File(filePath: string): Promise<string> {
  const hash = createHash('md5');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function directorySize(root: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    total += entry.isDirectory() ? await directorySize(current) : (await stat(current)).size;
  }
  return total;
}

export async function installExtracted(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
}
