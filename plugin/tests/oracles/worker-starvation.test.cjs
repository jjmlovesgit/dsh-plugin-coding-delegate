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
//   3. `stop` is never starvation, so the gate does not subsume the ordinary empty case.
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

test('stop is never starvation', () => {
  assert.equal(classifyWorkerOutput({ finishReason: 'stop', content: '' }).starved, false);
  assert.equal(classifyWorkerOutput({ finishReason: 'stop', content: 'done' }).starved, false);
});

test('a missing finish_reason is not starvation', () => {
  assert.equal(classifyWorkerOutput({ content: '' }).starved, false);
  assert.equal(classifyWorkerOutput({ finishReason: null, content: '' }).starved, false);
});
