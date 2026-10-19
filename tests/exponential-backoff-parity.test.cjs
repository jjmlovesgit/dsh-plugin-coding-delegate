// Parity oracle for the vendored backoff.
//
// plugin/ installs standalone, so it cannot import `tools/exponential-backoff.ts`; the attested leaf
// is COPIED to plugin/src/vendor/ instead. That copy is the risk this file exists to remove: a copied
// implementation can drift from the one whose contract and attestation cover it, and nothing else in
// the repository would notice -- `check-contracts.cjs` governs tools/*.ts and never looks in plugin/.
//
// TWO CHECKS, because they fail for different reasons:
//   1. BYTE IDENTITY. The vendor must remain a literal copy. If someone adapts it -- reformats it,
//      adds a plugin-specific tweak -- the digest changes and this fails, which is the point: an
//      adaptation is no longer the attested implementation.
//   2. BEHAVIOURAL EQUALITY over the parameter space. This one survives Node's type stripping and the
//      tsc build, and it is what proves the copy still computes the same schedule.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO_ROOT, 'tools', 'exponential-backoff.ts');
const VENDOR = path.join(REPO_ROOT, 'plugin', 'src', 'vendor', 'exponential-backoff.ts');

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SourceBackoff = require(SOURCE).ExponentialBackoff;
const VendorBackoff = require(VENDOR).ExponentialBackoff;

test('exponential backoff parity oracle', async (t) => {
  await t.test('the vendored copy is byte-identical to the attested leaf', () => {
    assert.equal(
      digest(VENDOR),
      digest(SOURCE),
      'plugin/src/vendor/exponential-backoff.ts has drifted from tools/exponential-backoff.ts; ' +
        'restore it as a copy rather than adapting it, or the attestation no longer describes it'
    );
  });

  await t.test('both compute the same schedule across the parameter space', () => {
    const configs = [
      { baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 'none' },
      { baseDelayMs: 500, maxDelayMs: 4000, factor: 2, jitter: 'none' },
      { baseDelayMs: 50, maxDelayMs: 500, factor: 3, jitter: 'none' },
      { baseDelayMs: 75, maxDelayMs: 500, factor: 1, jitter: 'none' },
      { baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 'full' },
      { baseDelayMs: 10, maxDelayMs: 60000, factor: 1.5, jitter: 'none' },
    ];

    for (const config of configs) {
      const source = new SourceBackoff(config);
      const vendor = new VendorBackoff(config);
      for (let attempt = 0; attempt <= 40; attempt += 1) {
        for (const seed of [undefined, 0, 0.333, 0.5, 1]) {
          assert.equal(
            vendor.computeDelay(attempt, seed),
            source.computeDelay(attempt, seed),
            'disagreed for ' + JSON.stringify(config) + ' attempt ' + attempt + ' seed ' + seed
          );
        }
      }
    }
  });

  await t.test('both reject the same arguments', () => {
    const badConfigs = [
      { baseDelayMs: 0, maxDelayMs: 10 },
      { baseDelayMs: 10, maxDelayMs: 5 },
      { baseDelayMs: 10, maxDelayMs: 10, factor: 0.5 },
      { baseDelayMs: 10, maxDelayMs: 10, jitter: 'partial' },
    ];
    for (const config of badConfigs) {
      assert.throws(() => new SourceBackoff(config), 'source accepted ' + JSON.stringify(config));
      assert.throws(() => new VendorBackoff(config), 'vendor accepted ' + JSON.stringify(config));
    }

    const source = new SourceBackoff({ baseDelayMs: 10, maxDelayMs: 100 });
    const vendor = new VendorBackoff({ baseDelayMs: 10, maxDelayMs: 100 });
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      assert.throws(() => source.computeDelay(bad));
      assert.throws(() => vendor.computeDelay(bad));
    }
  });
});
