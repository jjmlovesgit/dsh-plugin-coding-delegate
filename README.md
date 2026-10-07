# DSH Coding Delegate

> **Your plan is for thinking. Your GPU does the typing.**

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that decides where a request may
go by **permission rather than preference**: a credential is not permitted to reach the cloud, the
cloud model is not permitted to author source code, and everything beyond those rules is the
architect's explicit choice to delegate or not.

Why it matters: on a metered plan the scarce resource is frontier tokens, and reading code is what
spends them. Routing code work to a local model keeps that allowance for the work only a frontier
model can do, so the plan lasts instead of timing out. That is a **capacity** claim, not a cost one —
see [What this does not claim](#what-this-does-not-claim).

> **Status: 0.1.0, a personal project.** It works and is tested, but the API is not frozen and
> the honest limits are documented rather than glossed. See
> [What this does not claim](#what-this-does-not-claim).

## How it works: a contract out, a verdict back

Coding needs two different jobs done, and they want two different contexts. The plugin gives each one
its own window and lets exactly two things cross between them.

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

**The architect does not pay for the code it delegates.** Diffs never cross back — a verdict comes
instead — and that is the claim. It is *not* the same as a flat window, and saying so would be the wrong
claim: the architect reads code in order to engineer a change, and anything it reads is re-sent on every
later turn. Reading is the dominant cost of a long session, not typing. So the discipline is to read
narrowly, read late, and prefer the verdict you already have over opening the file.

### Why that matters over a long task

Everything that degrades a long agentic session degrades it *because code entered the window*:

- **Attention dilutes**, because design intent is left competing with thousands of lines that have
  nothing to do with the next decision.
- **Compaction is lossy**, and it summarises away precisely the specifics that mattered. Keeping code
  out is prevention; compaction is cure, and cure arrives after the budget is spent.
- **The session drifts**, as a context that is mostly code starts contradicting decisions it made when
  it was mostly design.
- **Restarts lose state**, because window exhaustion forces a new session and the accumulated design
  goes with it.

Typing is the highest-volume, lowest-judgement activity in coding. Segmented this way, the frontier
model spends metered tokens on the two things only it can do: deciding what the work is, and deciding
whether a verdict means done. That is a **capacity** claim, not a cost one — see
[What this does not claim](#what-this-does-not-claim).

### What the loop does not close yet

Stated plainly, because these limits decide whether it fits your work:

- **The worker cannot discover, but it can be shown.** It has no repository read, so it will never find
  the file it needs. Declare `contextFiles` and the plugin reads them into its prompt — so a unit closes
  on existing code without that code entering the architect's window — and the worker answers with a
  whole file or a search/replace delta, so it need not return a large file in one piece. What is still
  missing is **cross-unit coherence**: nothing decides which files a unit needs, and nothing checks that
  two units agree.
- **The architect is not blind, and claiming otherwise was wrong.** It reads source to engineer, and
  every read is re-sent on every later turn. Reading is what costs: a 7,300-token module read once and
  carried for fifty turns is roughly **365,000 input tokens** — more than twice all the typing in this
  project's history, which is about 159,000. The plugin does not gate that reading; it **records** it, in
  the `SOURCE_READ` trace, so the choice is visible rather than assumed.
- **A third tier was built, measured, and retired.** A local thinking model was meant to read the
  repository and author each contract, keeping the architect out of the code entirely. It was retired on
  four measurements: the tier's window did not fit, LM Studio's per-model reasoning setting is
  authoritative so it could not be made to think, offloading typing recovers far less than the reading it
  gives back, and no lead-authored contract was ever dispatched and verified. The split of `src/index.ts`
  has since retired the *first* of those four — every module now fits that window — so the decision now
  rests on the other three. The measurements, and which of them still hold, are in
  [`docs/ROADMAP.md`](docs/ROADMAP.md).
- **The contract is signed, and the worker cannot touch it.** `contractFiles` are hashed before the
  worker runs, refused as emission targets, and re-hashed afterwards, so a change voids the verdict. A
  passing result therefore means the architect's tests, unmodified, passed against the worker's code.
- **Coherence is still the architect's job.** The plugin enforces the boundaries between the roles; it
  does not supply the judgement. Work that is locally correct and globally inconsistent is the usual
  failure mode of splitting work up, and splitting it here does not remove it.

> The mechanism above is well established — attention dilution and lossy compaction are properties of
> how these models and harnesses behave. What this plugin reports is the **harness's own accounting
> rather than a proxy**, written to a `CONTEXT_QUALITY` trace line: turns, steps, compactions, model-free
> prunes, failed compactions, **tokens reclaimed** (DSH's `shadowedTokenCount` on `compaction/summary`
> and `compaction/prune`), and the **prompt the model actually received, per call**, with its high-water
> mark and the route's advertised window (from the provider's `usage` on `assistant/message` — summing
> `inputTokens` **and** `cacheReadTokens`, because `inputTokens` alone is only the uncached remainder and
> reading it as the window understates a full one by orders of magnitude).
>
> Two things worth stating plainly. The counters are **process-scoped, not lifetime-of-session**: DSH
> does not publish events that entered through replay, fork, or resume, so a resumed session counts from
> the resume — it under-reports, and that is the honest reading of what the firehose can answer.
> And the **route travels with the window figures** because "frontier tokens" is only a checkable claim
> if it says which model produced the number: with the default two-tier configuration every session call
> is the architect's, and with a lead tier configured it is whichever model the session is pinned to.

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
| 3 | The architect may not read back what it delegated | reads of worker-written files need approval; `delegateReadPolicy: 'allow'` relaxes this for every agent, and says so |
| 4 | The worker may not write outside the workspace | containment on every emitted path |
| 5 | The worker's code may not run inside the server | subprocess only; in-process fallback off |
| 6 | A command the architect proposes may not run unchecked | approval seam |
| 7 | A delegated result is a verdict, not a claim | files written without verification report `UNVERIFIED` |
| 8 | Source may not reach the cloud | cloud-bound requests carrying fenced source are refused by default; `sourceEgress` decides |

## What it does

Four things, in the order they act:

1. **In-process, no sidecar.** No daemon, no extra port, nothing to supervise. The gate and the
   authorship guard run inside the plugin.
2. **A DLP gate on every outbound request.** Prompts are scanned for credentials and
   high-entropy tokens before the cloud sees them. A hit is refused or rerouted to the local
   worker, never transmitted. The gate accumulates the user messages it has seen, so a credential
   from an earlier turn keeps it closed instead of scrolling out of view.
3. **A code guard, in both directions.** Cloud-authored writes *and deletions* of source are denied
   or sent for approval — and so is reading back a file the worker wrote, since that pulls the
   delegated code into the very context the delegation kept it out of. Shell forms are covered,
   including inline program text (`python -c`, `node -e`).
4. **`delegate_worker`.** A tool the architect calls to hand one unit of implementation to a local
   OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp, a remote gateway). File writes are
   contained to the workspace, verification output is redacted to structure before it travels, and the
   verification command itself requires approval. The worker has no repository read, so it only ever sees
   what the architect declares with `contextFiles`, and it answers with a whole file or a search/replace
   delta.

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

**Full configuration reference, provider setups and every security key: [`plugin/README.md`](plugin/README.md).**
It is the real documentation; this file is the summary.

## Security

The plugin was reviewed externally, and the response to that review — including the defects found
afterwards, the live verification run, and what remains out of scope — is in
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md).

Two properties worth stating plainly:

- **Approvals are real.** A gate that auto-admits is decoration. The approval seam was verified to
  prompt for a human decision, with 1.9–3.1 s decision latencies in the session audit and no
  `auto` preset active.
- **The guard is a deterrent, not a boundary.** It mediates tool calls and shell text. A path
  computed at runtime, a mutation inside a library, and code written into prose are all outside it.

## Repository layout

```
plugin/                     the publishable package (src, dist, tests, README, LICENSE)
plugin/tests/oracles/       regression oracles: guard, DLP, redaction, containment, verification
plugin/cordis.patch.yml     registers the plugin; ships no provider or model config
plugin/cordis.patch.example.yml  a complete configuration example, NOT applied automatically
scripts/register-plugin.ps1 registers the plugin into a DSH profile
SECURITY-REVIEW.md          review findings, remediation, and limits
```

## Development

```bash
cd plugin
npm ci
npm run build          # tsc -> dist
npm test               # unit tests (vitest)
npm run test:oracles   # regression oracles (node:test)
npm run test:all       # both
```

`dist/` is committed because DSH loads `dist/index.js`. CI rebuilds and fails if the committed
`dist` has drifted from `src`.

## What this does not claim

- **A patch must match exactly, and a stale one fails.** The worker returns either a whole file or a
  search/replace delta matched byte-for-byte against what it was shown. There is no fuzzy matching, so a
  miss is refused rather than approximated — if the code changed after the worker was given it, the
  edit fails and the unit is re-delegated. Nothing here lets the worker *discover* code; it only ever
  edits what it was given.
- **The read guard cannot tell the architect from a lead.** Until the host says which agent is which,
  `delegateReadPolicy: 'allow'` is the only way to let a lead read the code it writes contracts about,
  and it grants that to every agent. That is a deliberate weakening of rule 3 with the cost written
  down, not a boundary.
- **Rule 8 is a heuristic, and it has a hole.** It looks for fenced blocks with a source language tag of
  at least three lines. Source pasted without a language tag, described in prose, or split across short
  blocks is not detected. It is also the one rule that can refuse a request you typed yourself, which is
  why `sourceEgress` exists: `deny` (default), `ask`, or `allow`.
- The guard sees tool calls and shell text, not intent. Runtime-computed paths and library-mediated
  writes are invisible to it; configuration files are out of scope.
- The DLP gate scans the user messages the plugin has seen — not assistant output or tool results —
  and pattern-plus-entropy matching cannot recognise confidential material that looks ordinary.
- Local routing does **not** save money. The GPU is a fixed cost this plugin neither pays for nor
  reduces, and a local card will not pay for itself against a metered plan. What is preserved is the
  plan's allowance: metered tokens stay for the work only a frontier model can do, instead of being
  spent reading code.
- It does not make a local model as capable as a cloud one.
- Provider transport, tool-schema enforcement and session storage live in DSH, not here.

## License

MIT — see [`LICENSE`](LICENSE). The package carries its own copy at [`plugin/LICENSE`](plugin/LICENSE),
because `plugin/` is what gets published and a tarball without a licence file is a tarball without a
licence.
