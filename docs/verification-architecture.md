# Verification architecture: what the loop has to be, and where it breaks

A mentor's critique of standard hybrid architectures, mapped against what this repository measured,
plus the two objections it had to answer. Its value is that it gives the plugin a theoretical spine it
was missing: **the architecture is right and the plugin implements it — what failed were the capability
claims bolted on top.**

## The critique, in one paragraph

If verification requires the cloud model to read the code back in, hybrid buys nothing: the round-trip
costs the same tokens and exposes the same source. A local machine acting as a **dumb typist** while the
cloud reviews diffs, checks logic and validates changes leaves both problems unsolved. The fix is to
**decouple verification into deterministic execution (local) and semantic assertion (contract-based)** —
the cloud authors invariants and acceptance criteria, the sandbox runs compilers and tests, the local
worker repairs against raw failures, and only structured receipts cross back.

```
Cloud Frontier (Planner)     creates test contracts & invariants
        |
        |  sends NO source code up, only PASS/FAIL metrics
        v
Local Gateway / Sandbox      executes tests, compilers, linters, SAST
        |                    direct feedback loop, no cloud escalation
        v
Local Worker                 typist & repairer
```

That is a description of this plugin. `contractFiles` + `runVerification` + output redaction *is* that
data flow, and the receipt it already prints is close to the proposed format:

```
Verification Results: Passed 27, Failed 0.
Contract: 1 declared file(s), unchanged.
```

## What the measurements say

Taken from [`experiments/delegation-ab/PROTOCOL.md`](../experiments/delegation-ab/PROTOCOL.md), same task
and same frozen judge throughout.

### Deterministic verification belongs on-box — measured, and it is the largest effect

"Zero cloud escalation on syntax" is not an optimisation; it is the mechanism. Over one identical task:

| arrangement | architect's calls | architect ran the judge | architect's tokens |
| --- | --- | --- | --- |
| loop in the sandbox, contract carries the verdict | **1** | **0** | one delegation |
| architect running the judge itself | 24 | 5 | 1,050,313 |

Reading the trajectory call by call, the architect's own test loop cost **179,840 tokens (17.1%)**, and
the hashing, cleanup and reporting *around* a loop it had already run cost another **440,500 (41.9%)**.
The delegation itself — the thing the plugin exists to do — was the cheapest line item at **54,226
(5.2%)**, and the worker's whole contribution was **2,750 tokens against Run 1's 10,966**.

So an LLM eyeballing code is not merely inefficient as a verification mechanism. In this workload it was
the single most expensive thing the metered model did.

### Receipts instead of source — also measured

In the run where the loop closed, the architect received **a pass count and a hash** and never read the
implementation: 27/27 first attempt, `UNIT_PASSED`, contract unchanged. The delegated code entered the
cloud window **not at all** — confirmed from the trajectory, which contains no read of the module.

This is the honest form of the privacy claim, and it is much stronger than the one this project
originally made:

> The cloud is **never asked to read the implementation**. That is a property of the loop's structure, not
> a policy the model is trusted to follow.

### The failure mode is where the harness, not the model, decides

The critique's §3 is that commercial tooling treats the cloud as reviewer of record, re-uploading modified
files and defeating air-gap isolation. **The same shape appears here, in this plugin's own plumbing.**
Whether a delegated verification may run is decided by `verificationApproval` and `verificationAllowlist`
— operator configuration, deliberately not a tool argument, so a model cannot switch it off. And DSH pins
a child agent's `approvalPolicy` to `'never'`, so a delegated unit **cannot verify itself from inside a
subagent** — which is exactly the context `delegate_worker` creates. Measured: identical command,
`SUCCESS` from a top-level session and `VERIFICATION_NOT_APPROVED` four times from a subagent.

An architecture can be correct on paper and unreachable in the harness that hosts it.

## The Architect does not read the repository

**An earlier version of this document claimed that reading is irreducible — that a model cannot engineer
a change to code it has not seen. That was wrong, and the correction matters.**

A model cannot engineer a change to code whose **semantics** it has not seen. It does not need the
implementation lines. It needs the **boundary graph**: exported type declarations, interface definitions,
method signatures, call hierarchies and the module import/export map. A local static analysis pass —
TypeScript's own `--declaration`, Tree-sitter, an LSP — produces exactly that, stripping bodies, literals
and internal logic while preserving everything the architecture is made of.

```
// the worker sees                          // the architect receives
export async function processPayment(       export declare function processPayment(
  user: User, amount: number                  user: User, amount: number
): Promise<Receipt> {                       ): Promise<Receipt>;
  const token = await vault.sign(user.id)
  ...implementation...
}
```

The architect then knows which components call `processPayment`, the exact shape of `User` and `Receipt`,
and what depends on the boundary — which is what designing a contract requires. This is **inverted
ingestion**, and it converts "the architect must read the repo" from a cost and privacy problem into a
static-analysis problem that runs entirely on-box.

**This repository already has evidence for the stronger version of the claim.** In the run where the loop
closed, the architect authored a correct, satisfiable specification with **no code in view at all** — no
signatures, no skeleton, only prose requirements — and the implementation passed 27/27 first attempt. An
architect that can spec from nothing is strictly better off with a skeleton.

### The gap is structural versus semantic, not read versus unread

Skeletons serve **structural** change: refactoring within an existing boundary, adding a function that
fits, changing a type, wiring a consumer. They cannot express **semantic** defect — an off-by-one, a race,
an inverted comparison — because that has no signature. A signature of `processPayment` is silent on
whether it is correct, and a contract can only encode what somebody thought to assert.

That is the real boundary of the technique, and it is answered below rather than papered over.

## How a defect invisible at the boundary is still caught

**The architect's job is not to locate the defect. It is to specify the invariant that was violated.** A
bug report is a *counterexample to an unwritten invariant*.

1. **Symptom to property.** "Payments double-post under concurrent load" becomes: *given two concurrent
   requests with identical idempotency keys K, exactly one returns 200 and persists; the second returns
   the cached receipt or 409.*
2. **The architect writes the oracle, not the fix.** A property test or concurrency harness — the
   architect needs the domain model and the boundary graph, not line 42.
3. **The harness descends.** It executes locally against the real code and the failure materialises as a
   concrete, localised failure.
4. **Localisation is local.** Coverage, an execution-path recorder, `rr` or an eBPF probe reduces a
   500,000-line repository to the twenty-five lines that participated.
5. **The local worker repairs.** Reading a stack trace and a fifty-line method to see that `<` should have
   been `<=` is an execution-level task, not an architectural one. The architect never needs to know the
   off-by-one existed.

**Be precise about what crosses: no new information.** The invariant was always writable from the symptom;
it was unwritten. What the architect supplies is **rigour applied at the right moment**, not access it
lacked. That is real value — and it means the technique inherits the quality of the symptom it starts
from. "Payments double-post under concurrency" yields a clean invariant; "payments feel slow" does not.

## The verdict collision: where this architecture and this plugin disagree

Step 3 above assumes the failure materialises **deterministically**. For the concurrency example it often
does not. A race that triggers on one run in three produces an oracle that alternates.

This plugin's verdict model was a three-state taxonomy with no room for that:

| verdict | meaning |
| --- | --- |
| `UNIT_PASSED` | the contract was checked and passed |
| `UNIT_FAILED` | the contract was checked and failed |
| `UNIT_UNVERIFIED` | the contract was never checked |

**A flaky oracle poisoned all three.** Worse than failing to verify, it could produce a **false
`UNIT_PASSED`** on a run where the race simply did not trigger — and because a passing verdict is what
makes a file *settled*, that broken implementation was then promoted: readable, attributable, and citable
as verified work. The most dangerous output the control can emit, and silent.

**`UNIT_FLAKY` now exists**, and it is a property of the oracle rather than of the code:

- the caller declares `verificationRepeats` (default `1`, the pre-existing behaviour) when the contract
  is a non-deterministic oracle;
- the contract runs that many times, and **disagreement in either direction** produces `UNIT_FLAKY`;
- it is checked *before* the unit's own result, because reporting either `UNIT_PASSED` or `UNIT_FAILED`
  would pick one arbitrary run and present it as the verdict;
- it is **not** a pass, it does **not** settle the file, and the reason names the oracle rather than
  claiming the code failed.

Pinned by [`plugin/tests/oracles/flaky-verdict.test.cjs`](../plugin/tests/oracles/flaky-verdict.test.cjs)
against an oracle that alternates by run count — genuinely non-deterministic from the plugin's point of
view, while the test stays reliable. The cap on repeats is not cosmetic: each repeat is a real subprocess
with the host process's authority, so an unbounded count would be a denial-of-service lever through a tool
argument.

## The escape hatch that reads better than redaction

The critique names two ways out of the deadlock where an emergent coupling is invisible to the architect
and beyond the local model: **selective redaction** and **human escalation**.

Redaction is the weaker of the two. Renaming identifiers to `func_a` and `var_x` removes exactly the
semantic names a reasoner needs — this repository's own redaction machinery exists to strip source before
it travels, and the cost of that stripping is precisely lost specificity.

There is a third option, and it is inverted ingestion applied one level up: send **neither function
body**. Send an abstracted **protocol model** of each module — its states, transitions, and the
assumptions it makes about the other — with no source. That is what the architect needs to perceive an
emergent coupling, it is a design artifact rather than an excerpt, and nothing proprietary crosses. The
deadlock in §4 is real and is less dead than the critique concludes.

Human escalation remains correct for the residue: when a coupling cannot be expressed as either a
skeleton or a protocol model, the honest move is to flag the deadlock and hand a human the trace.

## Two experiments this implies, both cheap

### 1. Skeleton authoring — does the architect need more than the boundary graph?

Take a task that changes **existing** code. Generate the skeleton locally
(`tsc --declaration --emitDeclarationOnly`). Give the architect the skeleton and the task, nothing else.
Have it author the contract, then judge whether that contract is **satisfiable** by a correct
implementation.

- Pass → the boundary graph is sufficient, and the original cost and privacy claims become reachable
  rather than abandoned.
- Fail → measure *how* it fails, and whether a protocol model of the affected modules closes the gap.

The token side is already instrumented: `experiments/delegation-ab/measure-session.cjs` reads the
architect's real cumulative input out of the session transcript.

### 2. Convergence cycles — is the local worker the diagnostic engine?

Measure, per unit, how many delegations it takes to converge **with** `runVerification` running versus
with verification refused. `retryContext` already feeds failure locations back to the next attempt, so the
mechanism is wired and the quantity is countable from the ledger.

The one clean observation so far points the critique's way: with verification running, **one attempt**;
with verification refused, **four attempts and no convergence**. n=1, and cheap to extend.

## The gap that remains regardless

The architecture holds for the **implementation** and not for the **specification**. Even with a skeleton,
the architect reads type declarations and dependency topology, and on a very large repository that is
still O(n) per turn — better than source, not free. Targeted subgraph extraction around the change is the
version that scales, which is why the critique's emphasis on *dependency topology* rather than whole-tree
ingestion is the load-bearing part.

And on this project's own numbers: **666.8M** architect input tokens against the worker's **548,106**, or
**0.08%**. Skeleton ingestion attacks that number directly in a way delegation never did. That is the
experiment worth running next.
