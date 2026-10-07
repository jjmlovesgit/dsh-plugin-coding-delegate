// Contract oracle: a unit's declared targets are a boundary, not only a hint.
//
// Written before the implementation; it fails until the unit exists.
//
// Why. Measured against the code before writing this: `targetFiles` was read in two places, both passive.
// It became prompt text ("Target Files:") and it was the fallback path-chooser when a fenced block named
// no file of its own. Emission constrained writes by containment -- the workspace and `emitAllowlist` --
// and by `contractFiles`, and by nothing else. So a unit told to change `parser.ts` could rewrite
// `types.ts`, and nothing refused it, reported it, or noticed.
//
// That is the precondition for cross-unit incoherence, and it happens strictly before any coherence
// check could run: by the time a project-level check notices, the sprawl has already landed and there is
// no record of which unit caused it. Declaring targets and enforcing them is what makes a later global
// failure attributable.
//
// The precedent is already in this codebase: `contractFiles` is declared, then enforced, then re-hashed.
// This is the same shape, one level down.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// Delegation persists through rememberDelegated, so redirect the data directory before loading DIST.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-scope-data-"));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-scope-"));
const emitted = (name) => '```ts file="' + name + '"\nexport const made = 1\n```\n';

async function runAgainstWorker(content, params) {
  const { delegateWorker } = require(DIST);
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await delegateWorker({
      ...params,
      endpoint: "http://127.0.0.1:" + port + "/v1",
      timeoutMs: 15000,
    });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- the decision, as a pure function

test("a declared target is allowed, and so is anything beneath a declared directory", () => {
  const { evaluateUnitScope } = require(DIST);
  const dir = tmp();
  assert.equal(evaluateUnitScope(path.join(dir, "a.ts"), ["a.ts"], dir).allowed, true);
  // A declared directory covers its subtree, which is what makes `src/` usable as a declaration.
  assert.equal(evaluateUnitScope(path.join(dir, "src", "deep", "x.ts"), ["src"], dir).allowed, true);
  assert.equal(evaluateUnitScope(path.join(dir, "src", "x.ts"), ["src/"], dir).allowed, true);
});

test("a path outside every declared target is refused, with a reason that names the declaration", () => {
  const { evaluateUnitScope } = require(DIST);
  const dir = tmp();
  const verdict = evaluateUnitScope(path.join(dir, "b.ts"), ["a.ts"], dir);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /declared/i);
  assert.match(verdict.reason, /a\.ts/, "the refusal must say what WAS declared, or it is unactionable");
});

test("a sibling that merely shares a prefix is not inside a declared target", () => {
  const { evaluateUnitScope } = require(DIST);
  const dir = tmp();
  // `src-extra/x.ts` starts with the same characters as `src` and must not be treated as inside it.
  assert.equal(evaluateUnitScope(path.join(dir, "src-extra", "x.ts"), ["src"], dir).allowed, false);
});

test("declaring nothing constrains nothing", () => {
  const { evaluateUnitScope } = require(DIST);
  const dir = tmp();
  // The distinction the whole unit rests on: a boundary exists where something was declared. A unit that
  // declared no targets has not exceeded them, and refusing everything for an empty list would break
  // every caller that never used the field.
  assert.equal(evaluateUnitScope(path.join(dir, "anything.ts"), [], dir).allowed, true);
  assert.equal(evaluateUnitScope(path.join(dir, "anything.ts"), undefined, dir).allowed, true);
});

test("a trailing slash and a redundant segment do not change the answer", () => {
  const { evaluateUnitScope } = require(DIST);
  const dir = tmp();
  assert.equal(evaluateUnitScope(path.join(dir, "a.ts"), ["./a.ts"], dir).allowed, true);
  assert.equal(evaluateUnitScope(path.join(dir, "src", "a.ts"), ["src/../src/a.ts"], dir).allowed, true);
});

// ---------------------------------------------------------------- end to end

test("a unit that writes outside its declared targets is refused, and the file is not written", async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("b.ts"), {
    taskName: "scope-refused",
    instruction: "Write b.ts.",
    targetFiles: ["a.ts"],
    workspaceDir: dir,
  });
  assert.equal(verdict.filesWritten.length, 0, "nothing may be written");
  assert.equal(fs.existsSync(path.join(dir, "b.ts")), false, "and the file must not exist");
  assert.ok(
    verdict.filesWritten.length === 0 && /declared/i.test(verdict.summary),
    "the refusal must be reported in the verdict: " + verdict.summary
  );
});

test("a unit that writes its declared target is left alone", async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("a.ts"), {
    taskName: "scope-allowed",
    instruction: "Write a.ts.",
    targetFiles: ["a.ts"],
    workspaceDir: dir,
  });
  assert.equal(verdict.filesWritten.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "a.ts")), true);
});

test("with no targets declared, the old permissive behaviour is unchanged", async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("anywhere.ts"), {
    taskName: "scope-undeclared",
    instruction: "Write anywhere.ts.",
    workspaceDir: dir,
  });
  assert.equal(verdict.filesWritten.length, 1, "declaring nothing must not refuse everything");
  assert.equal(fs.existsSync(path.join(dir, "anywhere.ts")), true);
});

test("the operator can turn the boundary off", async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("b.ts"), {
    taskName: "scope-off",
    instruction: "Write b.ts.",
    targetFiles: ["a.ts"],
    workspaceDir: dir,
    unitScope: "off",
  });
  assert.equal(verdict.filesWritten.length, 1, "unitScope 'off' restores the permissive behaviour");
  assert.equal(fs.existsSync(path.join(dir, "b.ts")), true);
});

// ---------------------------------------------------------------- the refusal is not retried

test("a write refused for being outside the workspace is not retried inside it", async () => {
  // Found while building the scope boundary, and it is the more serious half of the same defect. The
  // `targetFiles` fallback existed for output that named no file of its own, but it ran whenever nothing
  // had been WRITTEN -- including when a named file had been REFUSED. So a containment refusal was walked
  // straight around: the content meant for a path outside the workspace would be written at the declared
  // hint instead, and the verdict would report a file rather than a refusal.
  const dir = tmp();
  const elsewhere = tmp();
  const escape = path.join(elsewhere, "escaped.ts").replace(/\\/g, "/");

  const verdict = await runAgainstWorker(
    '```ts file="' + escape + '"\nexport const escaped = 1\n```\n',
    {
      taskName: "scope-escape",
      instruction: "Write outside the workspace.",
      targetFiles: ["inside.ts"],
      workspaceDir: dir,
    }
  );

  assert.equal(fs.existsSync(path.join(elsewhere, "escaped.ts")), false, "nothing outside the workspace");
  assert.equal(
    fs.existsSync(path.join(dir, "inside.ts")),
    false,
    "and the refused content must not land at the declared hint instead"
  );
  assert.equal(verdict.filesWritten.length, 0);
  assert.match(verdict.summary, /FILE WRITE ERRORS/i, "the refusal must be reported, not silently rerouted");
});
