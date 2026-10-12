// The contract for canonicalMerge. Architect-authored: hashed before the unit runs and re-hashed after
// it, so the worker may not touch it and any change to it voids the verdict.
//
// node:test rather than a hand-rolled script, because scripts/check-contract.cjs runs contracts under
// `node --test` and counts TAP assertion events. An un-instrumented script reports its own verdict on
// stdout, which that guard cannot read: it becomes one test block that reaches no assertion and is
// charged as a malfunction.
//
// The cases are the point. Every clause of the specification has at least one assertion, and the
// prototype-pollution and non-mutation clauses get one each rather than being assumed from the others.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { canonicalMerge } = require(
  path.join(__dirname, '..', '..', 'tools', 'json-canonical-merge.ts')
);

/** A structural copy that shares no references, so a mutation of the original is detectable. */
const snap = (value) => JSON.parse(JSON.stringify(value));

test('canonicalMerge', async (t) => {
  await t.test('merges disjoint top-level keys', () => {
    assert.deepEqual(canonicalMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  });

  await t.test('the patch wins on a shared scalar key', () => {
    assert.deepEqual(canonicalMerge({ a: 1 }, { a: 2 }), { a: 2 });
  });

  await t.test('merges plain objects recursively', () => {
    assert.deepEqual(canonicalMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  });

  await t.test('a null patch value deletes the key', () => {
    const out = canonicalMerge({ a: 1, b: 2 }, { b: null });
    assert.deepEqual(out, { a: 1 });
    assert.equal('b' in out, false);
  });

  await t.test('a null patch value deletes a nested key', () => {
    const out = canonicalMerge({ a: { b: 1, c: 2 } }, { a: { c: null } });
    assert.deepEqual(out, { a: { b: 1 } });
    assert.equal('c' in out.a, false);
  });

  await t.test('arrays are replaced atomically, not merged by index', () => {
    assert.deepEqual(canonicalMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
  });

  await t.test('a scalar replaces an object, and an object replaces a scalar', () => {
    assert.deepEqual(canonicalMerge({ a: { b: 1 } }, { a: 5 }), { a: 5 });
    assert.deepEqual(canonicalMerge({ a: 5 }, { a: { b: 1 } }), { a: { b: 1 } });
  });

  await t.test('skips __proto__ and pollutes nothing', () => {
    // An own `__proto__` property survives JSON.parse, and assigning it would set the prototype rather
    // than create a key -- the classic merge pollution. Both the global and the result are checked,
    // because a merge can fail this by writing the key instead of the prototype too.
    const out = canonicalMerge({ a: 1 }, JSON.parse('{"__proto__":{"polluted":true}}'));
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), false);
    assert.deepEqual(out, { a: 1 });
  });

  await t.test('skips constructor and prototype keys', () => {
    const out = canonicalMerge({ a: 1 }, JSON.parse('{"constructor":{"x":1},"prototype":{"y":2}}'));
    assert.deepEqual(out, { a: 1 });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'constructor'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'prototype'), false);
  });

  await t.test('mutates neither argument', () => {
    const base = { a: { b: 1 }, keep: [1, 2] };
    const patch = { a: { c: 2 }, drop: null, arr: [1] };
    const baseBefore = snap(base);
    const patchBefore = snap(patch);
    canonicalMerge(base, patch);
    assert.deepEqual(base, baseBefore);
    assert.deepEqual(patch, patchBefore);
  });
});
