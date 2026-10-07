# The refactor is complete

`delegation.ts` landed as `6e8e4b1`, gate green in the same command. That was queue step 7, the last
module. `docs/refactor.md`'s "what done looks like" is met, measured rather than asserted:

| Criterion (`docs/refactor.md`) | Measured |
| --- | --- |
| `index.ts` under roughly 20,000 tokens | **53,531 bytes ≈ 13,383 tokens** — was 149,337 bytes ≈ 37,000 |
| so ~70 KB | 53 KB |
| Every module independently readable | 12 modules, largest 29 KB |
| All oracles plus unit tests green | **223 oracles, 39 unit** |
| CI's `dist` gate | `git diff --exit-code -- dist` clean after a fresh build |

## The final inventory

| Module | Bytes | Contents |
| --- | --- | --- |
| `index.ts` | 53,531 | `apply`, the hooks, tool registration, `LocalRouter`, `scanDLP`, the re-exports |
| `delegation.ts` | 29,242 | worker schemas, params, the search/replace engine, `delegateWorker` |
| `guard.ts` | 20,397 | write/delete detection, script scan, delegated-read policy |
| `verification.ts` | 19,891 | redactor, TAP/tsc parser, policy, sandbox runner |
| `emission.ts` | 11,763 | containment, fenced-block emission |
| `roles.ts` | 11,074 | source egress, agent-role map, role/config layer |
| `contracts.ts` | 8,323 | sha256, contract checks, delegated registry |
| `context.ts` | 4,727 | architect-blind context injection |
| `paths.ts`, `logging.ts` | 1,831, 1,200 | the shared spine |

`savings-tracker.ts`, `local-classifier.ts` and `profiles.ts` were already separate.

The enabling condition is met for the reason the refactor existed: `index.ts` now fits inside the local
worker's 32,768-token window with room for an instruction, so it can be handed to a delegation instead of
blind-patched. It was 41,000 tokens and could never be.

## The seam redeemed itself

`configurePatchEngine` was introduced in the `emission.ts` cut purely to avoid a cycle, with a note in
`docs/handoff-emission.md` that when the patch primitives moved, "the `configurePatchEngine` call in
`index.ts` is the only thing that has to change." That is exactly what happened: the call moved into
`delegation.ts`, where both halves now live, and `index.ts` stopped calling it. `emission.ts` still
cannot import `delegation.ts` back — it is handed its engine — and both seams still default closed.

## The last cut's two traps, both real

**The worker stops on its own stop sequences.** A patch whose text contains `<|im_end|>` is truncated
mid-reply, because `delegateWorker` sends that as a `stop` value. The first attempt at the fetch block
produced *"the patch contained no complete search/replace block"* and 177 completion tokens. The fix is
to build the literal by concatenation (`'<|im_' + 'end|>'`), which is the same string at runtime. The
same applies to an emission body that quotes them.

**A chunk boundary closed a guard a chunk early.** The prologue chunk ended with `}` for
`if (params.contextFiles …)`, and the next chunk's DLP check assumed it was still open. That produced
one extra brace *and* moved the DLP check outside the guard that is supposed to contain it — a silent
behaviour change that `tsc` reported only as a stray brace, and only because it was also a syntax error.
Caught by tracking brace depth per line, then fixed with a byte-exact staged patch. It is worth stating
plainly: the same mistake in a place where braces happened to balance would have compiled and shipped.

`tsc --noEmit` clean is not evidence of equivalence when a cut reorders control flow. The 223 oracles —
`context-injection`, `delta-emission`, `durable-registry`, `contract-integrity` all exercise
`delegateWorker` — are what actually stand behind that claim.

## Method, for whoever writes the next patch

- Generate deletion patches **from the file bytes**, never retyped: `[System.IO.File]::ReadAllBytes` →
  `UTF8.GetString` → slice → `UTF8Encoding($false)` → `scripts/apply-staged-patch.cjs`. Retyped search
  text differs in ways the eye cannot see, and `Get-Content`/`Set-Content` silently mangles UTF-8.
- **One patch block per `delegate_worker` call.** Two blocks in one instruction reliably produces only
  the first; the worker's ~1,200-token completion ceiling is the binding constraint.
- Chunk boundaries must leave the file valid, because the staged module is typechecked between steps.
- More open defects are recorded in `docs/findings.md`, including the two tooling limits this refactor
  measured and the fence-scanner bug it fixed.
