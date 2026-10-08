// Contract oracle: a delegated file that is SETTLED is read freely; one that is in flight is a question.
//
// Gating every read of a delegated file is the wrong rule, and the trace says so -- the architect reads
// source in order to engineer, and most of what it reads is finished work. The rule that names the reason
// rather than the category is settled versus in-flight:
//
//   a unit that PASSED wrote it, and its content is unchanged since that verdict -> allow, silently
//   a unit that FAILED wrote it                                                 -> ask
//   no verification was ever run for it                                         -> ask
//   its content changed after the verdict was reached                            -> ask
//   the registry carries no verdict for it at all                                -> ask
//
// `succeeded` alone is not the test. A verdict describes CONTENT, so a passed file that has since been
// edited is not the version anything verified and must not pass silently. That is what the hash is for.
//
// Two properties beyond the table:
//   * the policy setting stays the ceiling -- `allow` still short-circuits everything (the documented
//     rule-3 hatch) and `deny` still refuses even a settled file;
//   * when one relative target could name several delegated files, the answer is the WORST of them. The
//     guard infers the workspace rather than being told it, so a relative target is genuinely ambiguous
//     across workspaces, and taking the first match could wave through a failed file.
//
// What fails before the implementation: the settled file is not read silently (it is asked about, like
// everything else), and the pure rule does not exist. The remaining tests are controls pinning the
// behaviour that must NOT change -- unsettled files keep asking, and the setting stays the ceiling.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// An explicit data directory, so nothing here touches the operator's real registry.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settled-data-'));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, '..', '..');
const DIST = PLUGIN + '/dist/index.js';
const GUARD = PLUGIN + '/dist/guard.js';
const CONTRACTS = PLUGIN + '/dist/contracts.js';

const { sha256File } = require(CONTRACTS);

const PASSED = { outcome: 'UNIT_PASSED', succeeded: true, verdictAt: 2 };

/**
 * A real file in its own workspace, named `plugin/src/thing.ts`, plus the record a delegation would have
 * left for it. The relative target is the same string in every case, which is the point: the guard is
 * never told which workspace is meant, so it has to infer it.
 */
function caseFile(body, overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settled-'));
  const file = path.join(dir, 'plugin', 'src', 'thing.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const record = {
    path: file,
    sha256: sha256File(file),
    at: 1,
    mode: 'created',
    ...PASSED,
    ...(overrides || {}),
  };
  return { file, record, target: 'plugin/src/thing.ts' };
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

const read = (target) => ({ name: 'read', arguments: { file_path: target } });

test('the pure rule: settled only when the unit passed and the content is unchanged', () => {
  const { evaluateSettledFile } = require(GUARD);

  const untouched = caseFile('export const x = 1\n');
  const hash = sha256File(untouched.file);

  const settled = evaluateSettledFile(untouched.record, hash);
  assert.equal(settled.allowed, true, 'a passed unit with unchanged content is settled');
  assert.match(String(settled.reason), /unchanged/i, 'and says so: ' + settled.reason);

  const edited = caseFile('export const x = 1\n');
  fs.appendFileSync(edited.file, 'export const y = 2\n');
  const changed = evaluateSettledFile(edited.record, sha256File(edited.file));
  assert.equal(changed.allowed, false, 'a passed unit whose content changed is NOT settled');
  assert.match(String(changed.reason), /changed/i, 'and the reason names the content: ' + changed.reason);

  const failed = { ...untouched.record, outcome: 'UNIT_FAILED', succeeded: false };
  assert.equal(evaluateSettledFile(failed, hash).allowed, false, 'a failed unit is not settled');

  const unverified = { ...untouched.record, outcome: 'UNIT_UNVERIFIED', succeeded: false };
  assert.equal(evaluateSettledFile(unverified, hash).allowed, false, 'nor is an unverified one');

  const noVerdict = { ...untouched.record, outcome: undefined, succeeded: undefined };
  assert.equal(evaluateSettledFile(noVerdict, hash).allowed, false, 'a record with no verdict is not a pass');

  assert.equal(evaluateSettledFile(undefined, hash).allowed, false, 'and neither is no record at all');
  assert.equal(
    evaluateSettledFile(untouched.record, null).allowed,
    false,
    'a file that cannot be hashed fails closed, not open'
  );
});

test('a settled delegated file is read without a question', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const settled = caseFile('export const x = 1\n');
  const verdict = evaluateCodeWriteGuard(read(settled.target), configFor([settled]));
  assert.equal(verdict, null, 'a settled file must not prompt at all');
});

test('a failed unit leaves a question, not a wall', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const failed = caseFile('export const x = 1\n', { outcome: 'UNIT_FAILED', succeeded: false });
  const verdict = evaluateCodeWriteGuard(read(failed.target), configFor([failed]));
  assert.ok(verdict, 'an unsettled file is still gated');
  assert.equal(verdict.kind, 'ask', 'asked about, not refused');
  assert.match(String(verdict.reason), /fail/i, 'and the reason names the verdict: ' + verdict.reason);
});

test('an unverified unit asks, and so does a record with no verdict', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const unverified = caseFile('export const x = 1\n', { outcome: 'UNIT_UNVERIFIED', succeeded: false });
  const asked = evaluateCodeWriteGuard(read(unverified.target), configFor([unverified]));
  assert.equal(asked && asked.kind, 'ask', 'nothing verified this file');

  const legacy = caseFile('export const x = 1\n', { outcome: undefined, succeeded: undefined });
  const legacyVerdict = evaluateCodeWriteGuard(read(legacy.target), configFor([legacy]));
  assert.equal(legacyVerdict && legacyVerdict.kind, 'ask', 'a record written before verdicts existed has none');
});

test('a passed file edited after its verdict is asked about, not waved through', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const edited = caseFile('export const x = 1\n');
  fs.appendFileSync(edited.file, 'export const y = 2\n');
  const verdict = evaluateCodeWriteGuard(read(edited.target), configFor([edited]));
  assert.ok(verdict, 'the verdict describes content that is gone');
  assert.equal(verdict.kind, 'ask', 'so it is a question');
  assert.match(String(verdict.reason), /changed/i, 'with the reason stated: ' + verdict.reason);
});

test('when a relative target could name several delegated files, the worst one decides', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const settled = caseFile('export const x = 1\n');
  const failed = caseFile('export const x = 1\n', { outcome: 'UNIT_FAILED', succeeded: false });
  const verdict = evaluateCodeWriteGuard(read(settled.target), configFor([settled, failed]));
  assert.ok(verdict, 'one of the two is unsettled and the guard cannot tell which file was meant');
  assert.equal(verdict.kind, 'ask', 'so it asks rather than taking the permissive match');
});

test('the policy setting stays the ceiling in both directions', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const settled = caseFile('export const x = 1\n');
  const failed = caseFile('export const x = 1\n', { outcome: 'UNIT_FAILED', succeeded: false });

  assert.equal(
    evaluateCodeWriteGuard(read(failed.target), configFor([failed], { delegateReadPolicy: 'allow' })),
    null,
    'allow is the hatch and still short-circuits the settled rule'
  );
  const denied = evaluateCodeWriteGuard(read(settled.target), configFor([settled], { delegateReadPolicy: 'deny' }));
  assert.equal(denied && denied.kind, 'deny', 'deny refuses even a settled file');
  assert.equal(
    evaluateCodeWriteGuard(read(settled.target), configFor([settled], { delegateReadPolicy: undefined })),
    null,
    'and the default ask no longer prompts for settled work'
  );
});

test('a file nobody delegated is never gated, settled logic or not', () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const elsewhere = caseFile('export const x = 1\n');
  const verdict = evaluateCodeWriteGuard(read('plugin/src/other.ts'), configFor([elsewhere]));
  assert.equal(verdict, null, 'not delegated means not gated');
});
