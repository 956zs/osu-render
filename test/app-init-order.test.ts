import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

// public/app.js runs top to bottom on page load. A `let` read before its declaration throws and stops the whole
// script, which leaves every button dead. renderOptions() is called at top level for DEFAULT_OPTIONS, so all state
// it reads must be declared above that call.
test('app.js declares the state renderOptions() reads before DEFAULT_OPTIONS is computed', async () => {
  const source = await readFile(path.resolve('public/app.js'), 'utf8');
  const call = source.indexOf('const DEFAULT_OPTIONS = renderOptions()');
  assert.ok(call >= 0, 'DEFAULT_OPTIONS = renderOptions() not found');
  for (const name of ['plugins', 'pluginValues']) {
    const declaration = source.search(new RegExp(`^let ${name} =`, 'm'));
    assert.ok(declaration >= 0, `let ${name} not found`);
    assert.ok(declaration < call, `let ${name} must come before DEFAULT_OPTIONS`);
  }
});
