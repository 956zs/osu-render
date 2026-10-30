import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from '../src/app-config.js';

interface ChangelogModule {
  parseSubject(subject: string): { section: 'New' | 'Fixes' | 'Speed'; text: string } | null;
  formatChangelog(subjects: readonly string[]): string;
}

const load = async (): Promise<ChangelogModule> =>
  await import(pathToFileURL(path.join(APP_ROOT, 'scripts', 'release-changelog.mjs')).href) as ChangelogModule;

test('parseSubject maps feat, fix and perf and moves the scope to the end', async () => {
  const { parseSubject } = await load();
  assert.deepEqual(parseSubject('feat(ui): add x'), { section: 'New', text: 'Add x (ui)' });
  assert.deepEqual(parseSubject('feat: add x'), { section: 'New', text: 'Add x' });
  assert.deepEqual(parseSubject('fix(renderer): kill stalled renders'), { section: 'Fixes', text: 'Kill stalled renders (renderer)' });
  assert.deepEqual(parseSubject('perf: faster AMF preset'), { section: 'Speed', text: 'Faster AMF preset' });
});

test('parseSubject accepts breaking markers, any case and surrounding whitespace', async () => {
  const { parseSubject } = await load();
  assert.deepEqual(parseSubject('feat(api)!: drop v1'), { section: 'New', text: 'Drop v1 (api)' });
  assert.deepEqual(parseSubject('fix!: breaking fix'), { section: 'Fixes', text: 'Breaking fix' });
  assert.deepEqual(parseSubject('FEAT(UI): Add Y'), { section: 'New', text: 'Add Y (UI)' });
  assert.deepEqual(parseSubject('  Perf:   quicker  '), { section: 'Speed', text: 'Quicker' });
});

test('parseSubject drops other types, non-conventional and empty subjects', async () => {
  const { parseSubject } = await load();
  for (const subject of ['docs: readme', 'chore(deps): bump', 'test: more', 'refactor: x', 'ci: y', 'build: z', 'style: w',
    'revert: feat: x', 'Merge pull request #6 from 956zs/speed-profiles', 'add something', 'feat:', 'feat:   ', 'feat(ui) add x', '', '   ']) {
    assert.equal(parseSubject(subject), null, subject);
  }
});

test('formatChangelog groups sections in order, dedupes and keeps commit order', async () => {
  const { formatChangelog } = await load();
  const text = formatChangelog([
    'perf: faster encode', 'fix(ui): button', 'docs: readme', 'feat(ui): add x', 'feat: add y', 'feat(ui): add x', 'chore: bump', '',
  ]);
  assert.equal(text, "## What's changed\n\n### New\n- Add x (ui)\n- Add y\n\n### Fixes\n- Button (ui)\n\n### Speed\n- Faster encode\n");
});

test('formatChangelog omits empty sections and returns "" when nothing qualifies', async () => {
  const { formatChangelog } = await load();
  assert.equal(formatChangelog(['fix: one']), "## What's changed\n\n### Fixes\n- One\n");
  assert.equal(formatChangelog([]), '');
  assert.equal(formatChangelog(['docs: a', 'chore: b', 'random commit', '  ']), '');
});
