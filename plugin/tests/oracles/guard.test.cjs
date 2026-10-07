// Independent oracle for the local-only code guard.
// Exercises the exported pure evaluator from the BUILT plugin, so the decision
// logic is verified without needing a running server.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const { evaluateCodeWriteGuard } = require(PLUGIN + "/dist/index.js");

const write = (args) => ({ name: "write", arguments: args });
const edit = (args) => ({ name: "edit", arguments: args });
const shell = (command) => ({ name: "pwsh", arguments: { command } });

test("denies source writes from the cloud context", () => {
  for (const path of [
    "src/priority-queue.ts",
    "src/table-controller.js",
    "C:\\Projects\\temp\\src\\thing.ts",
    "app/component.tsx",
    "service/main.py",
    "Program.cs",
    "index.html",
    "styles/site.css",
    "deploy.ps1",
    "query.sql",
    "build.sh",
  ]) {
    const v = evaluateCodeWriteGuard(write({ file_path: path }));
    assert.ok(v, `expected a verdict for ${path}`);
    assert.equal(v.kind, "deny", `${path} should be denied, got ${v.kind}`);
    assert.equal(v.target, path);
    assert.match(v.reason, /delegate_worker/);
  }
});

test("extension match is case-insensitive", () => {
  const v = evaluateCodeWriteGuard(write({ file_path: "Src/Thing.TS" }));
  assert.equal(v.kind, "deny");
});

test("agent edits are guarded too, not just new writes", () => {
  const v = evaluateCodeWriteGuard(edit({ path: "src/existing.ts", old_string: "a", new_string: "b" }));
  assert.equal(v.kind, "deny");
});

test("all documented argument keys are recognised", () => {
  for (const key of ["file_path", "filePath", "path", "filename", "file", "target_file", "targetPath"]) {
    const v = evaluateCodeWriteGuard(write({ [key]: "src/x.ts" }));
    assert.ok(v, `key ${key} was not detected`);
    assert.equal(v.kind, "deny");
  }
});

test("non-code files pass through untouched", () => {
  for (const path of [
    "docs/architecture.md",
    "README.md",
    "notes.txt",
    "data.json",
    "config.yaml",
    "savings-ledger.json",
    "image.png",
    "Makefile",
  ]) {
    assert.equal(evaluateCodeWriteGuard(write({ file_path: path })), null, `${path} should pass`);
  }
});

test("architect-owned test and tooling paths escalate to approval, not denial", () => {
  for (const path of ["tests/guard.test.cjs", "tests/priority-queue.test.ts", "tools/lm-client.mjs"]) {
    const v = evaluateCodeWriteGuard(write({ file_path: path }));
    assert.ok(v, `expected a verdict for ${path}`);
    assert.equal(v.kind, "ask", `${path} should ask, got ${v.kind}`);
  }
  // Absolute Windows path form must still match the ask fragment.
  const win = evaluateCodeWriteGuard(write({ file_path: "C:\\Projects\\temp\\tests\\x.mjs" }));
  assert.equal(win.kind, "ask");
});

test("read-only tools and unknown tools are never blocked", () => {
  assert.equal(evaluateCodeWriteGuard({ name: "read", arguments: { file_path: "src/x.ts" } }), null);
  assert.equal(evaluateCodeWriteGuard({ name: "present", arguments: { files: [{ path: "src/x.ts" }] } }), null);
  assert.equal(evaluateCodeWriteGuard({ name: "delegate_worker", arguments: { targetFiles: ["src/x.ts"] } }), null);
  assert.equal(evaluateCodeWriteGuard({ name: "glob", arguments: { pattern: "**/*.ts" } }), null);
});

test("malformed calls are ignored rather than crashing the pipeline", () => {
  assert.equal(evaluateCodeWriteGuard({ name: "write" }), null);
  assert.equal(evaluateCodeWriteGuard({ name: "write", arguments: null }), null);
  assert.equal(evaluateCodeWriteGuard({ name: "write", arguments: {} }), null);
  assert.equal(evaluateCodeWriteGuard({ name: "write", arguments: { file_path: "" } }), null);
  assert.equal(evaluateCodeWriteGuard({}), null);
  assert.equal(evaluateCodeWriteGuard(null), null);
});

test("shell writes to code files escalate to approval", () => {
  for (const cmd of [
    'Set-Content src/thing.ts -Value "x"',
    'Out-File -Path app/main.py',
    "echo hi > build.rs",
    "cat header.txt >> styles/site.css",
  ]) {
    const v = evaluateCodeWriteGuard(shell(cmd));
    assert.ok(v, `expected a verdict for: ${cmd}`);
    assert.equal(v.kind, "ask", `${cmd} should ask`);
  }
});

test("ordinary shell commands are not blocked", () => {
  for (const cmd of [
    "node tests/dashboard.test.mjs",
    "git status",
    "Get-ChildItem C:\\Projects\\temp",
    "node tools/bench-tokens.mjs",
    "npm run build",
  ]) {
    assert.equal(evaluateCodeWriteGuard(shell(cmd)), null, `should not block: ${cmd}`);
  }
});

test("askPaths can be overridden", () => {
  // A custom list that matches nothing makes test paths hard-denied again.
  const strict = evaluateCodeWriteGuard(write({ file_path: "tests/x.mjs" }), { askPaths: ["nothing/"] });
  assert.equal(strict.kind, "deny");
  // An empty list falls back to the documented defaults.
  const fallback = evaluateCodeWriteGuard(write({ file_path: "tests/x.mjs" }), { askPaths: [] });
  assert.equal(fallback.kind, "ask");
  // A custom fragment can protect another tree.
  const custom = evaluateCodeWriteGuard(write({ file_path: "verification/oracle.mjs" }), {
    askPaths: ["verification/"],
  });
  assert.equal(custom.kind, "ask");
});

test("the guard never silently allows a code write by accident", () => {
  // Sweep a broad set of source extensions through the write tool.
  const extensions = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
    "kt", "cs", "c", "cpp", "h", "swift", "php", "scala", "lua", "dart",
    "sh", "ps1", "sql", "html", "css", "scss", "vue", "svelte",
  ];
  const missed = extensions.filter(
    (ext) => evaluateCodeWriteGuard(write({ file_path: `src/generated.${ext}` })) === null
  );
  assert.deepEqual(missed, [], `these extensions escaped the guard: ${missed.join(", ")}`);
});
