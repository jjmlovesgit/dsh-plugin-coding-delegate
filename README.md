# DSH Coding Delegate

> **A preventive control: the metered model cannot author code, and every delegation leaves a hashable
> verdict.**

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that separates **who specifies** work
from **who implements** it, and refuses to let the first party write the second party's code. It is a
technical control, not a policy: enforcement happens in a tool-call hook before a write lands, so it does
not depend on the model choosing to comply.

Why that is worth anything, stated without a benefit claim: the usual arrangement is one model writing the
tests and the code and then grading both. This plugin makes the specification an artifact that is hashed
before implementation and re-hashed after, so a passing verdict means *the specification, unmodified,
passed against the implementation* — and that is checkable after the fact from a local record.

> **Status: 0.1.0, a personal project.** The mechanisms work and are tested. Its **limits are documented
> rather than glossed**, including two that cannot be closed from inside the process — see
> [What this control does not cover](#what-this-control-does-not-cover). Read that section before deciding
> whether it fits your situation.

## What it does

Five things, in the order they act:

1. **In-process, no sidecar.** No daemon, no extra port, nothing to supervise. The gate and the
   authorship guard run inside the plugin.
2. **A DLP gate on every outbound request.** Prompts are scanned for credentials and high-entropy tokens
   before the cloud sees them. A hit is refused or rerouted to the local worker, never transmitted. The
   gate accumulates the user messages it has seen, so a credential from an earlier turn keeps it closed
   instead of scrolling out of view.
3. **A code guard, in both directions.** Cloud-authored writes *and deletions* of source are denied or
   sent for approval — and so is reading back a file the worker wrote, since that pulls delegated code
   into the context delegation exists to keep it out of. Shell forms are covered, including inline program
   text (`python -c`, `node -e`).
4. **`delegate_worker`.** A tool the architect calls to hand one unit of implementation to a local
   OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp, a remote gateway). File writes are
   contained to the workspace, verification output is redacted to structure before it travels, and the
   verification command itself requires approval.
5. **A unit is judged, not reported.** The contract is pinned with `contractFiles` — hashed before the
   worker runs, refused as a write target, re-hashed afterwards, so a change voids the verdict — and a unit
   that writes files without verifying reports `UNVERIFIED`. A whole-file emission may **create** a file and
   may not **modify** one. Then `coherenceVerification` runs the project's own command, with the power to
   void a unit whose own tests passed while the tree did not.

## What this control does not cover

An effectiveness statement is part of a control, not an appendix to it. These are the limits, and they are
the reason to read this file rather than the feature list.

- **It prevents writes, not intent.** The guard sees tool calls and shell text. Source a model produces in
  conversation, in a computation, through a second tool path, or through any plugin or MCP server outside
  this one is invisible to it. This is a scope boundary, not a defect, and it means the control's coverage
  is **this plugin's write paths** rather than "the model did not write code".
- **The recorder and the recorded run in the same process.** The guard, the worker and the ledger all live
  inside one DSH process, so the record below is evidence of what happened, not proof that nothing else
  did. Hashing constrains the *worker* well; nothing here constrains the *recorder*. Closing this needs an
  external sink that the process cannot reach back into, which is outside this plugin.
- **It does not make coding cheaper, more private, or longer.** This plugin was originally justified by
  those three claims. Each was tested and each failed; the measurements are in
  [Retired claims](#retired-claims-and-why) rather than deleted, because a control whose author has
  published its disconfirming evidence is more useful than one with a clean feature list.
- **The guard is not precise.** A shell command naming a directory that *contains* a delegated file is
  refused even when it only lists names, and a delete verb combined with a source filename anywhere on the
  same line is refused even when the target is unrelated. Both fail closed — the cost is that ordinary
  housekeeping stops working once a delegation has landed. Tracked, not yet fixed.
- **The audit record covers delegation, not everything.** The ledger's architect-side counters
  (`totalCloudTokens`, `architectTurns`, `totalSpendUSD`) are structurally zero: the host events that would
  feed them do not carry usage. What the metered model *read* is recorded in a `SOURCE_READ` trace, which
  is a log file rather than a tracked record. So the trail answers "what was delegated and how did it
  resolve" and is silent about the rest.
- **Nothing here is tamper-evident.** The registry and ledger are plain local JSON. Anyone with write
  access to the data directory can edit them.

## Retired claims, and why

Every row was measured on this repository's own work. They are kept because a control's credibility comes
from what it discloses, and because each one is a trap for the next person building something similar.

| claim | what the measurement said |
| --- | --- |
| *"Your plan is for thinking, your GPU does the typing"* | True as a mechanism, and close to worthless as a saving. Across 329 delegations the architect was billed **666,756,560** input tokens; the local worker's entire output was **548,106** — **0.08%** of the bill. Delegation cannot meaningfully reduce a total it contributes 0.08% to. |
| *"Runs on your machine, so it's private"* | **Refuted.** The architect must read source to engineer against it, and everything it reads is re-sent on every later turn — measured at ~8.5 read events per turn. What stays local is the typing, not the knowledge of what is being typed. |
| *"Local routing saves money"* | **Refuted, and never claimed at the bottom of the file.** The delegated output is worth **$0.1047** of cloud-equivalent; the hardware payback is roughly **19,000×** this workload. |
| *"Capacity, so the plan lasts"* | **Unsupported.** Session length is set by the context window filling, and that is dominated by the architect's reading, which the plugin does not reduce. Measured evidence that it extends sessions: none. |
| A third tier would read the repository locally and keep the architect out of the code | **Built, measured, retired.** The tier's window did not fit; a per-model reasoning setting could not be overridden; offloading typing recovered far less than the reading it gave back; no lead-authored contract was ever dispatched and verified. The split of `src/index.ts` has since retired the first of those four, so the decision rests on the other three. See [`docs/ROADMAP.md`](docs/ROADMAP.md). |

The general lesson, which outlives this plugin: **you cannot cut a session's metered cost by changing who
types. You cut it by changing what the planning model has to hold.** Any architecture premised on the
writing being expensive has the wrong cost model.

## The evidence trail

What a reviewer can check after a delegation, all of it local:

| record | what it answers |
| --- | --- |
| `contractFiles` hashes, before and after | was the specification modified while implementing it? A change voids the verdict (`CONTRACT_MODIFIED`) |
| the delegated registry | which files a unit wrote, their sha256, whether it **created** or **patched** them, and the verdict with its timestamp |
| the savings ledger | every delegated call: tokens, duration, outcome |
| `SOURCE_READ` trace | what source the architect read, with path, range and hash |
| `CONTEXT_QUALITY` trace | per-call prompt size, peak, compactions, tokens reclaimed, and the route those figures belong to |

**A verdict is one of four, not two.** `UNIT_PASSED`, `UNIT_FAILED`, `UNIT_UNVERIFIED`,
`UNIT_FLAKY` — an edit delegated without a verification command is the common case and is neither a pass
nor a failure, so counting it as a failure would corrupt the very number it exists to produce. A file a
*passing* unit left unchanged reads back silently; failed, unverified, flaky and since-edited ones ask.

`UNIT_FLAKY` exists because a **non-deterministic oracle** — a property test, a concurrency harness —
could otherwise pass a broken implementation on the run where the defect did not trigger, and a passing
verdict is what *settles* a file. **`runVerification` runs three times by default**: three agreeing runs
prove the contract stable, and any disagreement is recorded as flaky — not a pass, not settled, and naming
the oracle rather than the code. That is the one false green this control could previously emit, and it was
silent.

The three-fold cost is deliberate and worth knowing before you measure anything. A suite you have measured
as deterministic can pass `verificationRepeats: 1` to get the time back; the fast path is the one that
requires a decision. The loop short-circuits only on *disagreement*, because that is the one result running
more cannot change — so a flaky unit costs two runs, and a clean pass or a clean failure costs all three.

## How it works: a contract out, a verdict back

Coding needs two different jobs done, and they want two different contexts. The plugin gives each one its
own window and lets exactly two things cross between them.

**The architect** is the metered thinking model. It holds the design conversation, decides how the work
decomposes, and writes a **contract** for each unit: what to build, where the worker may write, and the
command that decides whether the unit passed. It does not write source, and it does not read source back.

**The worker** is whatever your GPU is already running. It receives one unit and everything that unit
needs — nothing else — writes the code, and is discarded. A fresh context per unit costs nothing.

| Direction | What crosses | What never crosses |
| --- | --- | --- |
| architect → worker | the contract: instruction, permitted paths, the verification command | the design conversation, the other units |
| worker → architect | the verdict: pass/fail counts, a redacted failure structure, the names of files written | the code |

The verification command runs as an ordinary subprocess, with the operator's approval. Its raw output
stays on the local machine; what travels back is the failure *structure*, with source stripped out.

## The policy

**The architect may reason but not author. The worker may author but not stray. Neither may execute
without consent. And source does not leave the machine.**

Every rule here is an instance of that sentence — except rule 8, which is about where source may travel
— and every one fails closed: if a rule cannot be evaluated, or the approval service cannot be reached,
the answer is no.

| # | Rule | Enforced by |
| --- | --- | --- |
| 1 | A credential may not reach the cloud | DLP gate: refused, or pinned local |
| 2 | The architect may not author or delete source | code guard: denied, or approval-gated |
| 3 | The architect may not read back what it delegated | the **settled rule**: a file a passing unit left unchanged reads silently, and failed, unverified and since-edited ones ask; `delegateReadPolicy: 'allow'` relaxes all of it, for every agent, and says so |
| 4 | The worker may not write outside the workspace | containment on every emitted path |
| 5 | The worker's code may not run inside the server | subprocess only; in-process fallback off |
| 6 | A command the architect proposes may not run unchecked | approval seam |
| 7 | A delegated result is a verdict, not a claim | files written without verification report `UNVERIFIED` |
| 8 | Source may not reach the cloud | cloud-bound requests carrying fenced source are refused by default; `sourceEgress` decides |

Rule 8 is a heuristic and it has a hole: it looks for fenced blocks with a source language tag of at least
three lines, so source pasted without a tag, described in prose, or split across short blocks is not
detected. It is also the one rule that can refuse a request you typed yourself.

## Requirements

- **Node.js 22+**
- **A local OpenAI-compatible server** if you want local routing or `delegate_worker`
  (LM Studio on `127.0.0.1:1234` by default; anything else via `localEndpoint`)
- **A cloud provider** for the architect role (DeepSeek by default)

**No container runtime is required.** Verification runs as an ordinary child process. A container
is optional hardening — see [Verification](plugin/README.md#verification-runs-as-a-subprocess--a-container-is-optional-hardening).

## Install

The plugin lives in `plugin/`. DSH loads a profile bundle, so register it into the profile you use:

```powershell
# The CLI profile is `web`; the desktop app boots `tauri`.
.\scripts\register-plugin.ps1 -Profile web
```

Or by hand, which is all the script does:

```bash
dsh plugin --profile <name> add ./plugin
# then add "dsh-plugin-coding-delegate" to dsh.profile.bundles in
# ~/.dsh/profiles/<name>/package.json
```

## Configure

The plugin's own defaults point at LM Studio on `127.0.0.1:1234` with `qwen/qwen3.8-27b`. Override
them in your profile's `cordis.patch.yml`; `plugin/cordis.patch.example.yml` is a complete, worked
example covering the plugin settings, an LM Studio provider and a DeepSeek provider.

The two settings people most often need:

```yaml
- id: local-router
  config:
    localModel: 'Qwen/Qwen3-Coder-30B-A3B-Instruct'
    localEndpoint: 'http://192.168.1.50:8000/v1'   # vLLM, Ollama, llama.cpp, a gateway
```

**One setting decides whether a unit can verify itself.** A delegated verification command is refused
unless the program is allowlisted or approval is granted, and that is operator configuration rather than
a tool argument — deliberately, so a model cannot switch it off:

```yaml
    verificationAllowlist: ['node']   # a delegated `node …` command runs unattended
```

It matches the **program, not its arguments**, so allowlisting `node` also allows
`node -e "<anything>"`. Prefer it over `verificationApproval: 'allow'`, which is strictly wider.

**Full configuration reference, provider setups and every security key: [`plugin/README.md`](plugin/README.md).**
It is the real documentation; this file is the summary.

## A first unit

Delegation is one tool call from the architect's side. A unit declares what to build, which files it may
touch, what to show the worker, and the command that decides whether it passed:

```json
{
  "taskName": "parse-iso-duration",
  "instruction": "Implement parseIsoDuration(text) in src/duration.ts. Return milliseconds; throw a TypeError on malformed input.",
  "targetFiles": ["src/duration.ts"],
  "contextFiles": [{ "path": "src/duration.ts", "startLine": 1, "endLine": 40 }],
  "contractFiles": ["tests/duration.test.ts"],
  "runVerification": "npx vitest run tests/duration.test.ts"
}
```

The code never comes back. The verdict does — illustrative, but every field name and phrasing below is what
the plugin actually prints:

```
Task 'parse-iso-duration' completed. Wrote 1 file(s):
  - src/duration.ts (84 lines, 2410 bytes, patched in place with 1 hunk(s))
Workspace: C:\Projects\app (resolved via caller-supplied workspaceDir)
Verification Results: Passed 12, Failed 0.
Coherence check: Passed 305, Failed 0.
Contract: 1 declared file(s), unchanged.
```

Read that as four claims, because they are checked separately:

- **`Wrote 1 file(s)`** — the emission landed, inside the workspace, and only at a path the unit declared.
- **`patched in place with 1 hunk(s)`** — the worker edited the file it was shown rather than replacing it.
  That verb is the boundary: a whole-file emission may create a file, never modify one.
- **`Passed 12, Failed 0`** — your verification command passed. Nothing about it is taken on trust; the
  command itself was approved, and `Coherence check` is the project-level gate that can void the unit even
  when its own tests passed.
- **`Contract: 1 declared file(s), unchanged`** — the test that judged the unit is byte-identical to the one
  you pinned. If it were not, the verdict would be void.

What is *missing* from a receipt is the finding. A unit that writes files without verifying reports
`UNVERIFIED`; one whose tests passed while the tree did not reports `INCOHERENT`. Neither is `SUCCESS`, and
neither is reported as one — a delegated result is a verdict, not a claim.

## What this does not claim

- **A patch must match exactly, and a stale one fails.** The worker returns either a whole file or a
  search/replace delta matched byte-for-byte against what it was shown. There is no fuzzy matching, so a
  miss is refused rather than approximated. Nothing here lets the worker *discover* code; it only ever
  edits what it was given.
- **A whole-file emission creates; it does not modify.** Writing over a path that already exists is refused,
  however large the new content is. A whole file can still be replaced wholesale, by sending a patch whose
  search text is its entire current content — which requires the architect to inject that content, because
  the worker cannot read it.
- **The read guard cannot tell one agent from another.** DSH does not expose agent lineage to plugins, so
  the guard fails closed for every agent rather than distinguishing the architect from a subagent. What an
  agent *is* no longer decides what it may read — the settled rule does.
- **A delegated unit cannot verify itself from inside a subagent.** DSH pins a child agent's
  `approvalPolicy` to `'never'`, so the approval seam is absent and the verification is refused
  deterministically. Self-verifying delegations need a top-level session. Measured, and it is not this
  plugin's to override.
- **It does not make a local model as capable as a cloud one.**
- **Provider transport, tool-schema enforcement and session storage live in DSH, not here.**

## Repository layout

| path | what it is |
| --- | --- |
| [`plugin/`](plugin/) | the plugin, its tests and its full documentation |
| [`experiments/delegation-ab/`](experiments/delegation-ab/) | the A/B protocol that produced the retired claims, including the run that could not be taken and why |
| [`experiments/contract-first/`](experiments/contract-first/) | an unsatisfiable contract preserved as evidence, and its corrected sibling |
| [`docs/findings.md`](docs/findings.md) | defects found, with what each one cost |
| [`docs/experiment.md`](docs/experiment.md) | measurements, including the ones that undercut the plugin |
| [`docs/control-effectiveness.md`](docs/control-effectiveness.md) | the five-point design against what is actually enforced, tested, or only documented |
| [`docs/verification-architecture.md`](docs/verification-architecture.md) | why the loop has to put verification on-box, and the one tier where that reasoning breaks |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | what was built, measured and retired |

## Development

```powershell
cd plugin
npm run build          # tsc
npm run test           # vitest, unit
npm run test:oracles   # node --test, contract oracles
npm run test:all
```

At the repository root:

```powershell
node scripts/check-readme-consistency.cjs   # the two policy tables must agree
node scripts/check-dist-in-sync.cjs         # rebuilt dist must be staged
node scripts/check-contract.cjs --spec      # specification-conformance suite
```

## Security

The plugin was reviewed externally, and the response to that review — including the defects found
and left unfixed, with reasons — is in [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md).

## License

MIT — see [`LICENSE`](LICENSE). The package carries its own copy at [`plugin/LICENSE`](plugin/LICENSE),
because the published artifact is standalone.
