// Release notes from commit subjects: node scripts/release-changelog.mjs [from|auto] [to]
// Conventional commits only: feat → New, fix → Fixes, perf → Speed; everything else is left out.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Section headings the in-app "What's new" parser looks for; keep them in sync with src/updater.ts. */
export const SECTIONS = ['New', 'Fixes', 'Speed'];
const SECTION_OF_TYPE = { feat: 'New', fix: 'Fixes', perf: 'Speed' };
const SUBJECT_PATTERN = /^([a-z]+)(?:\(([^()]*)\))?!?:\s*(.+)$/i;

/** "feat(ui): add x" → { section: 'New', text: 'Add x (ui)' }; null for any other kind of commit. */
export function parseSubject(subject) {
  const match = SUBJECT_PATTERN.exec(String(subject ?? '').trim());
  if (!match) return null;
  const section = SECTION_OF_TYPE[match[1].toLowerCase()];
  const description = match[3].trim();
  if (!section || !description) return null;
  const scope = match[2]?.trim();
  const text = description.charAt(0).toUpperCase() + description.slice(1);
  return { section, text: scope ? `${text} (${scope})` : text };
}

/** Markdown with one "### <section>" list per non-empty section, or "" when no commit qualifies. */
export function formatChangelog(subjects) {
  const groups = new Map(SECTIONS.map((section) => [section, []]));
  for (const subject of subjects) {
    const entry = parseSubject(subject);
    if (!entry) continue;
    const lines = groups.get(entry.section);
    if (!lines.includes(entry.text)) lines.push(entry.text);
  }
  const blocks = SECTIONS.filter((section) => groups.get(section).length > 0)
    .map((section) => `### ${section}\n${groups.get(section).map((line) => `- ${line}`).join('\n')}\n`);
  return blocks.length === 0 ? '' : `## What's changed\n\n${blocks.join('\n')}`;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function previousTag(to) {
  try { return git(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${to}^`]).trim() || null; } catch { return null; }
}

function main() {
  const [fromArg = '', toArg = ''] = process.argv.slice(2);
  const to = toArg || 'HEAD';
  const from = fromArg === '' || fromArg === 'auto' ? previousTag(to) : fromArg;
  const range = from ? `${from}..${to}` : to;
  process.stderr.write(`Changelog for ${range}${from ? '' : ' (no previous tag: all commits)'}\n`);
  const subjects = git(['log', range, '--no-merges', '--format=%s']).split(/\r?\n/);
  process.stdout.write(formatChangelog(subjects));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
