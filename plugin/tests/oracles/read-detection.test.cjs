// Oracle: reading a file is not running it.
//
// Honest provenance: this is a CHARACTERISATION oracle, not a contract. The behaviour already exists
// (READ_ONLY_INSPECTORS + isReadArgument), and this suite passed on its first run. It was added because
// the wider behaviour was verified by hand with a throwaway probe and would otherwise have been lost
// with it. The narrow case is covered by plugin.test.ts; the forms below are the ones that were not.
//
// The false positive it pins down: `Select-String -Path some.js` was treated as an invocation of
// `some.js`. The guard read the file, found a write primitive -- as any sizeable program contains --
// and asked for approval to *read* it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const { evaluateCodeWriteGuard } = require(PLUGIN + "/dist/index.js");

const shell = (command) => ({ name: "pwsh", arguments: { command } });

// A script that really does write source, so a body scan that ignored the read/invoke distinction
// would have something to find.
const WRITER = "const fs = require('fs')\nfs.writeFileSync('src/other.ts', 'x')\n";
const HARMLESS = "console.log('nothing to see')\n";
const readWriter = () => WRITER;
const readHarmless = () => HARMLESS;

const READS = [
  "Select-String -Path thing.js",
  "Select-String thing.js",
  "Select-String -Path ./thing.js -Pattern x",
  "Select-String -Path 'thing.js' -Pattern x",
  "Select-String -Pattern 'TODO' -Path thing.js",
  'Select-String -Path "src/a.js","src/b.js" -Pattern x',
  "Select-String -Path thing.js -Pattern x",
  "Get-Content thing.js",
  "cat thing.js",
  "type thing.js",
  "more thing.js",
  "grep x thing.js",
  "Select-String -Path thing.js | Select-String x",
  "Get-ChildItem -Filter *.js | Select-String x",
];

const INVOCATIONS = ["node thing.js", "& thing.js", "./thing.js", "thing.js"];

test("no read-only inspector form is mistaken for an invocation", () => {
  for (const command of READS) {
    const verdict = evaluateCodeWriteGuard(shell(command), { readScript: readWriter });
    assert.equal(verdict, null, `${command} should be open, got ${verdict && verdict.kind}`);
  }
});

test("invocation is still gated, however it is spelled", () => {
  for (const command of INVOCATIONS) {
    const verdict = evaluateCodeWriteGuard(shell(command), { readScript: readWriter });
    assert.ok(verdict, `${command} should be gated`);
    assert.equal(verdict.kind, "ask", `${command} should ask, got ${verdict.kind}`);
    assert.equal(verdict.target, "src/other.ts", `${command} should report the real target`);
  }
});

test("running a script that writes nothing source-shaped is left alone", () => {
  // The control: the gate above fires because the body writes source, not because a script ran.
  for (const command of ["node plain.js", "& plain.js", "./plain.js"]) {
    assert.equal(
      evaluateCodeWriteGuard(shell(command), { readScript: readHarmless }),
      null,
      `${command} should be open`
    );
  }
});

test("non-source reads are not the guard's business either", () => {
  for (const command of ["Select-String -Path notes.txt", "cat notes.txt", "node notes.txt"]) {
    assert.equal(
      evaluateCodeWriteGuard(shell(command), { readScript: readWriter }),
      null,
      `${command} should be open`
    );
  }
});
