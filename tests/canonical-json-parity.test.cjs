// Parity oracle for the two copies of the RFC 8785 canonicaliser.
//
// WHY THIS IS BEHAVIOURAL, NOT TEXTUAL. The verifier shipped inside the bundle must canonicalise with
// the SAME algorithm that `scripts/attest-unit.cjs` signed with, or every reviewer signature fails.
// There are two implementations: `plugin/src/canonical-json.ts` (the authority) and a copy embedded
// as source text in `scripts/export-attested-tools.cjs` (because the bundle carries no dependencies).
// A text comparison cannot work -- one is TypeScript with type annotations and the other is plain
// JavaScript inside a template literal -- and even a normalised text comparison would not prove the
// property that matters. What matters is that both functions produce the same BYTES for the same
// value, so this compares outputs over a corpus chosen to hit every branch the algorithm has.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXPORTER = path.join(REPO_ROOT, 'scripts', 'export-attested-tools.cjs');
const REFERENCE = path.join(REPO_ROOT, 'plugin', 'src', 'canonical-json.ts');

/** Pull the embedded canonicaliser and its helpers out of the exporter's verifier template. */
function embeddedCanonicalize() {
  const source = fs.readFileSync(EXPORTER, 'utf8');
  const start = source.indexOf('function canonicalizeJson(');
  const end = source.indexOf('function verifyReviewer(');
  assert.notEqual(start, -1, 'the exporter must carry an embedded canonicalizeJson');
  assert.ok(end > start, 'the embedded canonicaliser block must end before verifyReviewer');
  const body = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(body + '\nreturn canonicalizeJson;')();
}

const reference = require(REFERENCE).canonicalizeJson;
const embedded = embeddedCanonicalize();
const { gnuTarBannerProblem } = require(EXPORTER);

test('canonical JSON parity oracle', async (t) => {
  await t.test('both implementations agree across the full branch surface', () => {
    const values = [
      null,
      true,
      false,
      0,
      -0,
      1,
      -1,
      1.5,
      -1.5,
      1e21,
      1e-7,
      Number.MAX_SAFE_INTEGER,
      '',
      'plain',
      'quote " and backslash \\ and tab \t',
      'unicode: é 日本語 😀',
      'control: \u0000\u0001\u001f',
      [],
      [1, 2, 3],
      [[1], [2, [3]]],
      {},
      { b: 1, a: 2 },
      { z: { y: [1, { x: 2 }] }, a: 'first' },
      { nested: { deep: { deeper: { value: 'x' } } } },
      { omitted: undefined, kept: 1 },
      { list: [{ id: 2, name: 'b' }, { id: 1, name: 'a' }] },
    ];

    for (const value of values) {
      assert.equal(
        embedded(value),
        reference(value),
        'the embedded canonicaliser disagreed for ' + JSON.stringify(value)
      );
    }
  });

  await t.test('both implementations refuse what RFC 8785 requires them to refuse', () => {
    const refuses = [NaN, Infinity, -Infinity, [undefined], [() => 1], '\ud800', 'a\udc00b'];
    for (const value of refuses) {
      assert.throws(() => reference(value), 'the reference accepted ' + String(value));
      assert.throws(() => embedded(value), 'the embedded copy accepted ' + String(value));
    }
  });

  await t.test('the embedded copy carries every helper the algorithm needs', () => {
    const source = fs.readFileSync(EXPORTER, 'utf8');
    for (const helper of ['writeValue', 'writeNumber', 'compareCodeUnits', 'writeObject', 'writeArray', 'quoteString', 'assertNoLoneSurrogate']) {
      assert.ok(source.includes('function ' + helper + '('), 'the embedded copy is missing ' + helper);
    }
  });

  await t.test('the GNU tar guard refuses a non-GNU banner', () => {
    assert.equal(gnuTarBannerProblem('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation'), null);
    assert.match(gnuTarBannerProblem('bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.11'), /GNU tar/);
    assert.match(gnuTarBannerProblem(''), /no version banner/);
    assert.equal(gnuTarBannerProblem('tar (GNU tar) 1.35'), null);
  });
});
