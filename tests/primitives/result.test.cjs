// Loopback suite for the first `src/core/primitives/` module.
//
// Tier 1 primitives carry a discrimination contract under `tests/contracts/` when they live in
// `tools/`. This one lives under a reserved path that contract parity does not scan, so its evidence
// is this suite plus the AST leaf fence -- stated plainly rather than left for a reader to infer from
// an absence.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', '..', 'src', 'core', 'primitives', 'result.ts');
const { Ok, Err, isOk, isErr, unwrapOr, map } = require(SOURCE);

test('Result primitive', async (t) => {
  await t.test('is a leaf: it imports nothing', () => {
    const source = fs.readFileSync(SOURCE, 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, 'a Tier 1 primitive may not import anything');
    assert.doesNotMatch(source, /\brequire\s*\(/, 'a Tier 1 primitive may not require anything');
  });

  await t.test('Ok carries a value and reports success', () => {
    const result = Ok(42);
    assert.deepEqual(result, { ok: true, value: 42 });
    assert.equal(isOk(result), true);
    assert.equal(isErr(result), false);
  });

  await t.test('Err carries a reason and reports failure', () => {
    const result = Err('boom');
    assert.deepEqual(result, { ok: false, error: 'boom' });
    assert.equal(isOk(result), false);
    assert.equal(isErr(result), true);
  });

  await t.test('a falsy value is still a success', () => {
    for (const value of [0, '', false, null, undefined]) {
      const result = Ok(value);
      assert.equal(isOk(result), true, 'Ok(' + String(value) + ') must not be mistaken for a failure');
      assert.equal(result.value, value);
    }
  });

  await t.test('unwrapOr returns the value or the fallback, never the error', () => {
    assert.equal(unwrapOr(Ok(7), 0), 7);
    assert.equal(unwrapOr(Err('nope'), 0), 0);
    assert.equal(unwrapOr(Err('nope'), 'fallback'), 'fallback');
  });

  await t.test('map transforms a success and passes a failure through untouched', () => {
    assert.deepEqual(map(Ok(2), (n) => n * 3), { ok: true, value: 6 });

    const failure = Err({ code: 'E_SHAPE' });
    const mapped = map(failure, () => 'never');
    assert.equal(mapped, failure, 'a failure must not be rebuilt: identity is part of the contract');
    assert.equal(mapped.ok, false);
  });
});
