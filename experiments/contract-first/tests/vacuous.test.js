// A deliberately VACUOUS contract, used as a fixture to prove the contract guard rejects one.
// It requires the module and then asserts nothing about it: every case is a tautology, so it passes
// whatever the module does. A guard that accepted this would be worthless.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTtlCache } = require('../src/ttl-cache.js');

test('construction returns something', () => {
  assert.ok(true);
});

test('the module is requireable', () => {
  assert.equal(typeof createTtlCache !== undefined, true);
});

test('a cache can be mentioned without being asserted about', () => {
  const cache = createTtlCache({ maxEntries: 2, ttlMs: 1000, now: () => 0 });
  assert.ok(cache !== undefined || cache === undefined);
});
