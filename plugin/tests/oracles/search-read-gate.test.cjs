// Contract oracle: rule 3 gates READING a delegated file, and search reads files too.
//
// The gap this exists for was found live: an agent was refused by the read guard on four source files
// ("not settled: the unit that wrote it failed verification") and then read the same content straight out
// of them with the search tool. Rule 3 held for the tool that had been thought of and not for the one
// beside it.
//
// The plugin already knows search reads files. `READ_ONLY_INSPECTORS` in guard.ts lists `grep`, `rg`,
// `findstr`, `select-string`, `get-content` and more -- but that list serves the WRITE guard, where it
// stops `Select-String -Path some.js` being mistaken for invoking `some.js`. The READ gate keys on
// READ_TOOLS, which contains read/view/cat and no search tool at all. Two guards, two vocabularies, and
// the knowledge in one never reaches the other. This oracle is the contract for wiring them together.
//
// Two things make it more than a name list:
//
//   * A read names a PATH; a search names a PATTERN and a SCOPE. `matchDelegatedPaths` matches file
//     identity -- canonical equality, or a relative target resolved against the delegated file's
//     ancestors -- so a directory scope matches nothing today and every workspace-wide search passes.
//     The gate has to ask "which delegated files could this return", which is containment, not equality.
//   * There are two doors. The `grep` tool is one; `Select-String -Path x` in a shell command is the
//     other, and it reaches the same content. Closing one and not the other is how the last three gaps
//     in this plugin survived, so both are asserted here.
//
// The policy that decides DOES NOT CHANGE. Whatever the scope resolves to, it is the settled rule that
// answers: silent when every delegated file in scope is settled, a question when one is failed,
// unverified, edited since its verdict, or has no verdict at all. This oracle asserts the wiring, not a
// new policy -- and the ceiling still holds, so `allow` short-circuits and `deny` still refuses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// An explicit data directory, so nothing here touches the operator's real registry.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-search-gate-data-'));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, '..', '..');
const DIST = PLUGIN + '/dist/index.js';
const CONTRACTS = PLUGIN + '/dist/contracts.js';

const { sha256File } = require(CONTRACTS);

const PASSED = { outcome: 'UNIT_PASSED', succeeded: true, verdictAt: 2 };
const FAILED = { outcome: 'UNIT_FAILED', succeeded: false, verdictAt: 2 };
const UNVERIFIED = { outcome: 'UNIT_UNVERIFIED', succeeded: false, verdictAt: 2 };

/**
 * A workspace holding one delegated file at `plugin/src/thing.ts`, plus the record a delegation would have
 * left for it. Every case builds its own workspace, because the guard is never told which one is meant and
 * has to infer it -- which is also why the scope below is a relative string.
 */
function caseFile(body, verdict) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-search-'));
  const file = path.join(dir, 'plugin', 'src', 'thing.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const record = {
    path: file,
    sha256: sha256File(file),
    at: 1,
    mode: 'created',
    ...(verdict || PASSED),
  };
  return { dir, file, record, scope: 'plugin/src', target: 'plugin/src/thing.ts' };
}

function configFor(cases, extra) {
  const records = new Map(cases.map((c) => [c.file, c.record]));
  return {
    delegatedPaths: cases.map((c) => c.file),
    delegateReadPolicy: 'ask',
    delegatedRecordFor: (p) => records.get(p),
    ...(extra || {}),
  };
}

const searchTool = (scope, name) => ({ name: name || 'grep', arguments: { pattern: 'export', path: scope } });
const shell = (command) => ({ name: 'pwsh', arguments: { command } });

test('a search scoped over an unsettled delegated file is gated', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const failed = caseFile('export const x = 1\n', FAILED);
  const verdict = evaluateCodeWriteGuard(searchTool(failed.scope), configFor([failed]));

  assert.ok(verdict, 'a search that can return a failed unit output must not pass silently');
  assert.equal(verdict.kind, 'ask', 'asked about, not refused');
  assert.match(String(verdict.reason), /fail/i, 'and the reason names the verdict: ' + verdict.reason);
});

test('a search scoped over settled delegated files is not gated', () => {
  // The control that keeps this from becoming "no search ever". Same rule as a read: finished work that
  // nothing has touched is exactly what the architect is here to work with.
  const { evaluateCodeWriteGuard } = require(DIST);
  const settled = caseFile('export const x = 1\n');
  const verdict = evaluateCodeWriteGuard(searchTool(settled.scope), configFor([settled]));

  assert.equal(verdict, null, 'a settled scope must not prompt at all');
});

test('a search that names a delegated file directly is gated, exactly as a read is', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const failed = caseFile('export const x = 1\n', FAILED);
  const verdict = evaluateCodeWriteGuard(searchTool(failed.target), configFor([failed]));

  assert.ok(verdict, 'naming the file is the narrowest possible scope and must be caught by identity too');
  assert.equal(verdict.kind, 'ask');
});

test('a workspace-wide search is gated when any delegated file in the workspace is unsettled', () => {
  // No path argument at all: the scope is the workspace. That is the shape that leaked live.
  const { evaluateCodeWriteGuard } = require(DIST);
  const failed = caseFile('export const x = 1\n', FAILED);
  const verdict = evaluateCodeWriteGuard({ name: 'grep', arguments: { pattern: 'export' } }, configFor([failed]));

  assert.ok(verdict, 'a search with no declared scope defaults to everything under the workspace');
  assert.equal(verdict.kind, 'ask');
});

test('an unverified unit gates a search over its scope, and an edited one does too', () => {
  const { evaluateCodeWriteGuard } = require(DIST);

  const unverified = caseFile('export const x = 1\n', UNVERIFIED);
  assert.ok(
    evaluateCodeWriteGuard(searchTool(unverified.scope), configFor([unverified])),
    'nothing verified this file'
  );

  const edited = caseFile('export const x = 1\n');
  fs.appendFileSync(edited.file, 'export const y = 2\n');
  const verdict = evaluateCodeWriteGuard(searchTool(edited.scope), configFor([edited]));
  assert.ok(verdict, 'the verdict describes content that is gone');
  assert.match(String(verdict.reason), /changed/i, 'with the reason stated: ' + verdict.reason);
});

test('the shell door is gated the same way as the tool door', () => {
  // `Select-String -Path <file>` reaches the same bytes as `read`. A fix on the tool path alone would be a
  // half-close, which is the failure mode this plugin has now hit four times.
  const { evaluateCodeWriteGuard } = require(DIST);
  const failed = caseFile('export const x = 1\n', FAILED);

  const byPath = evaluateCodeWriteGuard(
    shell(`Select-String -Path ${failed.target} -Pattern export`),
    configFor([failed])
  );
  assert.ok(byPath, 'a shell command that reads a delegated file must be gated');
  assert.equal(byPath.kind, 'ask', 'asked about, not refused');

  const byScope = evaluateCodeWriteGuard(shell('rg export plugin/src'), configFor([failed]));
  assert.ok(byScope, 'and so must a recursive search over its directory');
});

test('a search that cannot reach a delegated file is never gated', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const elsewhere = caseFile('export const x = 1\n', FAILED);
  const verdict = evaluateCodeWriteGuard(searchTool('docs'), configFor([elsewhere]));
  assert.equal(verdict, null, 'not in scope means not gated');
});

test('the policy setting stays the ceiling, for search as for read', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const failed = caseFile('export const x = 1\n', FAILED);

  assert.equal(
    evaluateCodeWriteGuard(searchTool(failed.scope), configFor([failed], { delegateReadPolicy: 'allow' })),
    null,
    'allow is the hatch and still short-circuits the whole rule'
  );
  const denied = evaluateCodeWriteGuard(
    searchTool(failed.scope),
    configFor([failed], { delegateReadPolicy: 'deny' })
  );
  assert.equal(denied && denied.kind, 'deny', 'deny refuses the search outright');
});

test('every search tool the plugin already recognises as a reader is covered', () => {
  // The wiring, asserted rather than assumed: the vocabulary in READ_ONLY_INSPECTORS is the vocabulary
  // this gate must have. A tool that reads files in one guard and is invisible in the other is the defect.
  const { evaluateCodeWriteGuard } = require(DIST);
  const failed = caseFile('export const x = 1\n', FAILED);
  const config = configFor([failed]);

  for (const name of ['grep', 'rg', 'search', 'find_in_files', 'select-string']) {
    const verdict = evaluateCodeWriteGuard(searchTool(failed.scope, name), config);
    assert.ok(verdict, name + ' returns file content and must be gated like a read');
  }
});
