// The contract for formatCurrency. Architect-authored: hashed before the unit runs and re-hashed after
// it, so the worker may not touch it and any change to it voids the verdict.
//
// Native node:test rather than a hand-rolled script. The hand-rolled form reported its own verdict on
// stdout, which scripts/check-contract.cjs cannot read: that guard runs the file under `node --test` and
// counts TAP assertion events, so an un-instrumented script is a single test block that reaches no
// assertion and is charged as a malfunction. Instrumenting it is what lets the guard judge it at all.
//
// The cases are the point. An earlier run signed a passing verification over an implementation that
// returned "$-1.-5" for -5, because the command only ever asked about two positive values. A contract is
// only as wide as its cases.
const test = require('node:test');
const assert = require('node:assert/strict');

const { formatCurrency } = require('./currency.ts');

test('formatCurrency', async (t) => {
  await t.test('zero', () => assert.equal(formatCurrency(0), '$0.00'));
  await t.test('single-digit cents are zero-padded', () => assert.equal(formatCurrency(5), '$0.05'));
  await t.test('two-digit cents', () => assert.equal(formatCurrency(50), '$0.50'));
  await t.test('whole dollar', () => assert.equal(formatCurrency(100), '$1.00'));
  await t.test('dollars and cents', () => assert.equal(formatCurrency(1050), '$10.50'));
  await t.test('large value is not digit-grouped', () => assert.equal(formatCurrency(999999), '$9999.99'));
  await t.test('negative cents put the sign first', () => assert.equal(formatCurrency(-5), '-$0.05'));
  await t.test('negative tens', () => assert.equal(formatCurrency(-50), '-$0.50'));
  await t.test('negative dollars and cents', () => assert.equal(formatCurrency(-1050), '-$10.50'));
});
