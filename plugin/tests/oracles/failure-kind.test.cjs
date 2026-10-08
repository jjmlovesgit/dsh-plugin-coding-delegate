// Contract oracle: a failure's KIND comes from what failed, not from a word that appears nearby.
//
// `redactVerificationOutput` decides each failure's kind while walking TAP, and the kind is the difference
// between "your expectations did not hold" and "the command did not finish in time". The first version got
// it wrong in a way that only appeared on aggregated multi-file output: an assertion failure was reported as
// [timeout]. The parser scanned every unrecognised line inside a failure block for the word "timeout" and let
// it overwrite the kind -- and this suite contains tests named for a timeout, whose lines can land inside an
// open failure block.
//
// Properties:
//   1. `code: ERR_ASSERTION` settles the kind as `assertion`, wherever it appears in the block.
//   2. Text after a failure block does not relabel it.
//   3. A genuine timeout, with no assertion code, still reads as `timeout`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..');
const VERIFICATION = PLUGIN + '/dist/verification.js';

const { redactVerificationOutput } = require(VERIFICATION);

const FAILING = [
  'not ok 22 - with no provider configured the host route is left alone',
  '  ---',
  '  duration_ms: 1.2',
  "  type: 'test'",
  "  location: '/repo/tests/x.test.cjs:44:1'",
  "  failureType: 'testCodeFailure'",
  "  error: 'the host route was clobbered'",
  "  code: 'ERR_ASSERTION'",
  '  ...',
].join('\n');

test('the assertion code settles the kind wherever it appears in the block', () => {
  const codeLast = redactVerificationOutput(
    ['TAP version 13', 'not ok 1 - a test', '  ---', '  timeout: 30000', "  code: 'ERR_ASSERTION'", '  ...'].join(
      '\n'
    )
  );
  assert.equal(
    codeLast[0].kind,
    'assertion',
    'a line mentioning a timeout must not outrank the failure code: ' + JSON.stringify(codeLast[0])
  );

  const codeFirst = redactVerificationOutput(
    ['TAP version 13', 'not ok 1 - a test', '  ---', "  code: 'ERR_ASSERTION'", '  timeout: 30000', '  ...'].join(
      '\n'
    )
  );
  assert.equal(codeFirst[0].kind, 'assertion', 'and the order of the two must not matter');
});

test('text after a failure block does not relabel it', () => {
  const tap = [
    'TAP version 13',
    FAILING,
    'ok 23 - the sandbox refuses a spawn and reports a verification timeout',
    'ok 24 - another passing test',
  ].join('\n');

  const failures = redactVerificationOutput(tap);
  assert.equal(failures.length, 1, 'one failure was reported');
  assert.equal(
    failures[0].kind,
    'assertion',
    'a passing test named for a timeout must not turn the failure above it into one: ' +
      JSON.stringify(failures[0])
  );
  assert.match(String(failures[0].name), /22\./, 'and it is still the failure that failed');
});

test('a genuine timeout still reads as a timeout', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - the unit took too long',
    '  ---',
    "  failureType: 'testTimeoutFailure'",
    '  error: the test timed out after 30000ms',
    '  ...',
  ].join('\n');

  const failures = redactVerificationOutput(tap);
  assert.equal(failures.length, 1, 'one failure was reported');
  assert.equal(failures[0].kind, 'timeout', 'no assertion code, and the failure is a timeout');
});
