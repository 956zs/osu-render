import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HttpBeatmapMirror, MIRROR_USER_AGENT } from '../src/mirrors.js';

test('mirror download identifies the service and saves the osz atomically', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'osu-render-mirror-'));
  const destination = path.join(directory, 'map.osz');
  const server = createServer((request, response) => {
    if (request.headers['user-agent'] !== MIRROR_USER_AGENT) {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(Buffer.from('PK\x03\x04test archive'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const mirror = new HttpBeatmapMirror(`http://127.0.0.1:${address.port}/d/{id}`);
    await mirror.downloadBeatmapset(123, destination, 1024);
    assert.equal((await readFile(destination)).subarray(0, 4).toString('hex'), '504b0304');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
