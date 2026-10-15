// Oracle for the residual recorded in docs/findings.md: "A shell search never asked whether the
// workspace was established".
//
// The provenance refusal (SECURITY-REVIEW-4 [2], SECURITY-REVIEW-5 [3]) was asked on the read route and
// on the search route, and never on the shell route. Measured against the shipped hook with a base
// nowhere near the workspace, the same relative scope reached two ways: the search route refused
// `docs/findings.md` as unresolved, and `pwsh grep TODO docs/findings.md` served it. `rg TODO docs` was
// allowed on the guessed base and refused on a proven one, because the directory predicate answers
// against the same guess.
//
// Cases 1, 5, 6, 7, 8 and 12 are CONTROLS. A fix that refuses every shell command would pass the
// negative cases and fail those, which is the point of having them.
//
// Section B drives the real hook rather than the evaluator, so the forwarding of `workspaceVerified`
// from the host to the evaluator is exercised and not assumed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PLUGIN = path.resolve(__dirname, "..", "..");

// Loaded defensively so a missing build reads as MODULE MISSING rather than as an unhandled throw.
let evaluateDeclarationEgress = null;
let commandReadsContent = null;
let handleDeclarationPostExecute = null;
let loadError = null;
try {
  evaluateDeclarationEgress = require(PLUGIN + "/dist/declaration-egress.js").evaluateDeclarationEgress;
  commandReadsContent = require(PLUGIN + "/dist/guard.js").commandReadsContent;
  handleDeclarationPostExecute = require(PLUGIN + "/dist/declaration-egress-hook.js").handleDeclarationPostExecute;
} catch (err) {
  loadError = err;
}

const UNESTABLISHED = path.join(os.tmpdir(), "dsh-shell-provenance-not-this-session");

function decide(fields) {
  if (loadError) assert.fail("MODULE MISSING: " + loadError.message);
  return evaluateDeclarationEgress(
    Object.assign(
      {
        sourceReadEgress: "declarations",
        declarationRoot: path.join(PLUGIN, "dist"),
        isCodeExtension: (p) => /\.(ts|tsx|js|jsx|py|go|rs|sh|sql)$/i.test(String(p)),
        commandReadsContent,
        // Both shell predicates are required by the evaluator, and it refuses when either is missing --
        // so injecting only the reader would test that fail-closed branch instead of the rule below.
        commandNamesSource: (cmd) => /\.(ts|tsx|js|jsx|py|go|rs|sh|sql)\b/i.test(String(cmd)),
      },
      fields
    )
  );
}

// An unverified base: the shape `resolveWorkspaceDir` returns when the host exposes no session
// workspace, which on this host is the ordinary case rather than an exotic one.
const guessedBase = { workspaceRoot: UNESTABLISHED, workspaceVerified: false };
// The same command with the base actually established.
const provenBase = { workspaceRoot: PLUGIN, workspaceVerified: true };

test("precondition: the gate this fix keys on distinguishes a reader from a lister", () => {
  if (loadError) assert.fail("MODULE MISSING: " + loadError.message);
  assert.equal(commandReadsContent("rg TODO docs"), true, "a search is a content read");
  assert.equal(commandReadsContent("grep TODO docs/findings.md"), true, "grep reads content");
  assert.equal(commandReadsContent("Get-ChildItem docs"), false, "a listing reads no bytes");
});

test("an unverified base refuses a shell search of a directory (was allowed)", () => {
  const verdict = decide(Object.assign({ toolKind: "shell", target: "rg TODO docs" }, guessedBase));
  assert.equal(verdict.action, "block");
  assert.match(verdict.reason, /the session workspace could not be established/);
  assert.match(verdict.reason, /^Shell command '/, "the refusal names the act, not the search route");
});

test("an unverified base refuses a shell read of a prose path (was allowed)", () => {
  const verdict = decide(
    Object.assign({ toolKind: "shell", target: "grep TODO docs/findings.md" }, guessedBase)
  );
  assert.equal(verdict.action, "block");
  assert.match(verdict.reason, /the session workspace could not be established/);
});

test("control: the same prose read passes once the base is proven, so this is provenance and not a ban", () => {
  const verdict = decide(
    Object.assign({ toolKind: "shell", target: "grep TODO docs/findings.md" }, provenBase)
  );
  assert.equal(verdict.action, "allow");
});

test("control: on a proven base the directory rule refuses the same command for its own reason", () => {
  const verdict = decide(
    Object.assign(
      {
        toolKind: "shell",
        target: "rg TODO docs",
        commandReadsDirectoryScope: () => true,
      },
      provenBase
    )
  );
  assert.equal(verdict.action, "block");
  assert.match(verdict.reason, /searches a directory/);
  assert.doesNotMatch(verdict.reason, /could not be established/);
});

test("control: a command that only lists a directory keeps its allow on a guessed base", () => {
  const verdict = decide(Object.assign({ toolKind: "shell", target: "Get-ChildItem src" }, guessedBase));
  assert.equal(verdict.action, "allow", "a listing leaks no bytes, so the base is irrelevant to it");
});

test("control: a specific refusal is not hidden behind the base question", () => {
  const unparseable = decide(
    Object.assign(
      {
        toolKind: "shell",
        target: 'rg TODO docs "unclosed',
        commandScopeUnparseable: () => true,
      },
      guessedBase
    )
  );
  assert.equal(unparseable.action, "block");
  assert.match(unparseable.reason, /quoting could not be parsed/);
  assert.doesNotMatch(
    unparseable.reason,
    /could not be established/,
    "the base question is asked last because the quoting answer is true whatever the base is"
  );

  const namedSource = decide(
    Object.assign({ toolKind: "shell", target: "rg TODO plugin/src/guard.ts" }, guessedBase)
  );
  assert.equal(namedSource.action, "block");
  assert.match(namedSource.reason, /reads source content/);
});

test("control: a caller that names no workspace at all still gets the old answer", () => {
  const verdict = decide({ toolKind: "shell", target: "grep TODO docs/findings.md" });
  assert.equal(
    verdict.action,
    "allow",
    "the hook always names a workspace, so this branch is reachable only by a direct API caller; it is pinned rather than changed here"
  );
});

// ---------------------------------------------------------------------------------------------
// Section B: the same three cases through the shipped hook, which is what supplies
// `workspaceVerified`. A fix that stopped at the evaluator and never threaded the flag would pass
// section A and fail here.
// ---------------------------------------------------------------------------------------------

test("section B: the hook refuses the prose read on an unverified base and serves it on a proven one", () => {
  if (loadError) assert.fail("MODULE MISSING: " + loadError.message);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-shell-provenance-"));
  try {
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "notes.md"), "TODO: prose, not source\n", "utf8");

    const call = { name: "pwsh", arguments: { command: "grep TODO docs/notes.md" } };
    const base = { sourceReadEgress: "declarations", declarationRoot: path.join(PLUGIN, "dist") };

    const guessed = handleDeclarationPostExecute(
      call,
      Object.assign({}, base, { workspaceRoot: UNESTABLISHED, workspaceVerified: false })
    );
    assert.ok(guessed, "an unverified base must produce a verdict, not null");
    assert.equal(guessed.kind, "accept");
    assert.match(guessed.content[0].text, /the session workspace could not be established/);

    const proven = handleDeclarationPostExecute(
      call,
      Object.assign({}, base, { workspaceRoot: workspace, workspaceVerified: true })
    );
    assert.equal(proven, null, "with the base established there is nothing to refuse: " + JSON.stringify(proven));

    const directory = handleDeclarationPostExecute(
      { name: "pwsh", arguments: { command: "rg TODO docs" } },
      Object.assign({}, base, { workspaceRoot: workspace, workspaceVerified: true })
    );
    assert.ok(directory, "a directory search is refused on either base");
    assert.match(directory.content[0].text, /searches a directory/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
