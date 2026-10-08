// Contract oracle: a delegated file is recognised however the reader spells its path -- and the guard
// is never told where the workspace is, so these tests never tell it either.
//
// The gate fired only for ABSOLUTE paths, because `canonicalisePath` resolves a relative path against
// the process cwd while the delegated registry holds canonical absolute paths. Reproduced live against
// a file a delegated worker had just created: reading it back passed with no decision at all. The
// architect names files relatively essentially always, so the gate was off in normal use.
//
// Two routes reach the gate and both were broken the same way: the `read` tool, which passes a path,
// and a shell command, which contains one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-drp-data-'));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, '..', '..');
const DIST = PLUGIN + '/dist/index.js';

// A workspace holding one file, which a delegated worker is recorded as having written. Note what the
// guard is given: the file, and no workspace around it.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-drp-ws-'));
const DELEGATED = path.join(WS, 'plugin', 'src', 'thing.ts');
fs.mkdirSync(path.dirname(DELEGATED), { recursive: true });
fs.writeFileSync(DELEGATED, 'export const x = 1\n');

function config(extra) {
  return { delegatedPaths: [DELEGATED], delegateReadPolicy: 'ask', ...(extra || {}) };
}

test('a read naming a delegated file RELATIVELY is gated', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(
    { name: 'read', arguments: { file_path: 'plugin/src/thing.ts' } },
    config()
  );
  assert.ok(verdict, 'the guard must reach a decision about this read');
  assert.equal(verdict.kind, 'ask', 'reading a delegated file needs a decision');
  assert.match(String(verdict.reason), /delegated/i, 'and the reason must say why');
});

test('the absolute path and the backslash-relative form are gated too', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const absolute = evaluateCodeWriteGuard(
    { name: 'read', arguments: { file_path: DELEGATED } },
    config()
  );
  assert.equal(absolute && absolute.kind, 'ask', 'the absolute form was the only one that ever worked');

  const backslash = evaluateCodeWriteGuard(
    { name: 'read', arguments: { file_path: 'plugin\\src\\thing.ts' } },
    config()
  );
  assert.equal(backslash && backslash.kind, 'ask', 'Windows accepts either separator');
});

test('a relative path that climbs with .. and lands on the file is gated', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(
    { name: 'read', arguments: { file_path: 'plugin/tests/../src/thing.ts' } },
    config()
  );
  assert.equal(verdict && verdict.kind, 'ask', '.. must be resolved, not string-matched');
});

test('a shell command reading a delegated file RELATIVELY is gated', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(
    { name: 'pwsh', arguments: { command: 'Get-Content plugin/src/thing.ts' } },
    config()
  );
  assert.ok(verdict, 'the shell route reaches the same gate by another path');
  assert.equal(verdict.kind, 'ask', 'a shell read of delegated source is the same read');
});

test('a file nobody delegated is not reported as delegated', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  for (const target of ['plugin/src/other.ts', 'src/other/thing.ts']) {
    const verdict = evaluateCodeWriteGuard(
      { name: 'read', arguments: { file_path: target } },
      config()
    );
    if (verdict) {
      assert.ok(
        !/delegated/i.test(String(verdict.reason)),
        target + ' must not be reported as a delegated read: ' + verdict.reason
      );
    }
  }
});
