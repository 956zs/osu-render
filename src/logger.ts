export type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level, event, ...fields,
  })}\n`);
}
