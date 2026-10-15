// Oracle: the verification receipt must not name the host.
//
// WHY THIS FILE EXISTS. A `node:test` failure reports its location as an ABSOLUTE path, and the runner
// invoked with an absolute path -- which is how scripts/check-contract-fixtures.cjs runs every contract --
// reports it that way on any platform. MEASURED before this boundary was closed, by driving
// parseTestOutput over a real failing run:
//
//   - [assertion] 1. negative cents put the sign first @ C:\\Users\\<name>\\AppData\\...\\x.test.cjs:4:11
//   raw output: C:\Users\<name>\.dsh\local-router\last-verification.log
//
// The drive letter, the account name and the directory layout crossed to the cloud model on EVERY failure
// line. The file and the position are the diagnosis; whose machine it ran on is not.
//
// The control matters as much as the assertion: a rule that stripped locations entirely would pass the
// leak check while removing the one field a retry prompt needs to act on, so the file name and the
// line:column are asserted to SURVIVE.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..', '..');
const { parseTestOutput } = require(PLUGIN + '/dist/verification.js');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receipt-paths-'));
const USER = os.userInfo().username;

/** A failing node:test run, invoked with an ABSOLUTE path exactly as the fixtures gate invokes contracts. */
function failingRun(dir) {
  const file = path.join(dir, 'failing.test.cjs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    [
      "const test = require('node:test')",
      "const assert = require('node:assert/strict')",
      "test('formatCurrency', async (t) => {",
      "  await t.test('negative cents put the sign first', () => assert.equal('$-0.05', '-$0.05'))",
      "  await t.test('a passing one', () => assert.equal(1, 1))",
      '})',
      '',
    ].join('\n')
  );
  const env = Object.assign({}, process.env);
  // This oracle runs INSIDE `node --test` and spawns `node --test`. Node hands test-context variables to
  // its children, and an inner runner that inherits them does not emit the TAP `not ok - <name>` lines
  // this module parses -- so the redactor found nothing, and the leak assertions passed VACUOUSLY over an
  // empty failure list. Stripping them is what makes the inner run a real one.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    return {
      raw: execFileSync(process.execPath, ['--test', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      }),
      file,
    };
  } catch (err) {
    return { raw: String(err.stdout || '') + String(err.stderr || ''), file };
  }
}

/** Everything the model would receive. */
function boundaryOf(receipt) {
  return JSON.stringify({
    output: receipt.output,
    failures: receipt.failures,
    errorSummary: receipt.errorSummary,
  });
}

test('the model-facing receipt carries no drive letter and no account name', (t) => {
  const { raw } = failingRun(path.join(BASE, 'outside'));
  const home = path.join(os.homedir(), '.dsh', 'local-router', 'last-verification.log');
  const receipt = parseTestOutput(raw, 1, { rawOutputPath: home });
  const boundary = boundaryOf(receipt);

  assert.ok(receipt.failed > 0, 'the fixture must actually fail, or this proves nothing');
  // Asserted BEFORE anything is read off it, so an empty extraction can never make the checks below pass
  // by having nothing to inspect.
  assert.ok(
    (receipt.failures || []).length > 0,
    'the redactor extracted no failures, so the leak checks would be vacuous. Runner output was:\n' +
      raw.slice(0, 1200)
  );
  assert.doesNotMatch(boundary, /[A-Za-z]:[\\/]/, 'an absolute drive path crossed the boundary');
  assert.ok(
    !boundary.toLowerCase().includes(USER.toLowerCase()),
    'the account name crossed the boundary: ' + boundary
  );
  assert.doesNotMatch(boundary, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

  // The control: the diagnosis SURVIVES. Basename and position are what a retry prompt acts on.
  const location = String((receipt.failures || [])[0].location || '');
  assert.match(location, /failing\.test\.cjs:\d+:\d+$/, 'the file and position must survive: ' + location);
  assert.doesNotMatch(location, /[\\/]/, 'a location outside the workspace is reduced to its basename');

  // The raw log is still named, just not by its absolute path.
  assert.match(receipt.output, /raw output: local-router\/last-verification\.log/, receipt.output);
});

test('a failure inside the workspace keeps its full workspace-relative path', (t) => {
  // The rule must not flatten a path the reader can actually act on. `workspaceRoot` is what makes the
  // difference between "somewhere on this machine" and "tests/contracts/thing.contract.cjs".
  const workspace = path.join(BASE, 'workspace');
  const { raw } = failingRun(path.join(workspace, 'tests', 'contracts'));
  const receipt = parseTestOutput(raw, 1, { workspaceRoot: workspace });
  const location = String((receipt.failures || [])[0].location || '');

  assert.match(
    location,
    /^tests\/contracts\/failing\.test\.cjs:\d+:\d+$/,
    'a path inside the workspace is kept relative to it: ' + location
  );
  // A DRIVE LETTER, not any letter before a colon: the loose form matches the `s:` inside `cjs:4:11`,
  // which would fail a correct relative path. That is how this assertion first reported a false positive.
  assert.doesNotMatch(location, /[A-Za-z]:[\\/]/, 'and still carries no drive letter: ' + location);
});

test('without a workspace root, an absolute location is still reduced', (t) => {
  // The workspace is a refinement, not the thing doing the work: the boundary holds when no caller
  // supplies one, which is the case for any external caller of this exported function.
  const { raw } = failingRun(path.join(BASE, 'noplace'));
  const receipt = parseTestOutput(raw, 1, {});
  const boundary = boundaryOf(receipt);
  assert.doesNotMatch(boundary, /[A-Za-z]:[\\/]/, boundary);
  assert.match(String((receipt.failures || [])[0].location || ''), /failing\.test\.cjs:\d+:\d+$/);
});

process.on('exit', () => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    // A temp directory the OS will reap is not worth failing a run over.
  }
});
