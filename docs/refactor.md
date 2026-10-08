# Refactor: splitting `plugin/src/index.ts`

Operational note for whoever picks this up, including a fresh agent with no prior context.

> **Status: complete.** Every module in the queue below is out. `plugin/src/index.ts` is **53,531 bytes
> ≈ 13,383 tokens**, from 149,337 bytes ≈ 37,000 — inside the worker's 32,768-token window for the first
> time, which was the whole point. The round-by-round record, the measured done-condition, and the
> method learned along the way are in [`refactor-complete.md`](refactor-complete.md). Read this file for
> the *method*; read that one to see how it went. The queue below is kept as the order that worked, not
> as work outstanding.

## Why this existed

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

In dependency order, roughly decreasing cohesion. **All eight steps are done**; the list is kept as the
order that worked, with the deviations noted.

1. **`emission.ts`** — `evaluateEmissionPath`, `extractAndEmitFiles`, the emission-result types. **Done.**
   `evaluateContextRequest` turned out not to exist; the patch engine was left behind and injected via
   `configurePatchEngine` to avoid a cycle.
2. **`verification.ts`** — `captureCommandOutput`, `runSandboxVerification`, `parseTestOutput`,
   `redactVerificationOutput`, `describeFailures`, `persistRaw`, `evaluateVerificationPolicy`.
   **Done.** `resolveVerificationPolicy` and `requestApprovalForVerification` stayed in `index.ts` — the
   policy source and the approval seam, and the former takes `PluginConfig`.
3. **`contracts.ts`** — the durable delegated-path registry (`resolveDelegatedRegistryPath`,
   `parseDelegatedRegistry`, `mergeDelegatedRecords`, `pruneDelegatedRecords`, `saveDelegatedRegistry`,
   `loadDelegatedRegistry`, `rememberDelegated`), `sha256File`, `resolveContractFiles`,
   `contractFileHashes`, `contractViolations`. **Done.** `resolveDelegateStatus` went to
   `delegation.ts` instead — it is verdict precedence, not a contracts concern.
4. **`context.ts`** — `resolveContextFiles` and its types. **Done**, and moved verbatim: the only cut
   small enough for one emission.
5. **`guard.ts`** — `evaluateCodeWriteGuard` and its helpers. **Done**, as three edits landed together,
   because the guard and roles blocks are interleaved in the file.
6. **`roles.ts`** — the role decision and config layer, `describeSourceRead`, source-egress policy.
   **Done.** `lead-tier.md` and `source-egress` work moved with it.
7. **`delegation.ts`** — `delegateWorker`, the search/replace patch parser, `DELEGATE_WORKER_*_SCHEMA`,
   `extractPromptText`, `estimateTokenCount`. **Done**, and `configurePatchEngine` moved in with it.
8. **`index.ts`** — `apply`, the hooks, tool registration, and the re-exports. **This is the endpoint,
   not a step to finish**: what remains in the file is exactly what belongs there.

The predicted eighth pass for `LocalRouter` / routing and the DLP rules in `index.ts` was **not taken**.
`index.ts` is at 53,531 bytes against the ~70 KB target, so it is not needed for the stated goal; see
[`handoff-contracts.md`](handoff-contracts.md) for the note on `scanDLP` if anyone picks it up.

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
  cd plugin
  npm run build
  npx vitest run
  npm run test:oracles
  cd ..
  git add <the source files, and plugin/dist>
  node scripts/check-dist-in-sync.cjs
  git commit
  ```

  Run it and gate the commit on the exit code **in the same command**. A red suite has been pushed once by
  running the check and the commit without gating between them; do not repeat it.

  The artifact step is not redundant with the build. `plugin/dist` is versioned, so the suite is green
  whether or not the rebuilt artifact was *staged*, and a fix has already been committed with its
  `dist/guard.js` left dirty. `scripts/check-dist-in-sync.cjs` compares the working tree against the
  **index**, which is the question a pre-commit gate can act on: is every rebuilt artifact staged? It
  compared against `HEAD` at first, and that is unsatisfiable before the commit — a correctly rebuilt dist
  always differs from `HEAD` until it is committed — so it failed the first time it was run in this order.
  It also resolves the repository root from its own location rather than trusting the cwd, because run from
  `plugin/` it used to resolve `plugin/dist` to `plugin/plugin/dist`, match nothing, and report success for
  a tree it had never looked at: a gate that passes by looking at nothing is worse than no gate.
- **A `runVerification` string runs under `cmd.exe`, not PowerShell.** The block above is what *you* run in the
  session shell. A verification string handed to `delegate_worker` goes to the plugin's runner, and the
  runner's shell is `cmd.exe`, so a PowerShell-flavoured string fails without running: `Select-Object` is not a
  command, `;` does not separate statements, and `$?` is not a variable. It exits 255, verifies nothing, and
  leaves a real-looking `UNIT_FAILED` behind — **five of the six such records in the registry came from exactly
  this** (see `findings.md`; the sixth is a genuine failure). Write verification strings as plain commands
  joined with `&&`, and make every path in it absolute, because the command runs with `cwd` set to the
  delegation's own workspace. A relative `cd plugin` resolved against whatever workspace the unit targeted:
  every delegation into `experiments/` reported `INCOHERENT` while its own contract passed, which reads as a
  unit failure when the unit is fine. Measured — the relative form exits 1 from `experiments/contract-first`,
  `cd /d C:\Projects\DSHLaya\plugin && …` exits 0 with the full gate green. The profile carries the absolute
  form, and it is live-verified: after the restart, a delegation into `experiments/contract-first` reported
  `SUCCESS` with `Coherence check: Passed 313, Failed 0` where the relative form had reported `INCOHERENT`.
- **Run the oracles as `npm run test:oracles`, never as a bare `node --test`.** That script carries a
  `--require` preload (`plugin/scripts/isolate-oracle-data-dir.cjs`) which redirects the plugin's data
  directory to a temp home. `vitest.config.ts` covers the unit tests, but `node --test` never loads it, so a
  bare invocation writes test fixtures and ~19 KB of trace output into the operator's live
  `~/.dsh/local-router/router-debug.log` — the file `docs/live-verification.md` is built by reading. A
  per-file redirect was tried first and covered only 7 of 28 oracles. `scripts/check-oracle-isolation.cjs`
  is the contract check that keeps this honest.
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
