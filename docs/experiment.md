# The experiment: an architect-authored contract for a module with internal structure

ROADMAP item 15. The first item in this project that tests the **premise** rather than the plumbing:
everything before it was infrastructure that had been argued for rather than exercised end to end.

The premise, from `README.md`: *your plan is for thinking, your GPU does the typing* — the architect
specifies, the local worker implements, the tree is judged by a contract the architect authored, and no
implementation code enters the metered context.

Artifacts live in [`experiments/contract-first/`](../experiments/contract-first/). They are an experiment,
not shipped code. The `src/ttl-cache.js` committed there is the rewritten module from step 5 — the one that
fails 11 of 14 — kept as evidence rather than repaired. The contract's sha256 is `561cf664…` and is the
same in every run above, which is Finding 2 stated as a hash.

## What was run

The target is a bounded TTL cache with LRU eviction and four counters — a module chosen for *internal
structure*: a store, a recency order, an expiry rule and a set of counters whose hard parts are the places
they meet. The architect wrote [`SPEC.md`](../experiments/contract-first/SPEC.md) (111 lines, prose and
interface only, no algorithm) before any implementation existed.

| # | step | outcome |
| --- | --- | --- |
| 1 | **Contract transcription** — worker given `SPEC.md` and nothing else | 216-line, 14-test suite written; sha256 `561cf664…` |
| 2 | **Implementation** — separate call, given `SPEC.md` only, `contractFiles` pinning the contract | **9 pass / 5 fail** |
| 3 | **Retry** — same unit, after the failure | wrote no file; and see Finding 1 |
| 4 | **Harness repair** — asked to fix the contract's own bug | returned the file **byte-identical** |
| 5 | **Mutation** — asked to make exactly one change | returned a **rewritten** 86-line module (was 129) |

## Finding 1 — the retry path handed the implementer the contract that judged it

This is the experiment's real product, and it is a defect in shipped code. **Fixed in `536dfe1`.**

A failing contract names itself, so a failure's location is *inside the contract file*. A2 turns failure
locations into the next attempt's injected context. So the attempt after a contract failure was shown
**114 lines of the contract** (`lineRange 65–178`, 4,701 bytes) — the file `contractFiles` exists to
withhold. The verdict said so in as many words: *"the worker was shown code the architect did not name."*

What makes it worth recording is the shape of the miss, not the bug. `contractFiles` reported
`unchanged: true` throughout, with a matching sha256. **The integrity check protects the contract from being
written; nothing protected it from being shown**, and two mechanisms designed to be independent — one
withholding a file, one widening what the worker sees — met and cancelled each other out.

It was fixed contract-first: an oracle assertion was added and demonstrated red
(`[ '…\contracts\spec.test.cjs' ]` vs `[]`), then green. The first fix **did not work** and shipped into
`dist` before the oracle caught it: `canonicalisePath` resolves a relative path against the process cwd,
not against the workspace the failing command ran in, so nothing matched. The pre-existing
declared-context exclusion had the same latent flaw, and a raw-string comparison of paths only ever worked
by luck of spelling. Oracles now 276/276.

## Finding 2 — the architect cannot see, and could not repair, the contract

**Three of the fourteen contractual areas never produced a verdict.** Tests 6, 8 and 12 aborted with
`object is not iterable (cannot read property Symbol(Symbol.iterator))` — the contract's own shared harness
iterating a non-iterable, not a fault in the module.

The architect could not diagnose it, because reading the contract back would put implementation-shaped code
into the metered context — the exact thing rule 3 forbids. So the repair had to be delegated from a symptom
description. The worker returned the file **byte-identical**: 7,946 bytes, sha256 `561cf664…`, unchanged
from step 1. Requested twice, the file never moved.

This is the honest limit of "architect-authored contract" under this design, and it is structural rather
than incidental:

- The guard stops the architect writing source, so the architect **cannot author the contract directly** —
  only specify it and have it transcribed by the same class of model whose work it will judge.
- The guard stops the architect reading source back, so the architect **cannot verify the transcription**,
  and cannot repair a defective one except by describing a symptom and hoping.

So "architect-authored" is really *architect-specified, worker-transcribed, architect-unverified*. That is a
weaker claim than the README's phrasing implies, and `contractFiles` hashing does not address it — it
guarantees the contract did not change *during a unit*, not that it ever said what the spec said.

## Finding 3 — the contract does discriminate

Worth stating, because it is the thing that could have been vacuous and was not.

- Against the first implementation it failed **two genuine behavioural defects** (eviction not choosing
  strictly by recency; replacing a key not refreshing expiry and recency while leaving the eviction count
  alone) — real bugs, correctly caught.
- Against a subsequently rewritten implementation it failed **11 of 14 areas**.

A contract that passed everything would have proved nothing. This one failed loudly and specifically, and
its failures named the right behaviours.

## Finding 4 — "make exactly one change" is not a reliable instruction

The mutation step was meant to isolate one defect and prove the *passing* tests were not vacuous. The
worker instead rewrote the module: **129 lines down to 86**, with many concurrent changes.

That makes the 11-of-14 result unusable as mutation evidence — the failures cannot be attributed to the
`size` change — and it is a distinct limit from "the worker is not capable enough". The worker was capable
of writing a working 129-line module from a spec. It was not able to *edit surgically*, and the plugin has
no facility that would have caught the difference: the verdict said `VERIFICATION_FAILED` either way.

An architect that cannot rely on a stated edit boundary being honoured cannot run mutation testing, cannot
do the kinds of refactor that depend on a change being local, and cannot expect "fix this one line" to mean
what it says. That is worth knowing independently of this module.

## What the experiment does not show

- **No green run was reached.** The endpoint is a contract that discriminates and an implementation that
  does not satisfy it. The loop carried the unit a long way; it did not close it.
- **Three areas are unmeasured** and remain so until the harness defect is fixed by something that can read
  the file.
- **The B1 coherence check was not exercised.** It is operator configuration, is not set in the live
  profile, and enabling it needs a profile edit plus a restart. "Checks from outside the contract" was
  therefore satisfied by `contractFiles` integrity only — a real outside check, since the worker cannot
  alter what judges it, but the project-level variant this item was originally framed around did not run.
- **Nothing here proves the module could ever be made to pass.** The contract was shown to discriminate;
  reaching green was not attempted further once the mutation step failed to isolate a change.

## Live verification of the fix, after a restart

A restart was needed before `536dfe1` could be observed, because the running process holds the `dist` it
loaded at startup. The leak was then reproduced deliberately in a scratch workspace and shown to be closed.

The conditions were made identical to the ones that leaked: a contract file whose own failure names it,
seeding the retry set, followed by a call that declared that file as `contractFiles` and declared **no**
context of its own — so any injection could only have come from the retry path.

| | `contextInjected` |
| --- | --- |
| before the fix, in this experiment | `SPEC.md` **plus `tests/ttl-cache.test.js` lines 65–178, 114 lines, 4,701 bytes** |
| after the fix, live | **absent entirely** |

`contractFiles` still reported `unchanged: true` with its sha256 in both cases, which is the point: the
integrity check was never the thing that was broken, and it is not the thing that was fixed. The fix is in
the retry path, and the retry path is where the verification had to happen.

The scratch workspace was removed afterwards and the working tree was clean.

## Verdict on the premise

**Partly supported, with a specific gap.**

What held up: the architect wrote a specification and no code; the module was implemented twice by a local
worker from that specification alone; no implementation code entered the architect's context; a contract
the worker could not alter judged the result and caught real defects; and the mechanism surfaced a genuine
bug in this project's own code that no oracle had found.

What did not: the contract is the linchpin of the whole arrangement, and the architect is structurally
unable to confirm that the contract says what the specification said. The plugin enforces that the worker
cannot *change* the contract. It does nothing to establish that the contract was *right*, and the one party
who could check it is the one party forbidden from reading it.

The cheapest repair worth trying is not architectural: the transcription step should end with the contract
being **executed against a deliberately broken implementation**, and be rejected unless it fails. A contract
that cannot fail on a wrong module is not a contract, and that test is available to the architect without
reading a single line of it.
