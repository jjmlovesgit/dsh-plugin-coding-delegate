# Refactor: splitting `plugin/src/index.ts`

Operational note for whoever picks this up, including a fresh agent with no prior context.

## Why this exists

`plugin/src/index.ts` was 3,799 lines and roughly **41,000 tokens**. The local worker's context window is
**32,768**, so that file can never be handed to it — not as `contextFiles`, not in an instruction. Every
edit to it is therefore a *blind patch*: the worker is given exact search text and matches it without ever
seeing the file.

That is why the file is the ceiling on this design. Smaller modules change what the loop can do.

## The method, per cut

Each cut is **one delegated unit**, not a hand edit:

1. **Read the block** you intend to move, exactly, with line numbers. `read` is allowed for you; writing
   source is not (see the rules below).
2. **Delegate one `delegate_worker` call** containing:
   - the new module as a whole-file fenced block: ` ```ts file="plugin/src/<name>.ts" ``
   - a patch block for `index.ts` with four hunks: add the import, add the re-export, delete the moved
     block, and — where a constant moves too — delete that as well.
   - `runVerification`: the gate command below.
3. **The verification is the contract.** It runs `tsc` plus all oracles. If it is green, the cut is
   correct; if not, the plugin reports the failing assertions and you re-delegate with a correction.

Two cuts have been done this way, both green first time:

| Module | Contents |
| --- | --- |
| `logging.ts` | `resolveDataDir`, `LOG_FILE`, `trace` |
| `paths.ts` | `canonicalisePath`, `isPathWithin`, `CODE_EXTENSIONS` |

## The queue

In dependency order. `paths.ts` and `logging.ts` are done; the rest are roughly decreasing cohesion.

1. **`emission.ts`** — `evaluateEmissionPath`, `extractAndEmitFiles`, `evaluateContextRequest` if separate,
   the emission-result types. *Next.*
2. **`verification.ts`** — `captureCommandOutput`, `runSandboxVerification`, `parseTestOutput`,
   `redactVerificationOutput`, `describeFailures`, `persistRaw`, `evaluateVerificationPolicy`,
   `resolveVerificationPolicy`, `requestApprovalForVerification`.
3. **`contracts.ts`** — the durable delegated-path registry (`resolveDelegatedRegistryPath`,
   `parseDelegatedRegistry`, `mergeDelegatedRecords`, `pruneDelegatedRecords`, `saveDelegatedRegistry`,
   `loadDelegatedRegistry`, `rememberDelegated`), `sha256File`, `resolveContractFiles`,
   `contractFileHashes`, `contractViolations`, `resolveDelegateStatus`.
4. **`context.ts`** — `resolveContextFiles` and its types.
5. **`guard.ts`** — `evaluateCodeWriteGuard` and its helpers (`extractWriteTarget`,
   `hasCommandWriteSignal`, `hasCommandDeleteSignal`, `READ_ONLY_INSPECTORS`, `isReadArgument`,
   `longestCodeReference`, `isDelegatedPath`, `findDelegatedRead`, `evaluateDelegatedReadPolicy`,
   `WRITE_TOOLS`/`READ_TOOLS`/`SHELL_TOOLS`, `DELETE_PRIMITIVES`).
6. **`roles.ts`** — `resolveAgentRole`, `applyArchitectConfig`, `applyAgentRole`,
   `resolveLeadProviders`, the agent-role map, `describeSourceRead`, source-egress policy.
7. **`delegation.ts`** — `delegateWorker`, the search/replace patch parser, `DELEGATE_WORKER_*_SCHEMA`.
8. **`index.ts`** — `apply`, the hooks, tool registration, and the re-exports.

An eighth pass may be needed for `LocalRouter` / routing, and for the DLP rules still in `index.ts`.

## Rules that are not negotiable

- **Reading is gated too, and it breaks the method unless it is handled.** A delegated *patch* puts the
  file in the delegated registry, so `delegateReadPolicy` decides whether the next round can read the
  block it must quote. With the default `'ask'` in a session that cannot raise approvals, that is a
  refusal — and the refactor stops at step 1. The live profile sets `delegateReadPolicy: 'allow'` for
  exactly this reason, and the `SOURCE_READ` trace records the cost so the question stays answerable. Code
  has since changed so that only files the worker *created* are gated; patched files stay readable, which
  is what makes iterating on an existing file possible at all.
- **Run the loop from a session rooted at the repository.** A fresh agent inherits the workspace of the
  session that spawned it. From anywhere else — `C:\Projects\temp`, for instance — every write is denied,
  including to `.git`, so the commit/push/CI gate cannot run and no useful work is possible. The first
  automated round discovered exactly this and correctly refused to half-land a cut.

- **Delegate source changes.** The code guard refuses a cloud-authored source write (rule 2). `index.ts`,
  any new `.ts`, and any `.cjs` are source. Yours to write directly: `.md`, and nothing else in the repo.
- **Never commit red.** The gate command is:

  ```powershell
  node --test plugin/tests/oracles/*.test.cjs
  # then, from plugin/: node node_modules/vitest/vitest.mjs run
  ```

  Run it and gate the commit on the exit code **in the same command**. A red suite has been pushed once by
  running the check and the commit without gating between them; do not repeat it.
- **`node --test` needs the escalation.** In a confined shell it fails with `spawn EPERM` because the test
  runner spawns one child per file. Inside the plugin's own verification spawn it works fine.
- **The public surface is frozen.** `plugin/tests/oracles/public-surface.test.cjs` records 64 named exports
  and the default object's 45 keys. Every moved symbol that was public must stay public via a re-export in
  `index.ts`. That contract is what makes this refactor verifiable rather than hopeful.
- **Additions are free, losses are not.** The surface contract asserts presence, not equality.

## What done looks like

`index.ts` small enough to be injected into the worker — under roughly 20,000 tokens, so ~70 KB — with every
module independently readable, and all oracles plus unit tests green. The immediate signal is in
`docs/ROADMAP.md`, and the honest framing of the whole design is in `README.md`.
