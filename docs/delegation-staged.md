# `delegation.ts`: staged, and exactly what remains

`plugin/src/delegation.ts` is committed as a **staging artifact**: 278 lines, imported by nothing, so the
built plugin is unchanged by its presence. `tsc --noEmit` is clean with it in the tree. It is the first
four chunks of queue step 7, written and verified against the file.

## What is already in it

| Symbol | Source lines in `index.ts` | Notes |
| --- | --- | --- |
| `DELEGATE_WORKER_OPENAI_SCHEMA`, `DELEGATE_WORKER_SCHEMA` | 336–394 | verbatim |
| `DelegateWorkerParams` | 454–494 | verbatim; `ContextRequest` and `VerificationPolicy` are now imported as types |
| `DEFAULT_LOCAL_ENDPOINT`, `resolveChatCompletionsUrl` | 497–508 | interpolated strings became concatenation |
| `SearchReplaceBlock`, `PatchResult`, `MIN_SEARCH_CHARS`, the three marker constants | 511–530 | verbatim |
| `parseSearchReplaceBlocks` | 540–572 | verbatim |
| `applySearchReplaceBlocks` | 583–624 | three interpolated strings became concatenation |
| `resolveDelegateStatus` | 637–647 | **moved here deliberately** — see below |

The module's import header is already written: `fs`, `path`, `SavingsTracker`, `PROFILES`,
`resolveDataDir`, `extractAndEmitFiles`, `ContextRequest`/`resolveContextFiles`,
`DEFAULT_VERIFICATION_POLICY`/`TestResults`/`VerificationPolicy`/`evaluateVerificationPolicy`/
`runSandboxVerification`, and `contractFileHashes`/`contractViolations`/`rememberDelegated`/
`resolveContractFiles`.

## `resolveDelegateStatus` moved to this module on purpose

`docs/refactor.md` lists it under `contracts.ts`. It is not a contracts concern — it is the verdict
precedence for a delegation, a pure function over `verificationGate`, `unverified`, `contractViolations`
and `isSuccess`. It belongs with the delegation that produces those inputs. `docs/cut-roles.md` recorded
the same reasoning; this is the round that acted on it.

## What remains, measured

| Source lines in `index.ts` | Contents |
| --- | --- |
| 649–981 | `delegateWorker` (~330 lines) |
| 983–1063 | `extractPromptText` |
| 1065–1068 | `estimateTokenCount` |
| 396–452 | `scanDLP` — **stays in `index.ts`**, see `docs/cut-roles.md` |

Then the `index.ts` wiring: import, re-export every public symbol, and delete all four regions above plus
the already-moved ones.

### The two traps that will otherwise cost a round

**1. `delegateWorker` contains a literal fence.** Its `fileInstruction` string (source line ~747) embeds a
`patch`-style block with triple backticks to teach the worker the delta format. That string **must** be
rewritten with `\x60` escapes, or the deletion patch for `delegateWorker` will be truncated by the running
plugin's pre-fix emission scanner — the same trap that `detectSourceEgress` hit. The instruction the worker
receives is unchanged either way, because `\x60\x60\x60` is the same three characters at runtime.

**2. `delegateWorker` calls `scanDLP`, which stays in `index.ts`.** That makes `delegation.ts` import from
`./index`, giving `index ↔ delegation` — the same shape as the existing `index ↔ verification` cycle, which
works because function declarations are hoisted. It is deliberate, not an oversight: the alternative
(putting `scanDLP` in `delegation.ts`) creates a **leaf-to-leaf** `verification ↔ delegation` cycle, which
is strictly worse.

### The wiring that gets simpler, not harder

`index.ts` currently contains:

```ts
configurePatchEngine({
  parse: parseSearchReplaceBlocks,
  apply: applySearchReplaceBlocks,
})
```

When those two functions move, that call belongs in `delegation.ts` and `index.ts` simply stops calling
it — `emission.ts` still receives its engine, and the seam closes without the composition root. That is
what the seam was built for, and `docs/handoff-emission.md` predicted it correctly two rounds early.

### Method

Every deletion patch must be generated **from the file bytes** — `[System.IO.File]::ReadAllBytes` →
`UTF8.GetString` → slice the measured range → write with `UTF8Encoding($false)` → apply with
`scripts/apply-staged-patch.cjs`. `Get-Content`/`Set-Content` silently mangles UTF-8 (an em-dash became
`â€"` while writing this refactor's own tooling), and a retyped search text differs in ways the eye cannot
see. Chunk boundaries must be chosen so each chunk compiles alone, because the staged module is typechecked
between steps.
