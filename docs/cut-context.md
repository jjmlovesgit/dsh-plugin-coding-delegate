# Cut 4: `context.ts` — the round that moved a block verbatim

**Landed** as `11b5eaf`, gate green in the same command. `index.ts` 115,151 → **110,843 bytes**, 2,780
lines. `context.ts` is 132 lines.

## What moved

`ContextRequest`, `ContextInjection`, `ContextResolution`, `DEFAULT_CONTEXT_MAX_BYTES` and
`resolveContextFiles` — the whole block, `index.ts` lines 564–690. All five are re-exported, so the
frozen public surface is unchanged.

## Why this one is different from the last three

It is the first cut that moved **verbatim**. At 126 lines the block fits in a single emission, so no
interpolated string had to be rewritten as concatenation and no doc comment had to be stripped of
fences. `context.ts` is a byte-for-byte copy of what `index.ts` held, which is a stronger equivalence
claim than the previous rounds could make — those needed a golden capture because the text changed.

Its dependency direction is clean and needs no seam: it calls `evaluateEmissionPath`, which
`emission.ts` already exports, and it does not touch `index.ts` at all. No cycle to reason about.

The prediction in `handoff-emission.md` that this block would need `scanDLP` was wrong, and
`handoff-contracts.md` corrected it before the cut: the DLP scan of injected context happens in
`delegateWorker`, at the call site, not inside `resolveContextFiles`.

## What comes next, measured rather than described

The queue's next two items are `guard.ts` (step 5) and `roles.ts` (step 6). **They are interleaved in
the file, so they cannot be cut in queue order without a boundary decision.** Measured boundaries:

| Lines | Contents | Belongs to |
| --- | --- | --- |
| 1357–1620 | `WRITE_TOOLS`/`SHELL_TOOLS`/`READ_TOOLS`, `isDelegatedPath`, `findDelegatedRead`, `DEFAULT_GUARD_ASK_PATHS`, `GuardVerdict`, `extractWriteTarget`, `shellWriteTarget`, `SCRIPT_EXTENSIONS`, `WRITE_PRIMITIVES`, `CODE_REFERENCE`, `COMMAND_WRITE_PRIMITIVES`, `INLINE_EVAL_FLAG`, `hasCommandWriteSignal`, `DELETE_PRIMITIVES`, `hasCommandDeleteSignal`, `extractScriptPaths`, `READ_ONLY_INSPECTORS`, `isReadArgument`, `longestCodeReference`, `resolveScriptPath`, `defaultReadScript`, `findWriteViaScript` | `guard.ts` |
| 1622–1720 | `SourceEgressPolicy`, `SOURCE_LANGUAGES`, `DEFAULT_SOURCE_EGRESS_MIN_LINES`, `SourceEgressDetection`, `detectSourceEgress`, `evaluateSourceEgress` | `roles.ts` |
| 1722–1739 | `DelegateReadPolicy`, `evaluateDelegatedReadPolicy` | `guard.ts` |
| 1741–1839 | `AGENT_ROLE_LIMIT`, the agent-role map, `rememberAgentRole`, `roleForAgent`, `resetAgentRoles`, `SourceReadObservation`, `describeSourceRead` | `roles.ts` |
| 1841–2011 | `evaluateCodeWriteGuard` | `guard.ts` |
| 2014–2056 | `ApprovalOutcome`, `APPROVAL_OUTCOMES`, `requestApprovalForWrite` | `guard.ts`, but a different concern — see below |

So the file is **guard, roles, guard, roles, guard**, and a single-module-per-round cut cannot follow
the queue order. Two clean options, and the choice should be made deliberately:

1. **Cut `guard.ts` as three separate edits in one round** — 1357–1620, then 1722–1739, then
   1841–2011 — landing all three in one commit so the gate never sees a half-cut. This keeps the
   queue's order and is what the boundaries above are for.
2. **Cut `roles.ts` first**, since 1622–1720 plus 1741–1839 is contiguous apart from one 1-line
   interruption. This reorders the queue, which `docs/refactor.md` allows ("roughly decreasing
   cohesion") but should be recorded as a deliberate change rather than drift.

Option 1 is preferred: the queue's order exists because `delegation.ts` and `index.ts` depend on both,
and `guard.ts` is the module with the frozen surface on it.

## The dependency that decides `guard.ts`'s shape

`evaluateCodeWriteGuard` takes a plain config object, **not** `PluginConfig` (measured at
`index.ts:1843-1857`). It never reads `ASK_PATHS` or any config from the module scope, and it does not
call the approval seam — `requestApprovalForWrite` is a separate function that `apply()` wires up. So
`guard.ts` needs no `PluginConfig`, no `ApprovalOutcome`, and no seam: it imports `fs`, `path`,
`canonicalisePath`, `isPathWithin`, `CODE_EXTENSIONS` from `./paths`, and `delegatedPaths` from
`./contracts`. That is the cleanest dependency set of any cut so far.

`delegatedPaths` being exported from `contracts.ts` — the decision recorded in
`handoff-contracts.md` — is exactly what makes this possible.

## `guard.ts` is staged, not landed

`plugin/src/guard.ts` exists and is committed as a **staging artifact**: it holds the first third of the
guard block (lines 1357–1620 — the tool sets, `isDelegatedPath`, `GuardVerdict`, `extractWriteTarget`,
`shellWriteTarget`, the primitive regexes, `hasCommandWriteSignal`), and ends at the marker
`// GUARD-CONTINUE-1`. It is **not imported by anything**, so the built plugin is unchanged by its
presence. It typechecks on its own (`tsc --noEmit` is clean with it in the tree).

Nothing about `guard.ts` is wired up yet: no import, no re-export, no deletion from `index.ts`. The cut
is not half-landed — it has not started from the plugin's point of view.

### A defect worth recording, because review did not catch it

The first version of that module was written from memory rather than from the file, and it diverged
from the real code in four places:

| Symbol | What I wrote | What the file says |
| --- | --- | --- |
| `findDelegatedRead` | scanned whitespace tokens directly | checks `command.includes(canonical)` for both path spellings and calls `isReadArgument` |
| `GuardVerdict.kind` | `'ask' \| 'deny'` | `'deny' \| 'ask'` |
| `extractWriteTarget` | keys `file_path`, `path`, `filePath`, … | keys `file_path`, `filePath`, `path`, `filename`, `file`, `target_file`, `targetPath` |
| `shellWriteTarget` | re-used `COMMAND_WRITE_PRIMITIVES` then `CODE_REFERENCE` | its own regex, then a `CODE_EXTENSIONS.has(path.extname(...))` check |

All four are behaviour-changing, and three of them are exactly the kind of quiet wrongness the oracles
exist to catch but might not: `extractWriteTarget`'s key order decides which argument a tool call is
read as. It was caught by reading the block before delegating the deletion — the method's first step —
and by moving `findDelegatedRead` out of the first chunk, which is what made `tsc` notice the missing
`isReadArgument`.

The rule this restates: **the block is read before it is moved, and the module is diffed against the
block after.** Reconstructing moved code from memory is a blind patch by another name.

### Ordering constraint for the rest of this cut

Chunk boundaries must be chosen so each chunk compiles alone, because the staged module is typechecked
between steps. `findDelegatedRead` calls `isReadArgument`, which lives in the section after the guard
primitives, so `findDelegatedRead` has to be emitted **after** `isReadArgument` rather than with
`isDelegatedPath` where the original file keeps it. This is a reordering of text within the module, not a
behaviour change, and it is the only reordering; note that `index.ts` is hoisted, so the original file
could keep the calls above the definitions and a module boundary cannot.

