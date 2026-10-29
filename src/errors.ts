import { redactText } from './platform.js';

const ERROR_DETAIL_CHARS = 500;
/** Absolute POSIX, drive-letter and UNC paths; only the last segment is kept. Quoted paths may contain spaces. */
const PATH_ROOT = String.raw`(?:\/|[A-Za-z]:[\\/]|\\\\)`;
const QUOTED_PATH = new RegExp(String.raw`(['"\x60])${PATH_ROOT}(?:[^'"\x60\\/]*[\\/])*([^'"\x60\\/]*)\1`, 'g');
const BARE_PATH = new RegExp(String.raw`(?<![\w.:/\\~…-])${PATH_ROOT}(?=[^\s'"\x60])(?:[^\s'"\x60\\/]+[\\/])*([^\s'"\x60\\/]*)`, 'g');

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(code: string, publicMessage: string, statusCode = 400) {
    super(publicMessage);
    this.name = 'AppError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.statusCode = statusCode;
  }
}

export class StorageLowError extends AppError {
  constructor() {
    super('STORAGE_LOW', 'Not enough free storage is available.', 503);
  }
}

export function publicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
    return new AppError('REPLAY_TOO_LARGE', 'Replay file exceeds the 5 MiB limit.', 413);
  }
  return new AppError('INTERNAL_ERROR', 'The render service encountered an internal error.', 500);
}

/**
 * Short internal cause of an unexpected failure (stored for reports, never shown to users):
 * error name + message, absolute paths reduced to their last segment, home dir and user name redacted.
 * Returns null for expected AppErrors.
 */
export function internalErrorDetail(error: unknown): string | null {
  if (error instanceof AppError && error.code !== 'INTERNAL_ERROR') return null;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : `${typeof error}: ${String(error)}`;
  const withoutPaths = text
    .replace(QUOTED_PATH, (_path, quote: string, last: string) => `${quote}…/${last}${quote}`)
    .replace(BARE_PATH, (_path, last: string) => `…/${last}`);
  const safe = redactText(withoutPaths).replace(/\s+/g, ' ').trim();
  return safe.length <= ERROR_DETAIL_CHARS ? safe : `${safe.slice(0, ERROR_DETAIL_CHARS - 1)}…`;
}
