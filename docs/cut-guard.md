# Round 4 record: `guard.ts`, and the flag that pruned the runs

Two modules landed this round: `context.ts` (`11b5eaf`) and `guard.ts` (`f079bba`), both gate-green in the
same command as their commit. `index.ts`: 115,151 → **90,892 bytes**, 2,343 lines.

| Module | Bytes | Owner |
| --- | --- | --- |
| `index.ts` | 90,892 | `apply`, the hooks, `delegateWorker`, `LocalRouter`, the re-exports |
| `guard.ts` | 20,169 | write/delete detection, the script scan, the delegated-read policy, `evaluateCodeWriteGuard` |
| `verification.ts` | 19,891 | redactor, TAP/tsc parser, policy, sandbox runner |
| `emission.ts` | 11,763 | containment, fenced-block emission |
| `savings-tracker.ts` | 9,724 | pre-existing |
| `contracts.ts` | 8,323 | sha256, contract checks, delegated registry |
| `local-classifier.ts` | 6,509 | pre-existing |
| `profiles.ts` | 4,757 | pre-existing |
| `context.ts` | 4,727 | architect-blind context injection |
| `paths.ts` | 1,831 | `canonicalisePath`, `isPathWithin`, `CODE_EXTENSIONS` |
| `logging.ts` | 1,200 | `resolveDataDir`, `trace` |

## What `guard.ts` cost, and the two exports it forced

The guard and roles blocks are interleaved (`guard, roles, guard, roles, guard`), so the cut was **five
separate edits landed in one commit**: three deletions from `index.ts`, and two exports forced by callers
that stayed behind.

`READ_TOOLS` and `extractWriteTarget` are now exported from `guard.ts` because `apply()` uses both —
`extractWriteTarget` for the guard verdict *and* again for `describeSourceRead`, and `READ_TOOLS` for
`describeSourceRead`'s "is this tool a read?" check. Two copies of a read-tool list would drift, so the
list is exported rather than duplicated. That is the same reasoning that put `delegatedPaths` in
`contracts.ts`, and it is becoming the pattern: **a module owns its data, and callers that need the same
predicate get the predicate, not a copy.**

## The flag that pruned the failure mode

An earlier deletion in this cut failed with *"the worker returned 119 lines"* and no match. The cause was
not the model: `delegate_worker` is served by the DSH process, which loaded `dist` at startup and still
runs the **pre-fix fence scanner**. Any patch whose SEARCH text contains a backtick run is truncated
before the parser sees it. Every guard doc comment contains backticks.

The route that works, and which is now the default for a fence-bearing patch:

1. Generate the patch **from the file itself** — `[System.IO.File]::ReadAllBytes` + `UTF8.GetString`, then
   slice the measured line range — rather than retyping it. A retyped search text differs in ways the eye
   cannot see.
2. Write it with `UTF8Encoding($false)`.
3. Apply it with `scripts/apply-staged-patch.cjs`, which calls the plugin's own parse and apply
   primitives from disk.

Step 1 also caught a real defect in my own tooling: `Get-Content`/`Set-Content` round-tripped a UTF-8
em-dash into `â€"`, which is invisible in a diff and would have silently corrupted any file it touched.
Reading and writing bytes directly removes the whole class.

## The oracle this cut had to change, and why that is not a weakening

`debrand.test.cjs` asserted the guard's delegation guidance by reading `dist/index.js`. The string moved
to `dist/guard.js`, so the oracle failed — correctly, because it was pinned to a module rather than to
what ships. It now reads every `.js` in `dist`, which the file's own scope note already described. The
assertion is unchanged and still demands the exact string `/cannot modify an existing file/i`, and the
`RTX` check still runs. Widening the file set is the honest reading of "the shipped output".

Worth stating plainly: an oracle that inspects *where* code lives will break on every refactor. The ones
that assert *behaviour* did not move once across five cuts.

## What remains

- **`roles.ts`** — source egress (`SourceEgressPolicy`, `SOURCE_LANGUAGES`, `detectSourceEgress`,
  `evaluateSourceEgress`), the agent-role map (`rememberAgentRole`, `roleForAgent`, `resetAgentRoles`),
  `describeSourceRead`, `resolveAgentRole`, `applyArchitectConfig`, `applyAgentRole`,
  `resolveLeadProviders`. Note the orphaned doc comment at the top of `evaluateCodeWriteGuard`'s old spot
  in `index.ts` now describes a function that is not below it; the roles cut should take or delete it.
- **`delegation.ts`** — the largest block: `delegateWorker`, `DelegateWorkerParams`,
  `DELEGATE_WORKER_OPENAI_SCHEMA`, `parseSearchReplaceBlocks`, `applySearchReplaceBlocks`,
  `MIN_SEARCH_CHARS`, `resolveChatCompletionsUrl`, `extractPromptText`, `estimateTokenCount`. When it
  moves, `configurePatchEngine` in `index.ts` is the only wiring that has to change — that seam was
  designed for exactly this cut.
- **`index.ts`** — `apply`, the hooks, tool registration, `LocalRouter` (still in the file, and not in
  `docs/refactor.md`'s queue), and the DLP rules.
- `index.ts` is at 90,892 bytes against the ~70 KB target. The two remaining modules are the largest, so
  the target is reachable in roughly two more rounds.
