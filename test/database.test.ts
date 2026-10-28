import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RenderDatabase } from '../src/database.js';
import { parseRenderOptions } from '../src/render-options.js';

test('keeps queued jobs in FIFO order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-db-'));
  const database = new RenderDatabase(path.join(directory, 'test.db'));
  try {
    database.createRender({ id: 'a', replayPath: '/a.osr', clientKey: 'one', encoder: 'libx264' });
    database.setStatus('a', 'queued');
    await new Promise((resolve) => setTimeout(resolve, 2));
    database.createRender({ id: 'b', replayPath: '/b.osr', clientKey: 'two', encoder: 'libx264' });
    database.setStatus('b', 'queued');
    assert.equal(database.nextQueued()?.id, 'a');
    assert.equal(database.queuePosition('b'), 2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists visual options with each render job', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-db-'));
  const database = new RenderDatabase(path.join(directory, 'test.db'));
  try {
    const options = parseRenderOptions('{"backgroundDim":70,"showScoreboard":false,"resolution":"720p"}');
    database.createRender({
      id: 'configured', replayPath: '/configured.osr', clientKey: 'one', encoder: 'h264_qsv', options,
    });
    assert.deepEqual(JSON.parse(database.getRender('configured')?.options_json ?? ''), options);
    assert.equal(database.getRender('configured')?.width, 1280);
    assert.equal(database.getRender('configured')?.height, 720);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not bypass an older resolving job', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-db-'));
  const database = new RenderDatabase(path.join(directory, 'test.db'));
  try {
    database.createRender({ id: 'older', replayPath: '/older.osr', clientKey: 'one', encoder: 'libx264' });
    database.setStatus('older', 'resolving');
    await new Promise((resolve) => setTimeout(resolve, 2));
    database.createRender({ id: 'newer', replayPath: '/newer.osr', clientKey: 'two', encoder: 'libx264' });
    database.setStatus('newer', 'queued');
    assert.equal(database.nextQueued(), undefined);
    database.setStatus('older', 'queued');
    assert.equal(database.nextQueued()?.id, 'older');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('lists recent renders newest first and opens read-only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-db-'));
  const file = path.join(directory, 'test.db');
  const database = new RenderDatabase(file);
  try {
    for (const id of ['one', 'two', 'three']) {
      database.createRender({ id, replayPath: `/${id}.osr`, clientKey: 'k', encoder: 'libx264' });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(database.recentRenders(2).map((row) => row.id), ['three', 'two']);
    assert.equal(database.recentRenders(10).length, 3);
    assert.deepEqual(database.recentRenders(0), []);
    assert.deepEqual(database.recentRenders(-1), []);
    const reader = new RenderDatabase(file, { readonly: true });
    try {
      assert.equal(reader.recentRenders(1)[0]?.id, 'three');
      assert.throws(() => reader.createRender({ id: 'x', replayPath: '/x.osr', clientKey: 'k', encoder: 'libx264' }));
    } finally {
      reader.close();
    }
    assert.throws(() => new RenderDatabase(path.join(directory, 'missing.db'), { readonly: true }));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed and cancelled renders expire so their files and logs get cleaned', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-db-'));
  const database = new RenderDatabase(path.join(directory, 'test.db'));
  try {
    database.createRender({ id: 'failed', replayPath: '/failed.osr', clientKey: 'one', encoder: 'libx264' });
    database.createRender({ id: 'cancelled', replayPath: '/cancelled.osr', clientKey: 'one', encoder: 'libx264' });
    database.markFailed('failed', 'RENDER_FAILED', 'boom');
    database.cancel('cancelled');
    assert.ok((database.getRender('failed')?.expires_at ?? 0) > Date.now());
    assert.ok((database.getRender('cancelled')?.expires_at ?? 0) > Date.now());
    const later = Date.now() + 48 * 60 * 60 * 1000;
    assert.deepEqual(database.expiredRenders(later).map((row) => row.id).sort(), ['cancelled', 'failed']);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
