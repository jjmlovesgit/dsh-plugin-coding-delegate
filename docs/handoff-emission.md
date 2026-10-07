# Handoff: the emission cut, and the tooling it exposed

Round record. Read this before starting the next module; it is cheaper than rediscovering it.

## Landed

| Commit | What |
| --- | --- |
| `ab31a0f` | `evaluateEmissionPath` + `extractAndEmitFiles` move to `plugin/src/emission.ts`, re-exported |
| `3d638e0` | dist rebuilt |
| `ad08939` | the fence scan no longer truncates a body that contains a fence |

`plugin/src/index.ts`: 149,337 → 141,211 bytes. `emission.ts`: 11,763 bytes, 276 lines.

All three were committed with the full gate green in the same command: `tsc`, 39 unit tests, 223 oracles.

## The design decision worth knowing

`parseSearchReplaceBlocks` / `applySearchReplaceBlocks` did **not** move, although
`extractAndEmitFiles` calls them. They are queued for `delegation.ts` (step 7), and `delegation.ts`
imports `emission.ts`, so an `emission.ts` that imported them back would be a cycle. The cut inverts the
dependency: `emission.ts` exposes `configurePatchEngine`, and `index.ts` — which holds both halves —
calls it at module scope. Both seams default closed, so a mis-ordered load refuses rather than crashes.

Note the consequence for step 7: when the patch primitives move to `delegation.ts`, the
`configurePatchEngine` call in `index.ts` is the only thing that has to change.

## The tooling limits this round measured

Both are new findings, written up in `findings.md`. They shaped every minute of this cut.

**The worker stops at ~1,200 completion tokens**, regardless of `max_tokens: 8192`. Prompt length is not
the constraint — a 5,252-token prompt is accepted. So a ~150-line module is at the edge of what one
emission can produce, and "worker returned 28 lines" or "no complete search/replace block" means the
reply was cut off, not that the model misbehaved.

**The fence scanner truncated any body containing a fence.** Now fixed. Before the fix, no patch that
quoted a ` ``` ` line could be applied at all, including every patch needed to move this very code.

## A constraint on the agent, not the code

The `delegate_worker` tool runs **inside the DSH server process**, which loaded the plugin's `dist` at
startup. Commits to `plugin/dist` do not affect it. Every `delegate_worker` call in this session after
the fence fix therefore still used the pre-fix scanner and failed on fence-bearing patches. The fix is
verified directly instead — the same reply that previously refused now parses whole and reaches the patch
stage (`scripts/../docs/rx-test2.js` reproduces it against `dist`).

**Consequence for the next module:** until the plugin server is restarted, the in-session
`delegate_worker` still has the old scanner, so fence-bearing patches will keep failing there. Two ways
out, in order of preference:

1. Restart DSH so the plugin reloads `dist`, then patch normally.
2. Stage patch files under `docs/` and apply them with `scripts/apply-staged-patch.cjs`, which calls the
   plugin's own parse and apply primitives from disk and therefore always uses the current build.

The workaround scripts are deliberately still untracked and can be deleted once the server is restarted.

## Next module: `verification.ts`

Queue step 2, `docs/refactor.md`: `captureCommandOutput`, `runSandboxVerification`, `parseTestOutput`,
`redactVerificationOutput`, `describeFailures`, `persistRaw`, `evaluateVerificationPolicy`,
`resolveVerificationPolicy`, `requestApprovalForVerification`, plus `TestResults`, `RedactedFailure`,
`VerificationPolicy`, `DEFAULT_VERIFICATION_POLICY`, and the private helpers `looksLikeCode`,
`cleanMessage`, `sanitizeRetainedField`, `commandProgram`, `runInProcessFallback`.

It is larger than `emission.ts` and has three inward dependencies to plan for: `PluginConfig` (still in
`index.ts`), `ApprovalOutcome` / the approval seam (`requestApprovalForWrite` is not in this module), and
`estimateTokenCount`. Check each before cutting; a cycle here would look exactly like the one avoided
above.
