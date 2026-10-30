import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPaths, settings } from './config.js';
import { RenderDatabase } from './database.js';
import { collectDiagnostics } from './diagnostics.js';
import { PreflightService } from './preflight.js';
import { redactText } from './platform.js';
import { Updater } from './updater.js';

// stdout carries only the JSON report in --json mode; route any stray console output to stderr.
console.log = console.error;
console.info = console.error;

const json = process.argv.includes('--json');
const paths = getPaths();
const preflight = new PreflightService({
  danserDir: settings.danserDir, danserBin: settings.danserBin, renderEncoder: settings.renderEncoder,
});

let database: RenderDatabase | undefined;
if (existsSync(paths.db)) {
  try { database = new RenderDatabase(paths.db, { readonly: true }); } catch (error) {
    process.stderr.write(`Render history skipped: ${redactText(error instanceof Error ? error.message : String(error))}\n`);
  }
}

try {
  // Read-only use: doctor never applies updates, it only asks GitHub for the newest release.
  const updater = new Updater({ isBusy: () => false, restart: () => undefined });
  const report = await collectDiagnostics({ preflight, settings, paths, database, updateStatus: () => updater.checkLatest(true) });
  const file = path.join(paths.diagnostics, `doctor-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  let written = false;
  try {
    await mkdir(paths.diagnostics, { recursive: true });
    await writeFile(file, text, { mode: 0o600 });
    written = true;
  } catch (error) {
    process.stderr.write(`Could not write report file: ${redactText(error instanceof Error ? error.message : String(error))}\n`);
  }
  if (json) {
    process.stdout.write(text);
  } else {
    process.stderr.write(`${report.issue.body}\n\n`);
    for (const failure of report.errors) process.stderr.write(`! ${failure.source}: ${failure.error}\n`);
  }
  if (written) process.stderr.write(`Report written to ${redactText(file)}\n`);
  if (!json) process.stderr.write(`Open a GitHub issue: ${report.issue.url.slice(0, report.issue.url.indexOf('?'))}\n`);
  process.exitCode = report.preflight.encoder === 'unknown' ? 1 : 0;
} finally {
  database?.close();
}
