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
