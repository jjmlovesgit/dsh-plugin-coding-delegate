// Contract oracle: a shell command carrying inline program text counts as write-capable, even when the
// program it carries only reads.
//
// This pins a DECISION, and it exists because a finding written the day before got the mechanism wrong. The
// record said the shell route "cannot tell a filename used as a search pattern from one being read", and that
// grepping for a delegated name was reported as reading that file. The evidence does not support that:
// inspecting text for a filename is not a write signal, and the prompts came from `node -e` one-liners.
//
// `hasCommandWriteSignal` returns true for ANY command line carrying `-e` / `-c` / `--eval` / `-Command` /
// `-EncodedCommand`, because inline program text can write a file the command line never names. That was a
// real hole once -- "inline program text (`python -c`, `node -e`) ... fell through to an allow" -- and the
// list of write primitives is a heuristic that inline source evades by aliasing or string concatenation.
// So the blanket signal is the honest reading rather than the cautious one: the guard cannot prove the
// program is harmless, and rule 2 -- the architect does not author source -- is what this plugin exists to
// hold.
//
// The cost is real and it is named: a read-only one-liner that merely mentions a code file asks for approval.
// Two narrower rules were considered and refused. Scanning the inline body for write primitives would miss
// `require('fs')['write' + 'FileSync']`. Skipping tokens that follow a pattern parameter would re-open the
// same hole from the other side. Neither is worth the boundary.
//
// So this is a characterisation test, not a red-to-green one: it passes as written, and its job is to stop
// the blanket signal being tidied away by someone who reads the prompts as a bug.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..');
const DIST = PLUGIN + '/dist/index.js';
const GUARD = PLUGIN + '/dist/guard.js';

const shell = (command) => ({ name: 'pwsh', arguments: { command } });
// The injectable script reader, so the script-body scan cannot reach the disk and change the outcome of a
// test that is about the command line.
const noScripts = () => undefined;

test('inline program text is a write signal, whatever the program appears to do', () => {
  const { hasCommandWriteSignal } = require(GUARD);
  for (const command of [
    'node -e "console.log(1)"',
    'node --eval "console.log(1)"',
    'python -c "print(1)"',
    'pwsh -Command "Get-ChildItem"',
    'pwsh -EncodedCommand RwBlAHQALQBDAGgAaQBsAGQASQB0AGUAbQA=',
  ]) {
    assert.equal(hasCommandWriteSignal(command), true, command + ' carries inline program text');
  }
});

test('a read-only inspection is not a write signal, so inspecting is not writing', () => {
  const { hasCommandWriteSignal } = require(GUARD);
  for (const command of [
    "Select-String -Path 'x.log' -Pattern 'role-lineage'",
    "Get-ChildItem -Recurse -Filter '*.ts'",
    'git status --porcelain',
  ]) {
    assert.equal(hasCommandWriteSignal(command), false, command + ' carries no write signal');
  }
});

test('an arrow function and an error redirect are not redirections', () => {
  const { hasCommandWriteSignal } = require(GUARD);
  assert.equal(hasCommandWriteSignal('echo "a => b"'), false, '=> is not a redirect');
  assert.equal(hasCommandWriteSignal('echo x 2>&1'), false, '2>&1 is not a source write');
  assert.equal(hasCommandWriteSignal('echo hi > plugin/src/x.ts'), true, 'a real redirect is');
});

test('inspecting text for a code filename is not gated, and the same name inside node -e is', () => {
  const { evaluateCodeWriteGuard } = require(DIST);

  const inspected = evaluateCodeWriteGuard(
    shell("Select-String -Path 'x.log' -Pattern 'plugin/src/guard.ts'"),
    { delegatedPaths: [], readScript: noScripts }
  );
  assert.equal(inspected, null, 'naming a file in order to search for it is not touching it');

  const inline = evaluateCodeWriteGuard(shell('node -e "console.log(\'plugin/src/guard.ts\')"'), {
    delegatedPaths: [],
    readScript: noScripts,
  });
  assert.ok(inline, 'inline program text naming a code file is gated');
  assert.equal(inline.kind, 'ask', 'asked about rather than refused');
  assert.match(String(inline.target), /guard\.ts$/, 'and the target is the reference it found');
  assert.match(
    String(inline.reason),
    /write signal/i,
    'with the reason naming the signal rather than the read: ' + inline.reason
  );
});
