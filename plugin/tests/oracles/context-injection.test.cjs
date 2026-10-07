// Contract oracle for unit A: architect-blind context injection.
//
// Written before the implementation; it fails until the unit exists.
//
// The worker receives target *paths*, never contents, so it cannot modify code it has not seen. The
// fix is transport, not a third model: the plugin reads the declared files and puts them in the
// worker's prompt while the architect learns only metadata. Rule 3 stays intact -- the architect
// supplies names and ranges, and never acquires the code.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-context-"));
const write = (dir, name, body) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

test("the tool declares contextFiles, so the architect can name what the worker may see", () => {
  const { DELEGATE_WORKER_OPENAI_SCHEMA } = require(DIST);
  const props = DELEGATE_WORKER_OPENAI_SCHEMA.function.parameters.properties;
  assert.ok(props.contextFiles, "contextFiles must be a declared tool argument");
  assert.equal(props.contextFiles.type, "array");
});

test("a whole file is injected, and the architect-facing record is metadata only", () => {
  const { resolveContextFiles } = require(DIST);
  const dir = tmp();
  const body = "one\ntwo\nthree";
  write(dir, "a.ts", body);

  const res = resolveContextFiles([{ path: "a.ts" }], dir);

  assert.deepEqual(res.errors, []);
  assert.equal(res.injected.length, 1);
  assert.equal(res.injected[0].lines, 3);
  assert.equal(res.injected[0].bytes, Buffer.byteLength(body, "utf8"));
  assert.equal(res.injected[0].lineRange, null);
  assert.match(res.text, /one\ntwo\nthree/);
  // The record must describe the injection without carrying it.
  assert.equal("content" in res.injected[0], false, "injected metadata must not carry content");
});

test("a line range injects only those lines and reports the range", () => {
  const { resolveContextFiles } = require(DIST);
  const dir = tmp();
  write(dir, "b.ts", "one\ntwo\nthree\nfour");

  const res = resolveContextFiles([{ path: "b.ts", startLine: 2, endLine: 3 }], dir);

  assert.deepEqual(res.errors, []);
  assert.equal(res.injected[0].lines, 2);
  assert.deepEqual(res.injected[0].lineRange, { start: 2, end: 3 });
  assert.match(res.text, /two\nthree/);
  assert.equal(/one/.test(res.text), false, "lines outside the range must not be injected");
});

test("a path outside the workspace is refused rather than read", () => {
  const { resolveContextFiles } = require(DIST);
  const dir = tmp();
  const outside = write(tmp(), "secret.ts", "const leaked = true");

  const res = resolveContextFiles([{ path: outside }], dir);

  assert.equal(res.injected.length, 0);
  assert.ok(res.errors.length > 0, "an out-of-workspace path must be reported");
  assert.equal(res.text.includes("leaked"), false);
});

test("a declared file that does not exist is refused", () => {
  const { resolveContextFiles } = require(DIST);
  const res = resolveContextFiles([{ path: "missing-file.ts" }], tmp());
  assert.equal(res.injected.length, 0);
  assert.ok(res.errors.some((e) => /missing-file\.ts/.test(e)));
});

test("exceeding the byte budget is refused and reported, never silently truncated", () => {
  const { resolveContextFiles } = require(DIST);
  const dir = tmp();
  write(dir, "big.ts", "x".repeat(500));

  const res = resolveContextFiles([{ path: "big.ts" }], dir, [], 100);

  assert.equal(res.injected.length, 0, "an over-budget injection must not be partially applied");
  assert.ok(
    res.errors.some((e) => /budget|bytes/i.test(e)),
    `expected a budget refusal, got: ${JSON.stringify(res.errors)}`
  );
});

test("the recorded sha256 is of the bytes actually injected, not of the whole file", () => {
  const { resolveContextFiles, sha256File } = require(DIST);
  const dir = tmp();
  const file = write(dir, "c.ts", "one\ntwo\nthree");
  const wholeFileHash = sha256File(file);

  const res = resolveContextFiles([{ path: "c.ts", startLine: 1, endLine: 1 }], dir);

  assert.equal(res.injected.length, 1);
  assert.notEqual(res.injected[0].sha256, wholeFileHash, "a slice must not hash as the whole file");
  assert.match(res.injected[0].sha256, /^[0-9a-f]{64}$/);
});

test("the injected context reaches the worker prompt, and the verdict carries metadata only", async () => {
  const { delegateWorker } = require(DIST);
  const dir = tmp();
  write(dir, "target.ts", "export const VALUE = 1\nexport const OTHER = 2\n");

  let received = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Understood." } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const verdict = await delegateWorker({
      taskName: "context-check",
      instruction: "Change OTHER to 3.",
      contextFiles: [{ path: "target.ts", startLine: 2, endLine: 2 }],
      workspaceDir: dir,
      endpoint: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 15000,
    });

    assert.ok(received, "the worker endpoint must have been called");
    const prompt = JSON.parse(received).messages.map((m) => m.content).join("\n");
    assert.match(prompt, /export const OTHER = 2/, "the declared context must reach the worker");
    assert.equal(/export const VALUE = 1/.test(prompt), false, "only the declared range may travel");

    assert.equal(verdict.contextInjected.length, 1);
    assert.equal(verdict.contextInjected[0].relativeName, "target.ts");
    assert.match(verdict.contextInjected[0].sha256, /^[0-9a-f]{64}$/);
    // The architect gets the record, never the code.
    assert.equal(JSON.stringify(verdict).includes("export const OTHER"), false);
  } finally {
    server.close();
  }
});

test("unresolvable context refuses the delegation instead of calling the worker blind", async () => {
  const { delegateWorker } = require(DIST);
  const dir = tmp();
  const verdict = await delegateWorker({
    taskName: "refuse-check",
    instruction: "Change something.",
    contextFiles: [{ path: "does-not-exist.ts" }],
    workspaceDir: dir,
    // Port 1 refuses instantly, so a CONTEXT_REFUSED answer proves no fetch was attempted.
    endpoint: "http://127.0.0.1:1/v1",
    timeoutMs: 5000,
  });

  assert.equal(verdict.success, false);
  assert.equal(verdict.status, "CONTEXT_REFUSED");
  assert.deepEqual(verdict.filesWritten, []);
  assert.ok(verdict.contextErrors.some((e) => /does-not-exist\.ts/.test(e)));
});

test("context carrying a credential is refused rather than handed to a possibly-remote endpoint", async () => {
  const { delegateWorker } = require(DIST);
  const dir = tmp();
  write(dir, "config.ts", 'export const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"\n');

  const verdict = await delegateWorker({
    taskName: "dlp-check",
    instruction: "Read the key.",
    contextFiles: [{ path: "config.ts" }],
    workspaceDir: dir,
    endpoint: "http://127.0.0.1:1/v1",
    timeoutMs: 5000,
  });

  assert.equal(verdict.success, false);
  assert.equal(verdict.status, "CONTEXT_REFUSED");
  assert.ok(
    verdict.contextErrors.some((e) => /credential|secret|DLP/i.test(e)),
    `expected a DLP refusal, got: ${JSON.stringify(verdict.contextErrors)}`
  );
});
