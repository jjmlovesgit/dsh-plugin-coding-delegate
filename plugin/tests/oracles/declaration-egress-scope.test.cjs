// Oracle for SECURITY-REVIEW-2 finding 8/10: declarations mode leaks source by search and shell routes.
//
// RED ON DELIVERY. plugin/src/declaration-egress.ts does not exist yet, so the module load below fails
// and every case in this file reports as failing with MODULE MISSING. That is the intended red state:
// the cases flip green when the module is implemented, in a separate unit.
//
// Cases 1, 3, 6, 11 and 13 are CONTROLS, green once the module exists. They exist so that an
// implementation cannot pass by blocking everything. If the whole file is green while those controls
// have been removed, the file has stopped testing anything.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");

// Loaded defensively so the red state is legible as MODULE MISSING rather than as an unhandled throw.
let evaluateDeclarationEgress = null;
let declarationPathFor = null;
let commandReadsContent = null;
let loadError = null;
try {
  evaluateDeclarationEgress = require(PLUGIN + "/dist/declaration-egress.js").evaluateDeclarationEgress;
  declarationPathFor = require(PLUGIN + "/dist/guard.js").declarationPathFor;
  commandReadsContent = require(PLUGIN + "/dist/guard.js").commandReadsContent;
} catch (err) {
  loadError = err;
}

function decide(fields) {
  if (loadError) {
    assert.fail(
      "MODULE MISSING: plugin/src/declaration-egress.ts is not implemented or not built - " +
        loadError.message
    );
  }
  return evaluateDeclarationEgress(
    Object.assign(
      {
        sourceReadEgress: "declarations",
        declarationRoot: path.join(PLUGIN, "dist"),
        isCodeExtension: (p) => {
          const ext = path.extname(String(p)).toLowerCase();
          return [
            ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
            ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".scala", ".lua",
            ".dart", ".sh", ".ps1", ".sql",
          ].includes(ext);
        },
        declarationPathFor,
        commandReadsContent,
        commandNamesSource: (command) => /\.(ts|tsx|js|jsx|py|go|rs|sh|sql)\b/i.test(String(command)),
        // Stands in for the hook's real predicate, which stats each token against the workspace. Here the
        // tokens that name a directory in these cases are spelled out, and the shipped predicate is driven
        // end to end in declaration-egress-scope-resolution.test.cjs so this cannot drift into a fiction.
        commandReadsDirectoryScope: (command) =>
          /(^|\s)(\.|src|lib)(\s|$)/.test(String(command)) && commandReadsContent(command),
      },
      fields
    )
  );
}

// CONTROL: opting out must be a complete no-op, or this control changes behaviour for everyone.
test("case 1 (control): source mode allows a .ts read", () => {
  const r = decide({ toolKind: "read", target: "src/guard.ts", sourceReadEgress: "source" });
  assert.equal(r.action, "allow");
});

// CORE: a .ts read is redirected to its declaration.
test("case 2: declarations mode serves the declaration for a .ts read", () => {
  const r = decide({ toolKind: "read", target: "src/guard.ts" });
  assert.equal(r.action, "serve-declaration");
  assert.ok(String(r.skeleton).endsWith(".d.ts"), "the skeleton path must be a .d.ts: " + r.skeleton);
});

// CONTROL: a declaration is already a skeleton, so reading one is allowed.
test("case 3 (control): declarations mode allows a .d.ts read", () => {
  const r = decide({ toolKind: "read", target: "dist/guard.d.ts" });
  assert.equal(r.action, "allow");
});

// HOLE 2: .py is a code extension that declarationPathFor cannot map, and it was served raw.
test("case 4: declarations mode blocks a .py read", () => {
  const r = decide({ toolKind: "read", target: "scripts/deploy.py" });
  assert.equal(r.action, "block", "a .py body must not be served under declarations mode");
  assert.match(r.reason, /\.py|python|skeleton/i, "the reason must name what was refused: " + r.reason);
});

test("case 5: declarations mode blocks a .go read", () => {
  const r = decide({ toolKind: "read", target: "cmd/server.go" });
  assert.equal(r.action, "block");
});

// CONTROL: a non-code file has no implementation body to protect.
test("case 6 (control): declarations mode allows a .md read", () => {
  const r = decide({ toolKind: "read", target: "README.md" });
  assert.equal(r.action, "allow");
});

// HOLE 1: search returned raw matched lines and was never inspected.
test("case 7: declarations mode blocks a search scoped to a .ts file", () => {
  const r = decide({ toolKind: "search", target: "src/guard.ts" });
  assert.equal(r.action, "block", "matched lines are implementation bodies wherever they land");
});

test("case 8: declarations mode blocks a scope-free search", () => {
  const r = decide({ toolKind: "search", target: "" });
  assert.equal(r.action, "block", "an unstated scope cannot be shown to be harmless");
});

// CONTROL: a search that cannot reach code is allowed.
test("case 9 (control): declarations mode allows a search scoped to a .md file", () => {
  const r = decide({ toolKind: "search", target: "docs/README.md" });
  assert.equal(r.action, "allow");
});

// HOLE 1, shell door: the same leak by another route.
test("case 10: declarations mode blocks a shell command that reads a .ts file", () => {
  const r = decide({ toolKind: "shell", target: "Get-Content src/guard.ts" });
  assert.equal(r.action, "block", "the shell door must be gated like the tool door");
});

// CONTROL: a listing returns names, not bytes.
test("case 11 (control): declarations mode allows a listing command", () => {
  const r = decide({ toolKind: "shell", target: "Get-ChildItem src" });
  assert.equal(r.action, "allow", "a listing command returns names, not content");
});

// Fail closed when the filter cannot evaluate, the rule index.ts:1496 already states.
test("case 12: shell with no content helper blocks rather than allowing", () => {
  const r = decide({ toolKind: "shell", target: "Get-Content src/guard.ts", commandReadsContent: undefined });
  assert.equal(r.action, "block", "an egress filter that cannot evaluate must not wave the read through");
});

// CONTROL: a tool that neither reads, searches nor shells is not an egress route.
test("case 13 (control): an unrelated tool kind is allowed", () => {
  const r = decide({ toolKind: "other", target: "src/guard.ts" });
  assert.equal(r.action, "allow");
});

// Structure: a block without a reason is not actionable, so every block must carry one.
test("case 14: every block carries a non-empty reason", () => {
  const blocked = [
    decide({ toolKind: "read", target: "scripts/deploy.py" }),
    decide({ toolKind: "search", target: "src/guard.ts" }),
    decide({ toolKind: "search", target: "" }),
    decide({ toolKind: "shell", target: "Get-Content src/guard.ts" }),
    decide({ toolKind: "shell", target: "Get-Content src/guard.ts", commandReadsContent: undefined }),
    decide({ toolKind: "shell", target: "rg SECRET src" }),
  ];
  for (const r of blocked) {
    assert.equal(r.action, "block");
    assert.ok(typeof r.reason === "string" && r.reason.trim().length > 20, "reason too short: " + r.reason);
  }
});

// Finding 7 (SECURITY-REVIEW-4): a directory-scoped content read is an egress route even though it names
// no code FILE. MEASURED: commandReadsContent("rg SECRET src") is true and commandNamesSource("rg SECRET
// src") is false, so the `reads && names` rule never fired and the raw matches passed -- while the
// dedicated search route served the very same scope as declarations. The revision's discrimination is
// tested here; the hook's own predicate is tested end to end in the scope-resolution oracle.
test("case 15: a shell command that READS a directory is refused", () => {
  for (const command of ["rg SECRET src", "grep -rn foo src", "rg SECRET ."]) {
    const r = decide({ toolKind: "shell", target: command });
    assert.equal(r.action, "block", command + " reads file contents and must be refused");
    assert.match(String(r.reason), /searches a directory/);
  }
});

// CONTROL: naming a directory without reading its contents is not an egress route. Without this the rule
// would be a ban on shell tools rather than a rule about source, and the honest listing case would sit
// green in no test at all.
test("case 16 (control): listing a directory is still allowed", () => {
  const r = decide({ toolKind: "shell", target: "Get-ChildItem src" });
  assert.equal(r.action, "allow");
});

// CONTROL: the new branch must key on the READ, not on the directory. A command that cannot read contents
// is not an egress route whatever it names, which is why the branch is `reads && directory` rather than
// `reads && !names`.
test("case 17 (control): a command that reads no content stays allowed even when it names a directory", () => {
  const r = decide({ toolKind: "shell", target: "Set-Location src", commandReadsContent: () => false });
  assert.equal(r.action, "allow");
});

// SECURITY-REVIEW-5 [3]: the provenance refusal used to sit BELOW the directory branch, so a scope that
// resolved to an empty directory against the unverified cwd fallback returned the positive control's
// allow before anything asked whether the base described the session. MEASURED pre-fix: the same call as
// case 18 returned `allow` while the host searched the real workspace.
test("case 18: a scope resolved against an unverified base is refused, not cleared by an empty directory", () => {
  const r = decide({
    toolKind: "search",
    target: "src",
    workspaceRoot: path.join(os.tmpdir(), "dsh-not-this-session"),
    workspaceVerified: false,
    directoryScope: () => true,
    listSourceFiles: () => [],
  });
  assert.equal(r.action, "block", "an unverified base cannot clear a scope it guessed at");
  assert.match(String(r.reason), /could not be established/);
});

// CONTROL: the provenance question is about the BASE, not about the scope. With a verified base the
// positive control stands: a directory the resolver looked at and found no source beneath is allowed,
// which is what keeps the directory route from passing by refusing every directory.
test("case 19 (control): a verified base with genuinely no source beneath the scope is allowed", () => {
  const r = decide({
    toolKind: "search",
    target: "docs",
    workspaceRoot: path.join(os.tmpdir(), "dsh-verified-base"),
    workspaceVerified: true,
    directoryScope: () => true,
    listSourceFiles: () => [],
  });
  assert.equal(r.action, "allow");
});

// CONTROL: naming no workspace at all is not the same failure, and the old answer stands. This is the
// boundary the fix had to respect: only a base that was COMPUTED and found untrustworthy is refused.
test("case 20 (control): a caller that names no workspace keeps the previous answer", () => {
  const r = decide({ toolKind: "search", target: "src", directoryScope: () => true, listSourceFiles: () => [] });
  assert.equal(r.action, "allow");
});

// SECURITY-REVIEW-5 [2]: the hook tokenised shell commands on whitespace, so `rg SECRET "code space"`
// produced the tokens `"code` and `space"` -- no directory on disk matches either, the directory predicate
// answered false, and the command fell through to the raw allow. The evaluator cannot tokenise for itself
// (it holds no filesystem view), so the hook reports that it could not parse the quoting and this is the
// refusal. MEASURED pre-fix through the shipped hook: the original output was passed through.
test("case 21: a shell command whose quoting cannot be parsed is refused", () => {
  const r = decide({
    toolKind: "shell",
    target: 'rg SECRET "code space',
    commandScopeUnparseable: () => true,
  });
  assert.equal(r.action, "block");
  assert.match(String(r.reason), /quoting could not be parsed deterministically/);
});

// CONTROL: the unparseable branch keys on the parse, not on the tool. A command that tokenises cleanly and
// names no directory and no code file is still allowed, or the fix would be a ban on shell commands.
test("case 22 (control): a parseable command that reaches no source stays allowed", () => {
  const r = decide({
    toolKind: "shell",
    target: "rg SECRET docs/README.md",
    commandScopeUnparseable: () => false,
  });
  assert.equal(r.action, "allow");
});
