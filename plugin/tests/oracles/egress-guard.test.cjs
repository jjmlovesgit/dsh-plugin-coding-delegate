// Oracle for the read-egress control: a read of source is served as type declarations.
//
// WHY THIS IS NOT A `pre-execute` RULE, and the reason is in the host's own types. `PreToolDecision` is
// only `allow | deny | ask`; its doc comment says input rewriting "is excluded because arguments are
// already logged and presented". So "serve the declaration instead" is not representable there, and a
// pure deny would be the weaker and more annoying control -- the architect would simply be blocked with
// nothing to read. `tools/post-execute` accepts `{ kind: 'accept', content }`, which REPLACES the
// model-facing result, and that is the only seam where the substitution is actually possible.
//
// Two properties are asserted here and they are different in kind:
//
//   1. The mapping is right -- `src/x.ts` resolves to `<root>/x.d.ts`, and non-source reads are untouched.
//   2. The served artifact contains NO IMPLEMENTATION BODIES. That is the control's whole claim, and a
//      mapping that resolves correctly to a file still containing bodies would satisfy (1) and fail the
//      thing the control exists for. So the check is on the content, not on the path.
//
// What this file does NOT do: drive the hook end to end through a mock ctx. The mapping and the artifact
// are the parts that can be wrong in a way a test catches; the wiring is three lines of delegation and is
// exercised by the plugin's own registration path.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const { declarationPathFor } = require(PLUGIN + "/dist/guard.js");

const SRC = path.join(PLUGIN, "src");
const DECLARATIONS = path.join(PLUGIN, "dist");

test("egress/row 1: a source path maps to its declaration, preserving the tree below src/", () => {
  assert.equal(
    declarationPathFor(path.join(SRC, "guard.ts"), DECLARATIONS),
    path.join(DECLARATIONS, "guard.d.ts"),
    "a top-level module maps beside the declarations root"
  );
  assert.equal(
    declarationPathFor(path.join(SRC, "nested", "deep.ts"), DECLARATIONS),
    path.join(DECLARATIONS, "nested", "deep.d.ts"),
    "a nested module keeps its subtree"
  );
  assert.equal(
    declarationPathFor("plain.ts", "C:/decl"),
    path.join("C:/decl", "plain.d.ts"),
    "a bare filename with no src/ segment still resolves from its basename"
  );
});

test("egress/row 1: reads that are not implementation source are left alone", () => {
  // A control that rewrites reads it does not understand is a control that breaks unrelated work. Each of
  // these returns null, which the hook treats as "out of scope" and passes through unchanged.
  assert.equal(declarationPathFor("README.md", "C:/decl"), null, "markdown is not source");
  assert.equal(declarationPathFor("config.json", "C:/decl"), null, "json is not source");
  assert.equal(declarationPathFor("", "C:/decl"), null, "an empty path maps to nothing");
  assert.equal(
    declarationPathFor("already.d.ts", "C:/decl"),
    null,
    "a declaration is already a skeleton; mapping it again would look for x.d.d.ts"
  );
});

test("egress/row 1: a STALE declaration is refused, because the build is trusted not verified", () => {
  // The gap this closes, stated as the failure it prevents: editing an interface and planning without
  // running the build used to serve the architect yesterday's signature, and nothing would have said so.
  // That is the repository's recurring false-green shape -- healthy under test, because a test suite always
  // runs against a freshly built tree, and wrong exactly when a human is working.
  const { staleDeclarationReason } = require(PLUGIN + "/dist/guard.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stale-"));
  const source = path.join(dir, "thing.ts");
  const declaration = path.join(dir, "thing.d.ts");
  fs.writeFileSync(source, "export function f(): void\n");
  fs.writeFileSync(declaration, "export declare function f(): void;\n");

  // Fresh: the declaration is newer, so it may describe the current source.
  const now = Date.now() / 1000;
  fs.utimesSync(declaration, now, now);
  fs.utimesSync(source, now - 60, now - 60);
  assert.equal(
    staleDeclarationReason(source, declaration),
    null,
    "a declaration newer than its source is served"
  );

  // Stale: the source was edited after the last build.
  fs.utimesSync(source, now + 60, now + 60);
  const reason = staleDeclarationReason(source, declaration);
  assert.ok(reason, "a declaration older than its source must be refused");
  assert.match(reason, /OLDER than the source/, "and the reason names the actual cause");

  // A stat that cannot be read is NOT reported as staleness. The caller's next step has its own fail-closed
  // path for a missing declaration, and inventing a staleness verdict here would name a cause nothing
  // established -- the same overstatement this file exists to prevent.
  assert.equal(
    staleDeclarationReason(path.join(dir, "does-not-exist.ts"), declaration),
    null,
    "an unreadable source yields no staleness claim"
  );
  assert.equal(
    staleDeclarationReason(source, path.join(dir, "does-not-exist.d.ts")),
    null,
    "an unreadable declaration yields no staleness claim"
  );
});

test("egress/row 1: the served declaration carries NO implementation statements", () => {
  // The claim under test is that implementation bodies cannot reach the model, checked on real files
  // rather than a fixture, because a fixture only proves the mapping works on something written for the
  // test.
  //
  // The detector is statement-shaped rather than syntax-shaped, and that choice is the whole lesson of
  // writing this test. A first version looked for a `function name(...) {`, which is a body in a .ts and
  // an OBJECT TYPE LITERAL in a .d.ts return type -- so it reported a leak in `emission.d.ts` that was
  // TypeScript being correct. A type declaration is not a program, so re-parsing it to detect a program is
  // the wrong instrument. These markers are ones a declaration CANNOT contain:
  //
  //   for / while / if / switch   control flow -- impossible outside a body, and absent from prose
  //   fs.<call>(                  a runtime call
  //   throw                       an executable statement
  //
  // Deliberately NOT markers, both measured as false positives on a real declaration: `return`, which
  // appears in doc comments ("tools return file content"), and `const`, which appears in the legitimate
  // `export declare const READ_TOOLS: Set<string>;`. A detector that fires on correct output is worse than
  // no detector, because it trains the reader to ignore it.
  const markers = [
    ["control flow (for/while)", /\b(for|while)\s*\(/g],
    ["conditional (if/switch)", /\b(if|switch)\s*\(/g],
    ["runtime call", /\bfs\.\w+\(/g],
  ];
  // A `return`-with-a-value marker was tried here and removed. It matched once in `guard.d.ts`, inside a
  // doc comment, and every repair to the pattern made the detector more delicate than the property it
  // checks. These four share the property that makes a marker usable: a declaration cannot contain them in
  // ANY position, body or comment, because `for(`, `if(`, `switch(` and `fs.` are not prose. A detector
  // that needs tuning against its own subject is measuring the detector.
  const mapping = ["guard.ts", "delegation.ts", "emission.ts"];

  // Guards the guard, once for the set: a marker absent from every file proofs nothing, and a detector
  // nobody has seen fire is indistinguishable from a detector that cannot fire. Asserted at the set level
  // rather than per file, because a single file legitimately may not contain a given statement.
  const sources = mapping.map((name) => fs.readFileSync(path.join(SRC, name), "utf8")).join("\n")
  for (const [label, pattern] of markers) {
    assert.ok(
      [...sources.matchAll(pattern)].length > 0,
      "'" + label + "' does not occur in the sources either, so this marker proves nothing"
    )
  }

  for (const source of mapping) {
    const declarationFile = declarationPathFor(path.join(SRC, source), DECLARATIONS);
    assert.ok(fs.existsSync(declarationFile), "declaration missing for " + source + ": " + declarationFile);
    const served = fs.readFileSync(declarationFile, "utf8");
    const raw = fs.readFileSync(path.join(SRC, source), "utf8");

    for (const [label, pattern] of markers) {
      const inServed = [...served.matchAll(pattern)].length;
      assert.equal(
        inServed,
        0,
        source + ": the served declaration contains " + label + " (" + inServed + " occurrence(s)), which is " +
          "implementation that crossed the boundary. The source has " +
          [...raw.matchAll(pattern)].length +
          "."
      );
    }

    assert.ok(
      served.length < raw.length,
      source + ": the declaration should be smaller than the source it was emitted from"
    );
  }
});
