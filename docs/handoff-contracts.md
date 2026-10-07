# Round 3 record: `contracts.ts`, and where the refactor now stands

Written at the end of the round that extracted `contracts.ts`, so the next session starts from measured
state rather than from the queue's description of it.

## Landed this round

| Commit | What |
| --- | --- |
| `7502d77` | `verification.ts` extracted, re-exported |
| `928559a` | the verification cut's plan and its before/after golden evidence |
| `d093869` | `contracts.ts` extracted, re-exported |

`plugin/src/index.ts`: 141,211 → **115,151 bytes**, 2,890 lines. Still above the ~70 KB target.

| Module | Lines | Bytes | Contents |
| --- | --- | --- | --- |
| `logging.ts` | 32 | 1,200 | `resolveDataDir`, `LOG_FILE`, `trace` |
| `paths.ts` | 44 | 1,831 | `canonicalisePath`, `isPathWithin`, `CODE_EXTENSIONS` |
| `emission.ts` | 276 | 11,763 | containment + fenced-block emission |
| `verification.ts` | 561 | 19,891 | redactor, TAP/tsc parser, policy, sandbox runner |
| `contracts.ts` | 206 | 8,323 | sha256, contract resolution/violations, delegated registry |

## The two decisions a later cut has to know about

**`delegatedPaths` is exported from `contracts.ts`, not private to it.** The set is mutated in three
places — `rememberDelegated` inside the module, `apply()` at startup, and the write guard's read — so a
module that owned the registry could not also privately own the set. The emission cut met the same shape
and solved it with a `configurePatchEngine` seam; this one is simpler because there is no cycle to
avoid. **When `guard.ts` moves (queue step 5), it imports `delegatedPaths` from `contracts.ts`.**

**`resolveDelegateStatus` did not move**, although `docs/refactor.md` lists it under `contracts.ts`. It
is a pure verdict-precedence function with no contract or registry dependency, and it belongs with the
delegation verdict rather than with contract integrity. It should go to `delegation.ts` (step 7), or to
`verification.ts` if that reads better — but not to `contracts.ts`, which is now about files and the
registry only. `resolveVerificationPolicy` and `requestApprovalForVerification` likewise stayed behind
for a cycle reason, recorded in `docs/cut-verification.md`.

## The tooling constraint that shaped all three cuts

The DSH server this agent runs in **loaded the plugin's `dist` at startup**, so the fence-scanner fix
committed in `ad08939` is not live inside `delegate_worker` in this session. `findings.md` records the
bug and `handoff-emission.md` records the consequence. Practical effects, both measured this round:

1. **Any emission containing a backtick run is still truncated.** Every interpolated string in a moved
   block is therefore written as concatenation, and no doc comment may contain a fence. This is a
   constraint on the *agent*, not the code — the code is correct either way — but it is why
   `verification.ts` reads with `'a ' + x + 'b'` where the original had a template literal.
2. **`delegate_worker` stops at roughly 1,200 completion tokens**, so no single emission carries much
   more than ~100 lines. Each module is created with a skeleton containing a marker comment, then grown
   by patch calls that splice at the marker. This worked for both 561-line `verification.ts` and
   206-line `contracts.ts` without a single failed splice.

A restart of DSH removes constraint 1 and lowers the cost of the next cut substantially. Until then,
stage fence-bearing patches under `docs/` and apply them with `scripts/apply-staged-patch.cjs`.

## Next: `context.ts` (queue step 4)

`resolveContextFiles` and its types (`ContextRequest`, `ContextInjection`, `ContextResolution`,
`DEFAULT_CONTEXT_MAX_BYTES`). It is a single function, read exactly: roughly 100 lines, so **one
emission should carry it whole** — the first cut in this refactor for which that is true.

Its imports are all already-established directions: `fs`, `path`, `crypto` (for the injected `sha256`),
`DEFAULT_CONTEXT_MAX_BYTES` is defined locally, and it calls `evaluateEmissionPath` from `./emission`,
which is the module that already re-exports the containment decision it needs. No dependency on
`index.ts` at all, and therefore no cycle to check for. That is a change from the estimate in
`handoff-emission.md`, which guessed `scanDLP` would be needed: it is not, because the DLP scan of
injected context happens in `delegateWorker`, at the call site, not inside `resolveContextFiles`.

One thing to watch: the section header it builds at runtime contains a three-dash separator, not a
fence, so the module is fence-free as written and does not need the concatenation treatment the last two
did.
