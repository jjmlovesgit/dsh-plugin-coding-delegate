// Discrimination contract for the Result primitive.
//
// This is the first contract whose module lives outside `tools/`. The convention is unchanged -- the
// contract sits in tests/contracts and reaches its module by relative path -- but the path names the
// reserved Tier 1 directory, which is what makes `src/core/primitives/` subject to the same gates as
// `tools/` rather than to a unit test alone.
//
// THE CONTRACT ASSERTS BEHAVIOUR AND THE LEAST STRUCTURE THAT MAKES THE BEHAVIOUR TRUE: that the
// module imports nothing. Everything else about the implementation is free to change, which is what
// distinguishes a contract from a snapshot.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', '..', 'src', 'core', 'primitives', 'result.ts');
const { Ok, Err, isOk, isErr, unwrapOr, map } = require(SOURCE);

test('result: a discriminated value-or-reason', async (t) => {
  await t.test('is a leaf: the module imports nothing', () => {
    const source = fs.readFileSync(SOURCE, 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, 'a Tier 1 primitive may not import anything');
    assert.doesNotMatch(source, /\brequire\s*\(/, 'a Tier 1 primitive may not require anything');
  });

  await t.test('Ok carries the value and reports ok', () => {
    const result = Ok('value');
    assert.deepEqual(result, { ok: true, value: 'value' });
    assert.equal(isOk(result), true);
    assert.equal(isErr(result), false);
  });

  await t.test('Err carries the reason and reports not-ok', () => {
    const result = Err('reason');
    assert.deepEqual(result, { ok: false, error: 'reason' });
    assert.equal(isOk(result), false);
    assert.equal(isErr(result), true);
  });

  await t.test('a falsy payload is still a success', () => {
    for (const value of [0, '', false, null, undefined]) {
      const result = Ok(value);
      assert.equal(isOk(result), true, 'Ok(' + String(value) + ') must not read as a failure');
      assert.equal(result.value, value);
    }
  });

  await t.test('a falsy reason is still a failure', () => {
    for (const reason of [0, '', false, null, undefined]) {
      const result = Err(reason);
      assert.equal(isErr(result), true, 'Err(' + String(reason) + ') must not read as a success');
      assert.equal(result.error, reason);
    }
  });

  await t.test('unwrapOr resolves the value, or the fallback when there is none', () => {
    assert.equal(unwrapOr(Ok(7), 0), 7);
    assert.equal(unwrapOr(Err('nope'), 0), 0);
    assert.equal(unwrapOr(Err('nope'), 'fallback'), 'fallback');
  });

  await t.test('map projects a success and passes a failure through untouched', () => {
    assert.deepEqual(map(Ok(2), (n) => n * 3), { ok: true, value: 6 });

    const failure = Err({ code: 'E_SHAPE' });
    const mapped = map(failure, () => 'never called');
    assert.equal(mapped, failure, 'a failure must not be rebuilt or transformed');
  });

  await t.test('the discriminants are exclusive', () => {
    for (const result of [Ok(1), Err(1), Ok(undefined), Err(undefined)]) {
      // Sorted, because Object.keys follows insertion order and both branches start with `ok`.
      const keys = Object.keys(result).sort().join(',');
      assert.ok(keys === 'ok,value' || keys === 'error,ok', 'unexpected shape: ' + keys);
    }
  });
});
