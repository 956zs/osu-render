import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDanserArguments } from '../src/renderer.js';
import type { RenderRow } from '../src/types.js';
import { parseRenderOptions } from '../src/render-options.js';

test('danser checks its map database before rendering', () => {
  const job = {
    id: 'job-id',
    replay_path: '/srv/replays/job-id.osr',
    options_json: JSON.stringify(parseRenderOptions('{"backgroundDim":55,"showKeyOverlay":false}')),
  } as RenderRow;
  const argumentsList = buildDanserArguments(job);
  assert.deepEqual(argumentsList.slice(0, 5), [
    '-settings=service',
    '-replay=/srv/replays/job-id.osr',
    '-out=job-id',
    '-preciseprogress',
    '-noupdatecheck',
  ]);
  const patchArgument = argumentsList.find((argument) => argument.startsWith('-sPatch='));
  assert(patchArgument);
  const patch = JSON.parse(patchArgument.slice('-sPatch='.length));
  assert.deepEqual(patch.Recording, { FrameWidth: 1920, FrameHeight: 1080 });
  assert.equal(patch.Playfield.Background.Dim.Normal, 0.55);
  assert.equal(patch.Gameplay.KeyOverlay.Show, false);
  assert(argumentsList.includes('-quickstart'));
  assert(!argumentsList.includes('-nodbcheck'));
});

test('danser keeps the full intro when requested', () => {
  const job = {
    id: 'full-intro', replay_path: '/srv/replays/full-intro.osr',
    options_json: JSON.stringify(parseRenderOptions('{"skipIntro":false}')),
  } as RenderRow;
  assert(!buildDanserArguments(job).includes('-quickstart'));
});
