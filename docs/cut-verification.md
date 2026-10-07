# Cut 3: `verification.ts` — plan and constraints

Round 2 record. Written before the cut, so the decisions are checkable against the diffs.

## What moves

`plugin/src/index.ts` lines 333–870, the whole verification block:

| Symbol | Kind |
| --- | --- |
| `RedactedFailure`, `TestResults` | exported types |
| `VerificationPolicy`, `DEFAULT_VERIFICATION_POLICY` | exported type + const |
| `looksLikeCode`, `cleanMessage`, `sanitizeRetainedField` | private helpers |
| `redactVerificationOutput`, `describeFailures` | exported |
| `parseTestOutput`, `runInProcessFallback` | exported |
| `commandProgram`, `evaluateVerificationPolicy` | exported |
| `captureCommandOutput`, `persistRaw` | private |
| `runSandboxVerification` | exported |

`resolveVerificationPolicy` and `requestApprovalForVerification` (index.ts 2838–2881) stay behind: they
are the *policy source* and the *approval seam*, not the verification machinery, and the refactor queue
lists them under step 2 only as "if separate". Leaving them means one less import cycle to reason about.
They can move in a later pass.

## The dependency that would have been a cycle

`resolveVerificationPolicy(options: PluginConfig)` reads exactly three fields. If it moved,
`verification.ts` would need `PluginConfig`, which lives in `index.ts`, which will import
`verification.ts` — a cycle. It stays, and this is the check the emission handoff asked for.

The three symbols `index.ts` still needs from the module are `DEFAULT_VERIFICATION_POLICY`,
`evaluateVerificationPolicy` and `runSandboxVerification` (used by `delegateWorker` at 1424–1440).
Everything else in the block is self-contained; the only inward dependency is `scanDLP`, already
exported from `index.ts` for `sanitizeRetainedField` to use.

## Two deliberate departures from a byte-for-byte move

Both are forced by the tooling limits in `findings.md`, and both preserve behaviour. They are
**characterisation-preserving, not byte-preserving**, and that distinction is the honest one:

1. **Template literals become string concatenation.** The live plugin process still runs the pre-fix
   fence scanner (see `handoff-emission.md`), which truncates any emission containing a ` ``` ` or a
   bare backtick run. Interpolated error strings are therefore written as `'a ' + x + 'b'`. The emitted
   text is identical.
2. **The module arrives in three emissions.** The worker stops at ~1,200 completion tokens, and this
   block is ~4,000 tokens of code. It is created with a skeleton, then grown by two patch calls that
   splice at an explicit marker comment. Same constraint as emission.ts.

## Why no new oracle

The moved code already has one: `plugin/tests/oracles/redaction.test.cjs` pins the redactor's shape, and
`verify-integrity.test.cjs` (217 lines) pins the refusal and clobber paths. Both reach it through
`dist/index.js`, so they exercise the re-export too. A new test would restate them.

What those oracles do **not** cover is this cut's real risk: that `redactVerificationOutput` produces the
same output after its template literals become concatenation. That is checked directly, before and
after, rather than asserted.
