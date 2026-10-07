// Contract oracle for unit C: contract-path integrity.
//
// Written before the implementation, and it fails until the unit exists. The property under test is
// the one the whole loop rests on: a passing verdict has to mean *the architect's tests, unmodified,
// passed*. A worker that can rewrite the test that scores it is marking its own homework, and a
// contract the executor can edit is not a contract.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-contract-"));

test("the tool declares contractFiles, so the architect can name the contract's tests", () => {
  const { DELEGATE_WORKER_OPENAI_SCHEMA } = require(DIST);
  const props = DELEGATE_WORKER_OPENAI_SCHEMA.function.parameters.properties;
  assert.ok(props.contractFiles, "contractFiles must be a declared tool argument");
  assert.equal(props.contractFiles.type, "array");
});

test("contract paths resolve against the workspace, not the process cwd", () => {
  const { resolveContractFiles } = require(DIST);
  const dir = tmp();
  const resolved = resolveContractFiles(["tests/a.test.js"], dir);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0], path.resolve(dir, "tests/a.test.js"));
});

test("an unchanged contract file is not a violation", () => {
  const { contractFileHashes, contractViolations } = require(DIST);
  const dir = tmp();
  const file = path.join(dir, "contract.test.js");
  fs.writeFileSync(file, "// the contract\n");
  assert.deepEqual(contractViolations(contractFileHashes([file]), contractFileHashes([file])), []);
});

test("a modified contract file voids the verdict", () => {
  const { contractFileHashes, contractViolations } = require(DIST);
  const dir = tmp();
  const file = path.join(dir, "contract.test.js");
  fs.writeFileSync(file, "// the contract\n");
  const before = contractFileHashes([file]);
  fs.writeFileSync(file, "// weakened so that it passes\n");
  const violations = contractViolations(before, contractFileHashes([file]));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /modified/);
});

test("a deleted contract file voids the verdict", () => {
  const { contractFileHashes, contractViolations } = require(DIST);
  const dir = tmp();
  const file = path.join(dir, "contract.test.js");
  fs.writeFileSync(file, "// the contract\n");
  const before = contractFileHashes([file]);
  fs.unlinkSync(file);
  const violations = contractViolations(before, contractFileHashes([file]));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /deleted/);
});

test("a declared contract file that does not exist fails closed", () => {
  const { contractFileHashes, contractViolations } = require(DIST);
  const missing = path.join(tmp(), "never-written.test.js");
  const violations = contractViolations(contractFileHashes([missing]), contractFileHashes([missing]));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not exist/);
});

test("the worker cannot emit a file the contract owns", () => {
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  const contract = path.join(dir, "contract.test.js");
  const original = "// the contract\nassert.equal(1, 1)\n";
  fs.writeFileSync(contract, original);

  const content = '```js file="contract.test.js"\nassert.ok(true)\n```\n';
  const result = extractAndEmitFiles(content, ["contract.test.js"], dir, [], [contract]);

  assert.equal(result.filesWritten.length, 0, "the contract file must not be written");
  assert.ok(
    result.errors.some((e) => /contract file declared by the architect/i.test(e)),
    `expected a contract refusal, got: ${JSON.stringify(result.errors)}`
  );
  assert.equal(fs.readFileSync(contract, "utf8"), original, "the contract file must be untouched");
});

test("a file the contract does not own is still writable, so the refusal is targeted", () => {
  const { extractAndEmitFiles } = require(DIST);
  const dir = tmp();
  const contract = path.join(dir, "contract.test.js");
  fs.writeFileSync(contract, "// the contract\n");
  const content = '```js file="implementation.js"\nmodule.exports = 1\n```\n';
  const result = extractAndEmitFiles(content, ["implementation.js"], dir, [], [contract]);
  assert.equal(result.filesWritten.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "implementation.js"), "utf8"), "module.exports = 1\n");
});

test("status precedence: a modified contract outranks a passing verification", () => {
  const { resolveDelegateStatus } = require(DIST);
  const base = { verificationGate: null, unverified: false, isSuccess: true };

  assert.equal(
    resolveDelegateStatus({ ...base, contractViolations: ["x was modified"] }),
    "CONTRACT_MODIFIED"
  );
  assert.equal(resolveDelegateStatus({ ...base, contractViolations: [] }), "SUCCESS");
  assert.equal(
    resolveDelegateStatus({ ...base, contractViolations: [], verificationGate: "denied" }),
    "VERIFICATION_NOT_APPROVED"
  );
  assert.equal(
    resolveDelegateStatus({ ...base, contractViolations: [], unverified: true, isSuccess: false }),
    "UNVERIFIED"
  );
  assert.equal(
    resolveDelegateStatus({ ...base, contractViolations: [], isSuccess: false }),
    "VERIFICATION_FAILED"
  );

  // Tampering outranks even a refused approval: the contract is void either way, and that is the news.
  assert.equal(
    resolveDelegateStatus({
      ...base,
      contractViolations: ["x was modified"],
      verificationGate: "denied",
      isSuccess: false,
    }),
    "CONTRACT_MODIFIED"
  );
});
