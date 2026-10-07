# Round 5 record: `roles.ts`, and the analysis `delegation.ts` needs

`roles.ts` landed as `6dd59d6`, gate green in the same command. `index.ts`: 90,892 → **79,964 bytes**,
2,066 lines. That is under the ~70 KB target's neighbourhood but not under it.

| Module | Bytes | Owner |
| --- | --- | --- |
| `index.ts` | 79,964 | `apply`, the hooks, tool registration, `LocalRouter`, `delegateWorker`, the DLP rules, re-exports |
| `guard.ts` | 20,397 | write/delete detection, script scan, delegated-read policy |
| `verification.ts` | 19,891 | redactor, TAP/tsc parser, policy, sandbox runner |
| `emission.ts` | 11,763 | containment, fenced-block emission |
| `roles.ts` | 11,074 | source egress, agent-role map, role/config layer |
| `contracts.ts` | 8,323 | sha256, contract checks, delegated registry |
| `context.ts` | 4,727 | architect-blind context injection |
| `paths.ts`, `logging.ts` | 1,831, 1,200 | the shared spine |

## What `roles.ts` cost

Three fragments of `index.ts` (the block is split by the approval seam) plus the wiring. Two
translations were forced by the tooling, both behaviour-preserving:

- `detectSourceEgress` builds its fence with `\x60` escapes instead of a literal triple backtick. The
  running plugin still uses the pre-fix emission scanner, which truncates a fenced body at the first
  backtick run inside it, so a literal fence in this file makes the file unpatchable.
- `evaluateSourceEgress`'s interpolated strings became concatenation, for the same reason.

`resolveLeadProviders` and `resolveVerificationPolicy` take **structural option types rather than
`PluginConfig`**. Both read only optional fields, and importing `PluginConfig` from `index.ts` would be a
cycle, since `index.ts` imports those modules. Both remain public with an unchanged call shape, because
`PluginConfig` has those fields optional.

The doc comment describing `evaluateCodeWriteGuard` was misfiled above the source-egress type. It moved
to `guard.ts`, where that function now lives — a small thing, but it is the kind of drift the interleaved
layout produced.

## `delegation.ts`: the analysis, so it is not re-derived

Queue step 7, and the largest remaining cut. Measured boundaries in the current `index.ts`:

| Lines | Contents |
| --- | --- |
| 336–392 | `DELEGATE_WORKER_OPENAI_SCHEMA` |
| 394–396 | `DELEGATE_WORKER_SCHEMA` |
| ~402–452 | `scanDLP` — **see the cycle note below** |
| 454–495 | `DelegateWorkerParams` |
| 497–509 | `DEFAULT_LOCAL_ENDPOINT`, `resolveChatCompletionsUrl` |
| 511–647 | `SearchReplaceBlock`, `MIN_SEARCH_CHARS`, `parseSearchReplaceBlocks`, `applySearchReplaceBlocks` |
| 649–981 | `delegateWorker` |
| 983–1063 | `extractPromptText` |
| 1065–1068 | `estimateTokenCount` |
| 1070+ | `EffectiveConfig`, `LocalRouter` — **not in the queue; step 8's remainder** |

### The cycle to decide before cutting

`verification.ts` imports `scanDLP` from `./index`, and `delegateWorker` also calls `scanDLP` for its
context DLP check. So:

- If `scanDLP` **stays** in `index.ts`, `delegation.ts` imports it from `./index` — giving
  `index ↔ delegation`, the same cycle shape `index ↔ verification` already has and which works because
  function declarations are hoisted.
- If `scanDLP` **moves** to `delegation.ts`, then `verification.ts` imports from `./delegation`, and
  `delegation.ts` imports `runSandboxVerification` from `./verification` — a **module-level cycle between
  two leaves**, which is worse than a cycle through the composition root.

**Decision: leave `scanDLP` in `index.ts`.** It is a DLP rule, the queue says an eighth pass is needed
for the DLP rules, and keeping it avoids the leaf-to-leaf cycle.

### The wiring that changes

`delegateWorker`'s patch engine is injected, not imported: `index.ts` calls `configurePatchEngine({
parse: parseSearchReplaceBlocks, apply: applySearchReplaceBlocks })` at module scope. When those two
functions move to `delegation.ts`, **that call is the only wiring that changes** — it becomes part of
that module, and the seam closes itself. That is what the seam in `emission.ts` was built for, and this
is the cut that redeems it. `docs/handoff-emission.md` predicted this; it holds.

### Method notes that will save a round

- The block is ~700 lines. Budget 7–8 emissions of ~90 lines each against the ~1,200-token completion
  ceiling, plus 7–8 deletions.
- `delegateWorker` contains the `fileInstruction` string with a literal fence in it (line ~747 of the
  old file). It **must** be rewritten with `\x60` escapes, or the deletion patch for it will be
  truncated — this is the same trap as `detectSourceEgress`.
- Generate every deletion patch from the file bytes, never retyped:
  `[System.IO.File]::ReadAllBytes` → `UTF8.GetString` → slice → `UTF8Encoding($false)` write, then
  `scripts/apply-staged-patch.cjs`. `Get-Content`/`Set-Content` silently mangles UTF-8 (an em-dash became
  `â€"` in this round's tooling), and a retyped search text differs in ways the eye cannot see.
- Chunk boundaries must be chosen so each chunk compiles alone, because the staged module is typechecked
  between steps. `parseSearchReplaceBlocks` must therefore precede `applySearchReplaceBlocks`, and both
  must precede `delegateWorker`.
