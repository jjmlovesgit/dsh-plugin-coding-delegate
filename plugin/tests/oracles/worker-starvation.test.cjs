// Oracle: the BUILT delegation artefact classifies a starved worker as starved.
//
// The unit test proves the decision against `src/`; this proves the same decision survives the build
// into `dist/`, which is what DSH actually loads. The two are not the same claim: CI's dist-sync
// check catches a stale tree, but only this catches a gate that was written in `src/` and never
// reached the artefact the host runs.
//
// Properties:
//   1. `length` with empty content is starvation.
//   2. `length` with content is NOT -- the boundary that keeps the gate from becoming a false red.
//   3. ANY finish reason with empty content is now a failure, `stop` included. This case used to be a
//      KNOWN GAP in the unit suite; the gate was widened, and the widened gate is what has to survive
//      into dist, since dist is what DSH loads.
//   4. The two causes still report different remedies, because only one of them has a specific fix.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..');
const { classifyWorkerOutput } = require(PLUGIN + '/dist/delegation.js');

test('the built artefact treats length with empty content as starvation', () => {
  const verdict = classifyWorkerOutput({ finishReason: 'length', content: '' });
  assert.equal(verdict.starved, true, 'a starved worker must be reported as starved');
  assert.match(verdict.reason, /finish_reason "length"/);
});

test('whitespace-only content is empty', () => {
  assert.equal(classifyWorkerOutput({ finishReason: 'length', content: ' \n\t ' }).starved, true);
});

test('length with real content is not starvation', () => {
  // A model that emitted a complete file and then ran into the cap produced usable output.
  assert.equal(classifyWorkerOutput({ finishReason: 'length', content: 'export const x = 1' }).starved, false);
});

test('an empty reply is a failure whatever reason the server gave for stopping', () => {
  assert.equal(
    classifyWorkerOutput({ finishReason: 'stop', content: '' }).starved,
    true,
    'a normal stop with nothing in it is still nothing'
  );
  assert.equal(classifyWorkerOutput({ finishReason: 'stop', content: 'done' }).starved, false);
  // A missing reason is not a reason to accept an empty reply either.
  assert.equal(classifyWorkerOutput({ content: '' }).starved, true);
  assert.equal(classifyWorkerOutput({ finishReason: null, content: '' }).starved, true);
  assert.equal(classifyWorkerOutput({ content: 'export const x = 1' }).starved, false);
});

test('the two causes report different remedies', () => {
  const exhausted = classifyWorkerOutput({ finishReason: 'length', content: '' });
  const stopped = classifyWorkerOutput({ finishReason: 'stop', content: '' });
  assert.equal(exhausted.starved, true);
  assert.equal(stopped.starved, true);
  assert.match(exhausted.reason, /token budget/);
  assert.match(stopped.reason, /finish_reason "stop"/);
  assert.doesNotMatch(stopped.reason, /token budget/);
});
