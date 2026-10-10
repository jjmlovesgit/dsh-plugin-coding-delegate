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
  ];
  for (const r of blocked) {
    assert.equal(r.action, "block");
    assert.ok(typeof r.reason === "string" && r.reason.trim().length > 20, "reason too short: " + r.reason);
  }
});
