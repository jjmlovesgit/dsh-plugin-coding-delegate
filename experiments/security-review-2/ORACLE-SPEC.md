# Unit spec: `plugin/tests/oracles/security-review-2-regressions.test.cjs`

Oracle for the standalone defects in [`SECURITY-REVIEW-2.md`](../../SECURITY-REVIEW-2.md). The purpose is
the one that document names as its own largest gap: **remaining findings with no test**. A finding whose
test cannot fail is not covered, so each case below states its red/green status against the current tree.

## Deliverable

One file: `plugin/tests/oracles/security-review-2-regressions.test.cjs`.

It is the `contractFiles` entry for the unit that writes it, so **the worker may not modify it after
hashes are taken**, and it must not be written by any other route.

## Hard constraints

- **Write no backtick character anywhere in the file.** This is not style. The plugin's emission scanner
  truncates a fenced body at the first backtick run, so a file containing one is refused with *"worker
  output has no fenced code block and does not look like source code"* — a first attempt at this unit
  failed exactly that way. Use ordinary single or double quoted strings, string concatenation instead of
  template literals, and `String.fromCharCode(96)` if a backtick is genuinely needed inside a test value.
- **No existing file may be modified.** Not `plugin/src/**`, not another oracle, not a config. This unit
  adds one test file and nothing else. Where a case cannot be made red without a source change, it is
  marked `GREEN — PIN` below and must be written so that it is green now and would fail if the behaviour
  it pins changed.
- **Exercise the plugin's own exports.** Import from `dist/`, never reimplement a decision in the test.
  A test that duplicates the logic it checks passes for the wrong reason.
- Conventions match `plugin/tests/oracles/context-injection.test.cjs`: `node:test`,
  `node:assert/strict`, `const PLUGIN = path.resolve(__dirname, "..", "..")`, then require
  `PLUGIN + "/dist/<module>.js"`.
- **Set `DSH_LOCAL_ROUTER_DATA_DIR` to `fs.mkdtempSync(...)` BEFORE the first require of
  `dist/logging.js`.** `logging.ts` computes `LOG_FILE` once at module load (`logging.ts:20`), so a test
  that sets the variable late writes to the operator's real log. This is not optional.

## Case A — context budget is enforced before the read (finding 7/12)

**Status: RED against the current tree.** `dist/context.js:73` calls `fs.readFileSync` and `:78` splits
the result, both before the budget comparison at `:104`.

- Build a temp workspace. Write `small.ts` (a few hundred bytes) and `big.ts` (~100 KB — comfortably over
  the default `DEFAULT_CONTEXT_MAX_BYTES` of 32768, which `dist/context.js` exports).
- Patch `fs.readFileSync` on the `fs` module object to record every path it is called with, then restore
  it in a `finally`. **This is the load-bearing technique and it is measured, not assumed**: a patched
  reader observed 4 calls through the module boundary in a probe run, because `context.js` holds
  `const fs = __importStar(require("fs"))` and reads `fs.readFileSync` as a property at each call site.
  Patch the property, not a captured binding.
- Call the plugin's real `resolveContextFiles` with both files declared, no line ranges, and the default
  budget.
- Assert **two** things: the error text reports the budget (so the refusal is the one under test, not a
  containment error), and **`big.ts` never appears in the observed read calls**.

The second assertion is the whole test. It fails today because the file is read before being refused, and
it passes once a `statSync` size guard runs before the read. A test that merely asserts "the oversized
file is refused" would be **green today and would assert nothing about ordering** — do not write that.

Note the asymmetry in the current code that this case deliberately exercises: when a line range *is*
declared, only the range counts toward the budget (`context.ts:100`), so an oversized file can be
legitimately injected by range. This case declares no range, so the whole file is over budget and there
is no reason to read it at all.

## Case B — a DLP-tripped prompt is not persisted verbatim (finding 19)

**Status: RED against the current tree.** `trace` (`logging.ts:22-31`) writes `JSON.stringify(data)`
unredacted, and `index.ts:1679` (reroute path) and `index.ts:664` (`ROUTER_DECISION`, every routed turn)
both pass `prompt.slice(0, 100)`.

The two leaking call sites are unreachable from a test: `ROUTER_DECISION` is inside the `LocalRouter`
class and `DLP_FIREWALL_TRIPPED` is inside the host handler. So this case tests the **shared sink**,
which is where the defect must be fixed anyway.

- Create the temp data dir and set the env var first, then require `dist/logging.js`.
- Call the plugin's real `trace` with a payload shaped like the leaking call site and carrying a synthetic
  token: the exact string `SYNTHETICSECRET0123456789ABCDEF`, as the value of the payload's `prompt` field.
- Read the log file and assert that string does **not** appear in it.

Use that exact literal, and assert on the literal substring. It contains no secret-shaped prefix, so the
plugin's own DLP gate does not refuse the delegation that writes this file. The case is
red now and goes green when `trace` redacts its payload (or when both call sites stop passing raw prompt
text). Which of those two shapes is the fix is a source decision outside this unit — write the test
against the sink, and it will hold for either.

A second, cheaper assertion is worth having if it does not crowd the first: that the log entry still
carries the **event name**, so redaction is not allowed to succeed by writing nothing.

## Case C — verification allowlist matches a program, not a command (finding 16/17)

**Status: GREEN — PIN. Do not make this red.** This behaviour is deliberate and accepted; see
`plugin/README.md` and the delegation A/B record, which states the hole is the operator's to accept.

- Assert `commandProgram` on a two-part command whose program is `node` and whose arguments are an
  inline script returns `"node"` — i.e. the argument list is not part of the comparison. Build that
  command string with `String.fromCharCode(96)` for any quote character rather than writing the quote
  literally (see the no-backtick constraint below).
- Assert `evaluateVerificationPolicy("node tests/x.test.cjs", { mode: "ask", allowlist: ["node"] })`
  resolves `allow`, and that the inline-exec invocation above does too, **because the allowlist matches
  the program**. Assert the `program` field is `"node"` in both.

Write the comment so the pin is legible: this asserts that allowlisting an interpreter is equivalent to
allowing arbitrary code with `shell: true` (`verification.ts:507`), which is the accepted trade. The test
exists so that closing the hole is a deliberate act with a failing test to change, rather than a silent
behaviour drift.

**Do not** assert that the inline-exec invocation is rejected — it is not, and that assertion would be
wrong today and would force a policy change this unit is not authorised to make.

## Case D — eviction does not silently drop read protection (finding 18)

**Status: RED against the current tree.** `mergeDelegatedRecords` (`contracts.ts:307-322`) sorts by
`at` descending and slices to the limit, with no reference to `outcome`; `indexDelegated`
(`contracts.ts:94-108`) evicts separately by Set insertion order. The guard's read protection is a
membership test against `delegatedPaths` (`contracts.ts:73`), so an evicted path stops being recognised
as delegated at all.

Both functions are exported and take injectable inputs, so this case needs no filesystem.

- Call `mergeDelegatedRecords(existing, incoming, limit)` directly with a small limit and a synthetic set
  in which the newest records have **no** `outcome` (never verified — the ones whose loss removes an open
  question) and older records carry a terminal outcome.
- Assert that a record with no terminal outcome is **not** evicted while the limit still binds, i.e. that
  eviction is verdict-aware: settled records are the ones allowed to fall off.

State the exact policy the assertion encodes in a comment, because more than one defensible policy
exists: *a record with no terminal outcome may only be dropped when every protected record has been
retained.* If you conclude the honest assertion is weaker — for example that the eviction order is at
least stable and derived from `at` rather than Set insertion — say so in the instruction back rather than
weakening the assertion silently. A test written to the implementation instead of the property is the
failure mode this whole document exists to avoid.

## Out of scope, deliberately

- **Findings 6/9 second half (scope-free shell search)** and **8/10 second half (declarations via
  search/shell)** are not in this suite. Both need a source change whose shape is not yet decided, and a
  test cannot be written red against a behaviour that has no agreed target.
- **Findings 13/15** are a host boundary. There is nothing to assert from inside the plugin.
- No source file is fixed by this unit. Cases A, B and D are red on delivery **on purpose** — this is
  the red suite, and the fixes are separate units with their own contracts.

## Acceptance

`node --test tests/oracles/security-review-2-regressions.test.cjs` from `plugin/`, reporting:

| Case | now | after the fix |
| --- | --- | --- |
| A — budget before read | fail | pass |
| B — trace does not persist a synthetic token | fail | pass |
| C — allowlist pins program matching | pass | pass |
| D — verdict-aware eviction | fail | pass |

A run in which every case passes is a **failure of this unit**, not a success: it means the red cases
were written to match the current implementation. Report the actual pass/fail per case rather than
adjusting an assertion until it goes green.
