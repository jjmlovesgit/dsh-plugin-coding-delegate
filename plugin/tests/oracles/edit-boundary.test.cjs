// Oracle for the edit boundary: a whole-file emission may create a file, never modify one.
//
// Finding 4 of the contract-first experiment is the case. The worker was told to make exactly one change
// to a 129-line module; it returned a rewritten 86-line module instead. The write landed, and the plugin
// had nothing to say about it: the verdict was VERIFICATION_FAILED either way, which reads as "the module
// is wrong" and says nothing about the edit having been a rewrite. Mutation testing needs the boundary to
// be checked, not requested.
//
// What stood in the way was a size heuristic -- refuse a whole-file overwrite only when the new content is
// less than half the old file's bytes. That is a proxy for "this is not really an edit", and a proxy is
// exactly the wrong instrument here: a substitution that keeps most of the bytes passes it no matter how
// much of the file actually changed.
//
// The rule that replaces it is not a heuristic. The worker has no repository read, so it cannot have seen
// the target file unless the architect injected it, and a file it has not seen can only be replaced
// blindly. So: a whole-file emission is for creation, and modifying an existing file requires a
// search/replace block, which must match the file byte-for-byte. Nothing becomes impossible -- a whole
// file can still be replaced wholesale by patching with the entire content as the search text -- but it
// has to be said, and it has to match what was there.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-edit-boundary-"));
const write = (dir, name, body) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};
const wholeFile = (name, body) => '```ts file="' + name + '"\n' + body + "\n```\n";
const block = (search, replace) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

test("a whole-file emission may not modify a file that already exists", () => {
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  const original = "export const VALUE = 1\nexport const OTHER = 2\n";
  write(dir, "target.ts", original);

  const res = extractAndEmitFiles(
    wholeFile("target.ts", "export const SOMETHING_ELSE = 3\nexport const MORE = 4"),
    ["target.ts"],
    dir,
    [],
    []
  );

  assert.equal(res.filesWritten.length, 0, "the write must not happen");
  assert.ok(res.errors.length > 0, "the refusal must be reported, not silent");
  assert.equal(
    fs.readFileSync(path.join(dir, "target.ts"), "utf8"),
    original,
    "the existing file must be untouched"
  );
});

test("a rewrite that keeps most of the bytes is refused too", () => {
  // The heuristic's blind spot, and the shape of the experiment's failure: the replacement is 92% of the
  // original by size, so the old 50%-smaller rule allowed it, and yet almost every line is different.
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  const original = Array.from({ length: 24 }, (_, i) => "export const A" + i + " = " + i + ";").join("\n") + "\n";
  write(dir, "target.ts", original);
  const replacement =
    Array.from({ length: 22 }, (_, i) => "export const B" + i + " = " + i + ";").join("\n") + "\n";
  assert.ok(
    Buffer.byteLength(replacement) > Buffer.byteLength(original) * 0.5,
    "the fixture must be bigger than half the original, or it proves nothing about the old rule"
  );

  const res = extractAndEmitFiles(wholeFile("target.ts", replacement), ["target.ts"], dir, [], []);

  assert.equal(res.filesWritten.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "target.ts"), "utf8"), original);
});

test("a file is created whole once, and only once", () => {
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();

  const first = extractAndEmitFiles(wholeFile("new.ts", "export const A = 1"), ["new.ts"], dir, [], []);
  assert.equal(first.filesWritten.length, 1, "creation by whole-file emission must still work");
  assert.equal(fs.readFileSync(path.join(dir, "new.ts"), "utf8").includes("export const A = 1"), true);

  const second = extractAndEmitFiles(wholeFile("new.ts", "export const A = 2"), ["new.ts"], dir, [], []);
  assert.equal(second.filesWritten.length, 0, "the second emission is a modification, not a creation");
  assert.equal(fs.readFileSync(path.join(dir, "new.ts"), "utf8").includes("export const A = 1"), true);
});

test("a patch is still how an existing file is changed", () => {
  // The rule constrains the form, not the capability: a wholesale replacement is still expressible, as a
  // patch whose search text is the whole file.
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  const original = "export const VALUE = 1\nexport const OTHER = 2\n";
  write(dir, "target.ts", original);

  const content = '```patch file="target.ts"\n' + block("export const OTHER = 2", "export const OTHER = 3") + "\n```\n";
  const res = extractAndEmitFiles(content, ["target.ts"], dir, [], []);

  assert.equal(res.filesWritten.length, 1);
  assert.equal(res.filesWritten[0].mode, "patch");
  assert.equal(fs.readFileSync(path.join(dir, "target.ts"), "utf8"), "export const VALUE = 1\nexport const OTHER = 3\n");
});

test("a whole-file replacement is expressible as a patch, so the rule blocks no work", () => {
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  const original = "export const VALUE = 1\nexport const OTHER = 2\n";
  write(dir, "target.ts", original);
  const replacement = "export const VALUE = 9\nexport const OTHER = 8\n";

  const content = '```patch file="target.ts"\n' + block(original.trimEnd(), replacement.trimEnd()) + "\n```\n";
  const res = extractAndEmitFiles(content, ["target.ts"], dir, [], []);

  assert.equal(res.filesWritten.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "target.ts"), "utf8"), replacement);
});

test("the refusal says what to do instead", () => {
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  write(dir, "target.ts", "export const VALUE = 1\n");

  const res = extractAndEmitFiles(wholeFile("target.ts", "export const VALUE = 2"), ["target.ts"], dir, [], []);
  const message = res.errors.join("\n");

  assert.match(message, /already exists|existing/i, "it must say which file it refused and why");
  assert.match(message, /patch|search\/replace/i, "it must name the form that works");
});

test("cleanup", () => {
  assert.ok(true);
});
