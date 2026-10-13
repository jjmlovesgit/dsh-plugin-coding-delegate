// Oracle for SECURITY-REVIEW-3 finding 5 (CWE-200): a DIRECTORY search scope bypassed declarations mode.
//
// THE DEFECT. The search branch decided from the scope's extension. A directory has none, so
// `isCodeExtension('src')` was false and the branch returned `{action:'allow'}`. MEASURED against the
// built artefact before this oracle existed:
//
//     evaluateDeclarationEgress({toolKind:'search', target:'src', ...}) => {"action":"allow"}
//     evaluateDeclarationEgress({toolKind:'search', target:'src/guard.ts', ...})
//         => {"action":"block","reason":"Searching 'src/guard.ts' was refused: ..."}
//
// The same tree, the same filter, opposite answers -- because the filter asked about the STRING the
// caller typed instead of the tree it named. `plugin/src/guard.ts` alone holds 167 lines matching an
// implementation-body test, and every one of them was reachable by scoping the search one level up.
//
// WHAT THIS FILE ASSERTS. Not "the search is refused", which is the old contract and only moves the leak
// to whichever spelling nobody tested. A directory scope must be RESOLVED to its source files, and what
// comes back must be the DECLARATION SURFACE of those files -- no `=`, no `return`, no bodies. Case 2
// runs that boundary check over every returned line.
//
// Cases 3, 5 and 8 are CONTROLS: a filter that refused every directory would pass every other case in
// this file while closing nothing. If the whole file is green with those removed, it stopped testing.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const PLUGIN = path.resolve(__dirname, "..", "..");

// Loaded defensively so a missing build is legible as MODULE MISSING rather than an unhandled throw.
let evaluateDeclarationEgress = null;
let declarationPathFor = null;
let staleDeclarationReason = null;
let loadError = null;
try {
  evaluateDeclarationEgress = require(PLUGIN + "/dist/declaration-egress.js").evaluateDeclarationEgress;
  declarationPathFor = require(PLUGIN + "/dist/guard.js").declarationPathFor;
  staleDeclarationReason = require(PLUGIN + "/dist/guard.js").staleDeclarationReason;
} catch (err) {
  loadError = err;
}

const DECLARATION_ROOT = path.join(PLUGIN, "dist");

/**
 * A line that only implementation can produce, in a type skeleton.
 *
 * Deliberately narrow, and narrower than the first version of this oracle, which flagged `export type
 * X = {` and the closing `}` of every multiline type body. MEASURED: run over the real 25 committed
 * skeletons it reported 100+ lines, and every one of them was declaration -- a boundary test that fails
 * on the artifact it is meant to be protecting measures nothing but its own regex.
 *
 * What a skeleton cannot contain is a VALUE: `x = 5`, a `return`, control flow, a function body, or a
 * side-effecting call. Type aliases and interface bodies (`= {`, `=> boolean`, a lone `}`) are exempt by
 * shape, because that is what a declaration of a shape looks like.
 *
 * `export declare const NAME: T` and `export declare const NAME = 32768` are the SURFACE -- the first
 * version of this list rejected them and flagged 40-odd lines of every real skeleton. Only an
 * un-`declare`d initialiser, or a `declare const` initialised with an object or array literal, is a value.
 *
 * The body patterns are ANCHORED AND NAMED for the same measured reason: a bare `=> {` also matches the
 * line `    apply: (content: string, blocks: SearchReplaceBlock[]) => {`, which is a nested method
 * signature inside an emitted `export declare function` parameter type -- declaration through and
 * through. Requiring an identifier and a parameter list before the arrow keeps the body shape and drops
 * the signature shape.
 */
const IMPLEMENTATION_LINE = [
  /^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*[:=]/,
  /^\s*return\b/,
  /^\s*(if|for|while|switch|try|throw|break|continue|await)\b/,
  /^\s*[A-Za-z_$][\w$.]*\s*\([^)]*\)\s*=>\s*\{\s*$/,
  /^\s*(export\s+)?(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/,
  /^\s*[A-Za-z_$][\w$]*\s*=[^=]/,
  /^\s*(export\s+)?declare\s+(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[\[{]/,
];

// The evaluator and the hook both prefix served bytes with a banner and a provenance line, and a skeleton
// carries JSDoc through from the source. Comments are prose ABOUT the declaration, not implementation, so
// comment lines are dropped before the boundary test rather than being allowed to fail it -- dropping the
// comment TEXT instead of the lines it occupies splices a fragment like `=> {` out of a JSDoc paragraph
// onto a line of its own, and MEASURED, that turned one real sentence into a reported implementation leak.
function declaredLines(text) {
  const out = [];
  let inBlockComment = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.trimStart().startsWith("//")) continue;
    if (line.trimStart().startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

function implementationLinesIn(text) {
  return declaredLines(text).filter((line) => IMPLEMENTATION_LINE.some((re) => re.test(line)));
}

/**
 * A resolver over the REAL tree, with the same contract the plugin's hook supplies: `directoryScope`
 * asks the disk, `listSourceFiles` walks it and returns every source file beneath, `readDeclaration`
 * maps each one to the committed `.d.ts` and returns its bytes.
 *
 * Real files on purpose. The claim under test is that a directory scope is answered from the tree, and a
 * hand-written file list would be a claim about this file's fixtures instead.
 */
function diskResolver(overrides = {}) {
  const resolve = (p) => path.resolve(PLUGIN, String(p));
  const config = {
    directoryScope: (p) => {
      try {
        return fs.statSync(resolve(p)).isDirectory();
      } catch {
        return false;
      }
    },
    listSourceFiles: (scope) => {
      const found = [];
      const walk = (p) => {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
            walk(path.join(p, entry.name));
          }
          return;
        }
        if (stat.isFile() && /\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p)) found.push(p);
      };
      walk(resolve(scope));
      return found;
    },
    readDeclaration: (sourceFile, root) => {
      const skeleton = declarationPathFor(sourceFile, root);
      if (!skeleton) return { exists: false };
      try {
        return { exists: true, text: fs.readFileSync(skeleton, "utf8") };
      } catch {
        return { exists: false };
      }
    },
  };
  return Object.assign(config, overrides);
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
        declarationRoot: DECLARATION_ROOT,
        isCodeExtension: (p) => {
          const ext = path.extname(String(p)).toLowerCase();
          return [
            ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
            ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".scala", ".lua",
            ".dart", ".sh", ".ps1", ".sql",
          ].includes(ext);
        },
        declarationPathFor,
      },
      fields
    )
  );
}

/** A directory of implementation files and nothing else, used where the disk walk is not the subject. */
const FIXTURE_DIR = "/tmp/impl-only";
const FIXTURE_FILES = [FIXTURE_DIR + "/one.ts", FIXTURE_DIR + "/two.ts"];

function fixtureResolver(overrides = {}) {
  return {
    directoryScope: (p) => String(p) === FIXTURE_DIR,
    listSourceFiles: (p) => (String(p) === FIXTURE_DIR ? FIXTURE_FILES.slice() : []),
    readDeclaration: (sourceFile, root) => {
      const skeleton = declarationPathFor(sourceFile, root);
      return { exists: true, text: "export declare function " + path.basename(sourceFile) + ": number;\n" };
    },
    ...overrides,
  };
}

// THE DEFECT. A directory scope is not a licence to bypass the filter, and the answer is the declaration
// surface of the files beneath it -- not raw matched lines.
test("case 1: a search scoped to a directory of implementation is served as declarations", () => {
  const r = decide(
    Object.assign({ toolKind: "search", target: FIXTURE_DIR }, fixtureResolver())
  );
  assert.equal(
    r.action,
    "serve-declaration",
    "a directory scope must be resolved, not allowed through: " + JSON.stringify(r)
  );
  assert.ok(
    typeof r.skeleton === "string" && r.skeleton.length > 0,
    "the verdict must name the declaration(s) served: " + JSON.stringify(r)
  );
});

// THE BOUNDARY. Every line of what is returned must be declaration, whichever route produced it.
test("case 2: every line served under a directory scope passes the declaration boundary", () => {
  const r = decide(
    Object.assign({ toolKind: "search", target: FIXTURE_DIR }, fixtureResolver())
  );
  const served = String(r.declarationText || "");
  assert.ok(served.trim().length > 0, "declaration bytes must be served, not just a path: " + JSON.stringify(r));
  const leaks = implementationLinesIn(served);
  assert.deepEqual(leaks, [], "implementation lines reached the caller: " + leaks.join(" | "));
  assert.match(served, /export declare function/, "the served bytes must be the skeleton: " + served);
});

// CONTROL: a directory with no source beneath it cannot return an implementation line, so refusing it
// would be the "block everything" pass this file exists to prevent.
test("case 3 (control): a directory holding no source is allowed", () => {
  const r = decide(
    Object.assign({ toolKind: "search", target: "/tmp/docs-only" }, fixtureResolver({
      directoryScope: (p) => String(p) === "/tmp/docs-only",
      listSourceFiles: () => [],
    }))
  );
  assert.equal(r.action, "allow", "an empty-of-source directory must not be refused: " + JSON.stringify(r));
});

// The reported defect in its exact form: the guard could not see the tree, so a directory looked
// harmless. It must not fall back to the extension test, which answers "not code" for every directory.
test("case 4: a directory scope with no resolver fails closed rather than falling back to the extension test", () => {
  const r = decide({ toolKind: "search", target: FIXTURE_DIR, ...fixtureResolver({ listSourceFiles: undefined }) });
  assert.equal(r.action, "block", "an unresolvable directory cannot be cleared: " + JSON.stringify(r));
  assert.match(r.reason, /director|resolv/i, "the reason must name what could not be resolved: " + r.reason);
});

// CONTROL: the pre-existing behaviour for a code FILE scope is pinned by the committed oracle
// (declaration-egress-scope.test.cjs case 7). Widening the directory route must not quietly widen it.
test("case 5 (control): a source FILE scope is still refused, unchanged", () => {
  const r = decide({ toolKind: "search", target: "src/guard.ts" });
  assert.equal(r.action, "block", "the file-scope rule is the other oracle's contract");
});

// CONTROL: a search that cannot reach code is allowed. This is the case the old branch was written for,
// and it must survive being rewritten around a scope resolver.
test("case 6 (control): a search scoped to prose is allowed", () => {
  const r = decide({ toolKind: "search", target: "docs/README.md" });
  assert.equal(r.action, "allow", "a scope that cannot reach source must not be refused");
});

// A file beneath the directory with no servable skeleton is refused rather than silently omitted. Serving
// the rest would answer a question about a tree while hiding part of it.
test("case 7: a directory holding a source file with no declaration is refused", () => {
  const r = decide(
    Object.assign({ toolKind: "search", target: "/tmp/mixed" }, fixtureResolver({
      directoryScope: (p) => String(p) === "/tmp/mixed",
      listSourceFiles: () => ["/tmp/mixed/ok.ts", "/tmp/mixed/nope.ts"],
      readDeclaration: (sourceFile) =>
        String(sourceFile).endsWith("ok.ts")
          ? { exists: true, text: "export declare const ok: number;\n" }
          : { exists: false },
    }))
  );
  assert.equal(r.action, "block", "an incomplete answer about the tree must be refused: " + JSON.stringify(r));
  assert.match(r.reason, /nope\.ts/, "the reason must name the file that could not be served: " + r.reason);
});

// CONTROL, and the end-to-end proof: the REAL plugin/src, walked from disk, resolved to the committed
// declarations. This is the call the defect was about -- `search` scoped to `src` -- and the answer must
// be the 25 skeletons, with no implementation line in any of them.
test("case 8 (control): the real plugin source tree resolves to declarations only", () => {
  const r = decide(Object.assign({ toolKind: "search", target: "src" }, diskResolver()));
  assert.equal(r.action, "serve-declaration", "plugin/src must resolve: " + JSON.stringify(r));
  const served = String(r.declarationText || "");
  const leaks = implementationLinesIn(served);
  assert.deepEqual(leaks.slice(0, 5), [], "implementation lines reached the caller: " + leaks.join(" | "));
  const servedFiles = String(r.skeleton || "").split(",").length;
  const onDisk = diskResolver().listSourceFiles("src").length;
  assert.ok(onDisk > 1, "the fixture tree must hold more than one file, or this case proves nothing");
  assert.equal(servedFiles, onDisk, "every source file beneath the scope must be resolved");
  assert.match(served, /export declare function evaluateDeclarationEgress/, "the real skeleton must be served");
});

// A STALE declaration is refused here for the same reason index.ts refuses it for a read.
test("case 9: a directory holding a stale declaration is refused", () => {
  const r = decide(
    Object.assign({ toolKind: "search", target: "/tmp/stale" }, fixtureResolver({
      directoryScope: (p) => String(p) === "/tmp/stale",
      listSourceFiles: () => ["/tmp/stale/one.ts"],
      readDeclaration: () => ({
        exists: true,
        text: "export declare const one: number;\n",
        staleReason: "its type skeleton is OLDER than the source",
      }),
    }))
  );
  assert.equal(r.action, "block", "a stale skeleton must not be served: " + JSON.stringify(r));
  assert.match(r.reason, /OLDER/, "the reason must carry the staleness verdict: " + r.reason);
});

// Structure: the block reasons the directory route produces must be actionable.
test("case 10: a block produced by the directory route carries a reason", () => {
  const blocked = [
    decide({ toolKind: "search", target: FIXTURE_DIR, ...fixtureResolver({ listSourceFiles: undefined }) }),
    decide(
      Object.assign({ toolKind: "search", target: "/tmp/mixed" }, fixtureResolver({
        directoryScope: (p) => String(p) === "/tmp/mixed",
        listSourceFiles: () => ["/tmp/mixed/nope.ts"],
        readDeclaration: () => ({ exists: false }),
      }))
    ),
  ];
  for (const r of blocked) {
    assert.equal(r.action, "block");
    assert.ok(typeof r.reason === "string" && r.reason.trim().length > 20, "reason too short: " + r.reason);
  }
});
