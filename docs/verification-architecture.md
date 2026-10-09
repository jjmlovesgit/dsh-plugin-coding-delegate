# Verification architecture: what the loop has to be, and where it breaks

A mentor's critique of standard hybrid architectures, mapped against what this repository measured. Its
value is that it gives the plugin a theoretical spine it was missing: the architecture below is right, and
the plugin implements it — what failed were the capability claims bolted on top, not the structure.

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

An architecture can be correct on paper and unreachable in the harness that hosts it. That is the same
dilemma as "Copilot falls back to Azure", one layer down.

## Where the critique is optimistic

**§2 assumes the cloud can verify intent from contracts without seeing the implementation. The checking
is fine — a frozen judge is deterministic. Authoring the contract is not, and that is where it breaks.**

[`experiments/contract-first/`](../experiments/contract-first/) preserves the counterexample: a contract
written by an architect that could not see enough of the implementation, which **no correct
implementation could pass**. It is retained as evidence, with its corrected sibling beside it. A
code-blind architect does not degrade gracefully; it produces a confident, unsatisfiable specification.

The same limit showed up in the aggregation-window task, where an ambiguity in `SPEC-2.md` was resolved
by a comment in the judge rather than by the specification — because its author could not see the shape of
the thing being specified.

A second, quieter assumption: `public interface exported matching IDataPipeline` presupposes the boundary
is **machine-checkable**. True for a typed interface or a schema; mostly false for a function's
behaviour, where the only machine-checkable contract *is* the test suite — which the cloud had to author
without seeing the code. So the tiering that holds is:

| job | where | decided by |
| --- | --- | --- |
| deterministic execution | local sandbox | compilers, tests, linters |
| semantic assertion | contract, hashed | a frozen judge, pass/fail |
| **contract authoring** | **frontier** | **judgement, with real quality risk** |

The critique has no box for the third row. It is the tier that decides whether the architecture works, and
it is the one this project has the most evidence about.

## The gap that remains

The architecture holds for the **implementation** and not for the **specification**. The architect still
reads the repository in order to author a contract at all, and that reading is where this project's
**666.8M** architect input tokens went — against the worker's **548,106**, or **0.08%**.

So the honest position is: keep the implementation out of the cloud by construction, which the loop
achieves and this repository demonstrates; and be explicit that the specification still requires the
architect to read, which is where the cost and the exposure actually live.

Whether that gap is closable — contract authoring from interfaces and a code map rather than source — is
the experiment worth running next, and the one this project has never attempted.
