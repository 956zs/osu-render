import assert from 'node:assert/strict';
import test from 'node:test';
import { PreflightState, type PreflightResult } from '../src/preflight.js';

test('preflight state refreshes a failed startup check when the session becomes ready', async () => {
  const initial: PreflightResult = {
    renderer: true, display: false, encoder: 'libx264', reason: 'display_unavailable',
  };
  const ready: PreflightResult = { renderer: true, display: true, encoder: 'h264_qsv' };
  let calls = 0;
  let changedTo: PreflightResult | undefined;
  const state = new PreflightState({
    run: async () => { calls += 1; return ready; },
  }, initial, { onChange: async (result) => { changedTo = result; } });

  assert.deepEqual(await state.refreshIfNeeded(), ready);
  assert.equal(calls, 1);
  assert.equal(changedTo, ready);
  assert.deepEqual(await state.refreshIfNeeded(), ready);
  assert.equal(calls, 1);
});
