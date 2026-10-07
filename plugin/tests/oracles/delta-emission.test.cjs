// Contract oracle for unit B: search/replace delta emission.
//
// Written before the implementation; it fails until the unit exists.
//
// Context injection gives the worker the bytes it must change, but the worker still returns whole
// files bounded by its output budget, so it cannot hand back a large existing file in one piece. A
// delta is the fix, and the format is search/replace rather than unified diff on purpose: the worker
// runs with thinking disabled, so asking it to compute @@ line offsets is asking for the thing it is
// worst at, while quoting bytes it was just shown is the thing it is best at.
//
// The safety property is exactness. A fuzzy patch is not a tuning decision, it is the mechanism by
// which a wrong edit lands silently, so a near miss fails loudly and is re-delegated.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-delta-"));
const write = (dir, name, body) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};
const block = (search, replace) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

test("a search/replace body is recognised, and a whole-file body is not", () => {
  const { parseSearchReplaceBlocks } = require(DIST);
  assert.equal(parseSearchReplaceBlocks("module.exports = 1\n"), null);
  const blocks = parseSearchReplaceBlocks(block("const a = 1", "const a = 2"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].search, "const a = 1");
  assert.equal(blocks[0].replace, "const a = 2");
});

test("an exact single match is applied", () => {
  const { applySearchReplaceBlocks } = require(DIST);
  const original = "const a = 1\nconst b = 2\n";
  const res = applySearchReplaceBlocks(original, [{ search: "const a = 1", replace: "const a = 9" }]);
  assert.equal(res.ok, true);
  assert.equal(res.content, "const a = 9\nconst b = 2\n");
});

test("a search that matches nothing is refused, not approximated", () => {
  const { applySearchReplaceBlocks } = require(DIST);
  const res = applySearchReplaceBlocks("const a = 1\n", [
    { search: "const a = 2", replace: "const a = 3" },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /no exact match|not found/i);
});

test("a search that matches more than once is refused as ambiguous", () => {
  const { applySearchReplaceBlocks } = require(DIST);
  const res = applySearchReplaceBlocks("const a = 1\nconst a = 1\n", [
    { search: "const a = 1", replace: "const a = 2" },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /more than once|ambiguous/i);
});

test("a trivially short search is refused even when it happens to be unique", () => {
  const { applySearchReplaceBlocks } = require(DIST);
  const res = applySearchReplaceBlocks("const x = 1\n", [{ search: "x", replace: "y" }]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /short|ambiguous/i);
});

test("blocks apply all-or-nothing", () => {
  const { applySearchReplaceBlocks } = require(DIST);
  const original = "const a = 1\nconst b = 2\n";
  const res = applySearchReplaceBlocks(original, [
    { search: "const a = 1", replace: "const a = 9" },
    { search: "const c = 3", replace: "const c = 4" },
  ]);
  assert.equal(res.ok, false);
  // The first block must not have been applied on the way to failing.
  assert.equal(res.content, undefined);
});

test("the file's own line endings survive the edit", () => {
  const { applySearchReplaceBlocks } = require(DIST);
  const res = applySearchReplaceBlocks("const a = 1\r\nconst b = 2\r\n", [
    { search: "const a = 1", replace: "const a = 9" },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.content, "const a = 9\r\nconst b = 2\r\n");
});

test("a patch edits the file in place and preserves everything it did not touch", async () => {
  const { delegateWorker } = require(DIST);
  const dir = tmp();
  const original = "export const VALUE = 1\nexport const OTHER = 2\n";
  write(dir, "target.ts", original);

  const content =
    '```patch file="target.ts"\n' +
    block("export const OTHER = 2", "export const OTHER = 3") +
    "\n```\n";

  const verdict = await runAgainstWorker(content, {
    taskName: "patch-check",
    instruction: "Change OTHER to 3.",
    targetFiles: ["target.ts"],
    contextFiles: [{ path: "target.ts" }],
    workspaceDir: dir,
  });

  assert.equal(verdict.filesWritten.length, 1);
  const after = fs.readFileSync(path.join(dir, "target.ts"), "utf8");
  assert.equal(after, "export const VALUE = 1\nexport const OTHER = 3\n");
  assert.match(verdict.summary, /patch|1 hunk|applied/i);
});

test("a patch that does not match leaves the file untouched and reports why", async () => {
  const { delegateWorker } = require(DIST);
  const dir = tmp();
  const original = "export const VALUE = 1\n";
  write(dir, "target.ts", original);

  const content =
    '```patch file="target.ts"\n' + block("export const NOPE = 9", "export const NOPE = 8") + "\n```\n";

  const verdict = await runAgainstWorker(content, {
    taskName: "patch-miss",
    instruction: "Change something that is not there.",
    targetFiles: ["target.ts"],
    workspaceDir: dir,
  });

  assert.equal(fs.readFileSync(path.join(dir, "target.ts"), "utf8"), original);
  assert.equal(verdict.success, false);
  assert.match(verdict.summary, /no exact match|not found|refused/i);
});

test("a patch against a file that does not exist is refused", () => {
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  const content =
    '```patch file="absent.ts"\n' + block("const a = 1", "const a = 2") + "\n```\n";
  const res = extractAndEmitFiles(content, ["absent.ts"], dir, [], []);
  assert.equal(res.filesWritten.length, 0);
  assert.ok(res.errors.some((e) => /does not exist|cannot patch/i.test(e)));
  assert.equal(fs.existsSync(path.join(dir, "absent.ts")), false);
});

/** Serve one canned worker reply, so the test drives the real code path rather than a helper. */
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
      endpoint: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 15000,
    });
  } finally {
    server.close();
  }
}
