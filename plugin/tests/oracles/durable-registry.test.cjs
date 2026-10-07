// Contract oracle: the delegated-path registry must survive a restart.
//
// Written before the implementation; it fails until the unit exists.
//
// The read guard protects files the plugin wrote on a delegation's behalf, and it kept that list in
// memory only. A live run showed the consequence: reloading the desktop app emptied the list, so after
// a restart the architect could read previously delegated source without being asked. The registry was
// documented as "in-memory and process-scoped on purpose", which was true and was also the bug.
//
// So it becomes a small JSON in the plugin data directory, holding each path with the hash of what was
// written. The hash is not used to relax the gate -- a delegated file stays protected however it
// changes -- it makes the record answerable and gives a pruning signal for files that no longer exist.
//
// The data directory is redirected to a temp directory before the module is loaded, so these tests
// never touch the operator's real registry.
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-registry-"));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const record = (p, sha = "a".repeat(64), at = 1) => ({ path: p, sha256: sha, at });

test("garbage in the registry file is ignored rather than thrown", () => {
  const { parseDelegatedRegistry } = require(DIST);
  for (const junk of ["", "not json at all", "[]", "null", '{"version":1}', "{}"]) {
    const parsed = parseDelegatedRegistry(junk);
    assert.deepEqual(parsed, [], `expected [] for ${JSON.stringify(junk)}`);
  }
});

test("entries missing a path are dropped, and a good entry survives", () => {
  const { parseDelegatedRegistry } = require(DIST);
  const parsed = parseDelegatedRegistry(
    JSON.stringify({
      version: 1,
      records: [record("C:/a/one.ts"), { sha256: "x", at: 2 }, { path: "" }, null, "nope"],
    })
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, "C:/a/one.ts");
});

test("merging is newest-wins per path, not append", () => {
  const { mergeDelegatedRecords } = require(DIST);
  const merged = mergeDelegatedRecords(
    [record("C:/a/one.ts", "old", 1)],
    [record("C:/a/one.ts", "new", 2), record("C:/a/two.ts", "x", 3)]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.path === "C:/a/one.ts").sha256, "new");
});

test("the record limit is enforced by dropping the oldest", () => {
  const { mergeDelegatedRecords } = require(DIST);
  const existing = [record("C:/a/old.ts", "x", 1), record("C:/a/mid.ts", "x", 2)];
  const merged = mergeDelegatedRecords(existing, [record("C:/a/new.ts", "x", 3)], 2);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((r) => r.path).sort(), ["C:/a/mid.ts", "C:/a/new.ts"]);
});

test("entries whose file no longer exists are pruned", () => {
  const { pruneDelegatedRecords } = require(DIST);
  const kept = pruneDelegatedRecords(
    [record("C:/a/gone.ts"), record("C:/a/here.ts")],
    (p) => p === "C:/a/here.ts"
  );
  assert.deepEqual(kept.map((r) => r.path), ["C:/a/here.ts"]);
});

test("a missing registry file loads as empty rather than failing", () => {
  const { loadDelegatedRegistry } = require(DIST);
  assert.deepEqual(loadDelegatedRegistry(), []);
});

test("a saved registry round-trips, path and hash together", () => {
  const { saveDelegatedRegistry, loadDelegatedRegistry } = require(DIST);
  const file = path.join(DATA_DIR, "round-trip.ts");
  fs.writeFileSync(file, "export const a = 1\n");
  const hash = require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  saveDelegatedRegistry([{ path: file, sha256: hash, at: Date.now() }]);

  const loaded = loadDelegatedRegistry();
  const found = loaded.find((r) => r.path === file);
  assert.ok(found, `expected ${file} in ${JSON.stringify(loaded)}`);
  assert.equal(found.sha256, hash);
});

test("protection survives a restart -- the whole point of the change", () => {
  // "Restart" here is a fresh load from disk with the in-memory list assumed empty, which is exactly
  // what the reload did in the live run that found this.
  const { rememberDelegated, loadDelegatedRegistry } = require(DIST);
  const file = path.join(DATA_DIR, "survives.ts");
  fs.writeFileSync(file, "export const b = 2\n");

  rememberDelegated([file]);

  const afterRestart = loadDelegatedRegistry();
  assert.ok(
    afterRestart.some((r) => r.path === file),
    `the registry must outlive the process: ${JSON.stringify(afterRestart)}`
  );
  assert.match(afterRestart.find((r) => r.path === file).sha256, /^[0-9a-f]{64}$/);
});

test("a file deleted after delegation is pruned on the next load", () => {
  const { rememberDelegated, loadDelegatedRegistry } = require(DIST);
  const file = path.join(DATA_DIR, "then-deleted.ts");
  fs.writeFileSync(file, "export const c = 3\n");
  rememberDelegated([file]);
  assert.ok(loadDelegatedRegistry().some((r) => r.path === file));

  fs.unlinkSync(file);
  assert.equal(
    loadDelegatedRegistry().some((r) => r.path === file),
    false,
    "a path whose file is gone should not be retained"
  );
});

test("the registry lands in the plugin data directory, not beside the plugin", () => {
  const { resolveDelegatedRegistryPath } = require(DIST);
  const resolved = resolveDelegatedRegistryPath();
  assert.equal(path.dirname(resolved), DATA_DIR);
  assert.match(path.basename(resolved), /\.json$/);
});
