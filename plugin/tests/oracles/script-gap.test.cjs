// Oracle for the script-mediation gap: a shell command that invokes a script must be
// judged by what that script writes, not just by the command line.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const { evaluateCodeWriteGuard } = require(PLUGIN + "/dist/index.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "guard-script-"));
const shell = (command) => ({ name: "pwsh", arguments: { command } });

function writeScript(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

test("the real evasion I used all session is now caught", () => {
  // Mirrors the one-shot patch scripts used during this session: they wrote plugin source
  // through .NET rather than through a cmdlet, so only a body scan can see them. The fixture
  // is generated here because those scripts are session scratch and get cleaned up.
  const p = writeScript(
    "patch-plugin-dlp-gate.ps1",
    "$p = 'C:/repo/plugin/src/index.ts'\n" +
      "$t = [System.IO.File]::ReadAllText($p)\n" +
      "[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))\n"
  );
  const verdict = evaluateCodeWriteGuard(shell(`& '${p.replace(/\\/g, "/")}'`));
  assert.ok(verdict, "invoking a source-writing script must not be silently allowed");
  assert.equal(verdict.kind, "ask");
  assert.match(verdict.reason, /patch-plugin-dlp-gate\.ps1/);
  assert.match(verdict.reason, /script-mediated/i);
});

test("a script that writes source files is flagged", () => {
  const p = writeScript("writes-code.ps1", "$c = 'x'\n[System.IO.File]::WriteAllText('src/thing.ts', $c)\n");
  const verdict = evaluateCodeWriteGuard(shell(`& '${p}'`), { readScript: (s) => fs.readFileSync(s, "utf8") });
  assert.ok(verdict, "expected a verdict");
  assert.equal(verdict.kind, "ask");
  assert.match(verdict.target, /\.ts$/);
});

test("a script that deletes source files is flagged too", () => {
  // Destroying source is gated the same way as authoring it, in a script body as well as
  // on the command line.
  const p = writeScript("deletes-code.ps1", "Remove-Item src/thing.ts -Force\n");
  const verdict = evaluateCodeWriteGuard(shell(`& '${p}'`), { readScript: (s) => fs.readFileSync(s, "utf8") });
  assert.ok(verdict, "a script-mediated delete must not be silently allowed");
  assert.equal(verdict.kind, "ask");
  assert.match(verdict.target, /\.ts$/);
});

test("nested script invocations are followed", () => {
  const inner = writeScript("inner.ps1", "Set-Content -Path app/main.py -Value 'x'\n");
  writeScript("outer.ps1", `& '${inner.replace(/\\/g, "/")}'\n`);
  const outer = path.join(TMP, "outer.ps1");
  const verdict = evaluateCodeWriteGuard(shell(`& '${outer}'`), { readScript: (s) => fs.readFileSync(s, "utf8") });
  assert.ok(verdict, "a nested write must still be found");
  assert.equal(verdict.kind, "ask");
});

test("a script cycle terminates instead of hanging", () => {
  const a = path.join(TMP, "cycle-a.ps1");
  const b = path.join(TMP, "cycle-b.ps1");
  fs.writeFileSync(a, `& '${b.replace(/\\/g, "/")}'\n`, "utf8");
  fs.writeFileSync(b, `& '${a.replace(/\\/g, "/")}'\n`, "utf8");
  const start = Date.now();
  const verdict = evaluateCodeWriteGuard(shell(`& '${a}'`), { readScript: (s) => fs.readFileSync(s, "utf8") });
  assert.equal(verdict, null, "mutual invocation with no writes should be allowed");
  assert.ok(Date.now() - start < 2000, "must not spin");
});

test("depth is bounded", () => {
  const deep = writeScript("deep.ps1", "Set-Content src/deep.ts -Value 1\n");
  const mid = writeScript("mid.ps1", `& '${deep.replace(/\\/g, "/")}'\n`);
  const top = writeScript("top.ps1", `& '${mid.replace(/\\/g, "/")}'\n`);
  const read = (s) => fs.readFileSync(s, "utf8");
  assert.ok(evaluateCodeWriteGuard(shell(`& '${top}'`), { readScript: read, scriptDepth: 3 }), "depth 3 finds it");
  assert.equal(
    evaluateCodeWriteGuard(shell(`& '${top}'`), { readScript: read, scriptDepth: 1 }),
    null,
    "depth 1 must not descend"
  );
});

test("a script that writes only non-code is allowed", () => {
  const p = writeScript("logs.ps1", "Add-Content -Path out.log -Value 'done'\nOut-File -FilePath report.json\n");
  assert.equal(
    evaluateCodeWriteGuard(shell(`& '${p}'`), { readScript: (s) => fs.readFileSync(s, "utf8") }),
    null
  );
});

test("arrow functions and comparisons never read as writes", () => {
  // The reason a bare '>' was excluded from the write primitives.
  const p = writeScript("arrows.mjs", "const f = (a) => a > 1 ? 'big' : 'small';\nexport default f;\n");
  assert.equal(
    evaluateCodeWriteGuard(shell(`node '${p}'`), { readScript: (s) => fs.readFileSync(s, "utf8") }),
    null,
    "a file full of => must not be flagged"
  );
});

test("a missing script is not a finding", () => {
  assert.equal(evaluateCodeWriteGuard(shell("& 'C:/nope/missing.ps1'")), null);
});

test("running a test file is still allowed", () => {
  const p = writeScript("suite.test.mjs", "import test from 'node:test';\ntest('x', () => {});\n");
  assert.equal(
    evaluateCodeWriteGuard(shell(`node '${p}'`), { readScript: (s) => fs.readFileSync(s, "utf8") }),
    null
  );
});

test("direct command-line writes are unaffected (regression)", () => {
  const direct = evaluateCodeWriteGuard(shell("Set-Content -Path src/x.ts -Value 1"));
  assert.equal(direct.kind, "ask");
  assert.equal(direct.target, "src/x.ts");

  const redirect = evaluateCodeWriteGuard(shell("echo hi > src/y.py"));
  assert.equal(redirect.kind, "ask");

  assert.equal(evaluateCodeWriteGuard(shell("git status")), null);
  assert.equal(evaluateCodeWriteGuard({ name: "write", arguments: { file_path: "src/z.ts" } }).kind, "deny");
});

test("cleanup", () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.ok(!fs.existsSync(TMP));
});
