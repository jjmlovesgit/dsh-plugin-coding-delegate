# The experiment: an architect-authored contract for a module with internal structure

ROADMAP item 15. The first item in this project that tests the **premise** rather than the plumbing:
everything before it was infrastructure that had been argued for rather than exercised end to end.

The premise, from `README.md`: *your plan is for thinking, your GPU does the typing* — the architect
specifies, the local worker implements, the tree is judged by a contract the architect authored, and no
implementation code enters the metered context.

Artifacts live in [`experiments/contract-first/`](../experiments/contract-first/). They are an experiment,
not shipped code. Two contracts sit there side by side, and the pair is the point. `tests/ttl-cache.test.js`
— sha256 `561cf664…`, the same in every run above, which is Finding 2 stated as a hash — is the transcribed
contract those runs were judged by, **kept untouched as the evidence for Finding 5**. Beside it,
`tests/ttl-cache.spec.test.js` (sha256 `e62f280c…`) is the corrected contract that follows the
specification and passes 14 of 14. `src/ttl-cache.js` is now the specification-faithful module; the step-5
mutant that fails 11 of 14 is retrievable with
`git show 1548f75:experiments/contract-first/src/ttl-cache.js`.

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

## Finding 2 — the architect cannot tell a contract fault from a module fault

**This finding was first written wrong, and the correction is more useful than the original.**

The first version said three of the fourteen contractual areas never produced a verdict — tests 6, 8 and 12
aborting with `object is not iterable (cannot read property Symbol(Symbol.iterator))` — and attributed that
to a defect in the contract's own harness. On that basis it argued the architect could neither verify nor
repair its own contract, and pointed at a repair delegation that returned the file **byte-identical**
(7,946 bytes, sha256 `561cf664…`) as evidence of helplessness.

**The contract was fine.** Running it against a *null* implementation — a module that answers every property
with itself, never throws, and so cannot be blamed — **all fourteen tests reach their assertions**. The
`object is not iterable` aborts came from the *module* returning a non-iterable where the contract expected
one. The byte-identical repair was not helplessness; there was nothing wrong to repair.

So the real Finding 2 is narrower and sharper than the original claim:

- The architect **cannot author the contract directly** — the guard forbids cloud-authored source — so it is
  specified by the architect and transcribed by the same class of model whose work it will judge.
- The architect **cannot read it back** — rule 3 — so it cannot tell a contract that caught a real bug from a
  contract that is itself broken. Both produce "tests failed", and the verdict carries no signal separating
  them.
- And the natural diagnosis is the wrong one. Faced with a failing test inside a file it had specified, the
  architect blamed the contract. The module was at fault. Nothing in the available output could have
  distinguished them, and an architect that guesses here will "repair" sound contracts and leave broken
  modules alone — the exact double error this experiment committed before the guard existed.

`contractFiles` hashing does not help with any of that: it guarantees the contract did not change *during a
unit*, not that it says what the specification said, and not that a failure belongs to the module.

## Finding 3 — the contract does discriminate

Worth stating, because it is the thing that could have been vacuous and was not.

- Against the first implementation it failed **two genuine behavioural defects** (eviction not choosing
  strictly by recency; replacing a key not refreshing expiry and recency while leaving the eviction count
  alone) — real bugs, correctly caught.
- Against a subsequently rewritten implementation it failed **11 of 14 areas** — and, per Finding 2, those
  malfunctions are the module's, not the contract's.
- Against a null implementation it fails **14 of 14 by assertion**.

A contract that passed everything would have proved nothing. This one fails loudly, specifically, and in the
right place.

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

**The boundary is now checked — and the heuristic standing in its place is why it was not.** The write
landed because the only thing guarding a whole-file overwrite was a size comparison: refuse it when the new
content is less than half the old file's bytes. That is a proxy for "this is not really an edit", and this
rewrite is exactly what a proxy lets through: a substitution that keeps most of the bytes passes it no
matter how much of the file actually changed.

The rule that replaces it is not a heuristic. The worker has no repository read, so it cannot have seen the
target file unless the architect injected it, and a file it has not seen can only be replaced blindly. So a
whole-file emission may **create** a file and may not **modify** one; changing an existing file requires a
search/replace block, matched byte-for-byte against what was there. Nothing becomes inexpressible — the
whole file can still be replaced, by patching with its entire content as the search text — but it has to be
said, and it has to match. `plugin/tests/oracles/edit-boundary.test.cjs` holds that, including the case the
size heuristic waved through.

That closes the half of this finding that was a plugin gap. The other half is not a gap and is not going
away: a worker that cannot edit surgically still cannot. What changes is that a mutation unit is now
**refused** rather than silently converted into a rewrite — the difference between a boundary and an
instruction.

## Finding 5 — the transcribed contract was unsatisfiable, and the guard cannot see that

This is the experiment's strongest result, and it was found by refusing to read a plateau as a limit on the
worker.

Three further runs of the implementation loop ended at **13/14, 12/14 and 12/14**. The natural reading — the
worker is not good enough — is wrong, and two questions settle it. Neither needs the architect to read the
contract.

The first: does the module satisfy the specification? Writing the specification's requirements as checks and
running them against the module answers it: **16 of 16 pass**, including the live-count eviction bound, the
rule that an expired entry is not a preferred victim, replace-revival and replace-recency. The module is
faithful to the specification it was written from.

The second: is the contract satisfiable at all? The answer is two lines of the contract.

| line | assertion | state of the entry |
| --- | --- | --- |
| `tests/ttl-cache.test.js:91` | `has('b') === false` — *"b is expired, has returns false"* | expired |
| `tests/ttl-cache.test.js:132` | `has('b') === true` — *"b (MRU, expired) should NOT be evicted"* | expired |

One predicate, opposite expectations, on the same function. **No implementation satisfies both**, so the
green run was not missed: it was unreachable, and the loop could have run for as long as anyone was willing
to pay for it.

The second defect is quieter. Line 150 expects `evictions === 1` in a scenario whose *live* count is exactly
`maxEntries`, and `SPEC.md` says eviction runs when "the number of **live** entries exceeds `maxEntries`".
The contract is testing a cache bounded by *total* entries. Test 9 asks for the same thing.

`scripts/check-contract.cjs` reported **OK: the contract is well-formed and discriminating** for that file,
and it was not wrong to. The contract does assert, and every failure against a null implementation is a
behavioural disagreement. But it decided vacuity and malfunction, and **never faithfulness to the
specification**, so a contradiction introduced during transcription was invisible to it — and invisible to
the architect, who under rule 3 cannot read the file to find it. `README.md` already said a contract can be
"well-formed, discriminating, and still test the wrong behaviours"; this is that sentence with an instance
attached.

**That gap is now closed, and this experiment is the case that closed it.** The guard takes an optional
`--spec <file>`: a specification conformance suite the architect owns, which is the null trick run
backwards. Null proves the module cannot be blamed; the suite proves the module *can* be trusted, and a
contract that still rejects a conforming module is the artifact at fault. Pointed at the transcribed
contract plus the suite in `tests/spec-conformance.test.cjs`, it exits 1 and names the two tests —
*"not ok 9 - eviction chooses strictly by recency, not by expiry"* and *"not ok 10 - replacing an existing
key refreshes expiry and recency, not counted as eviction"*. The same command against the corrected
contract returns OK. The defect this document describes as undetectable became a verdict, produced without
the architect reading a line of the contract.

So Finding 5 is Finding 2 with its consequence made concrete. Finding 2 said the architect cannot tell a
contract fault from a module fault. Finding 5 shows what that costs when the contract fault is **real**: the
loop has no terminating condition, and the plateau it produces is indistinguishable from a limit on the
worker.

### Closing it, and the part that generalises

The contract was preserved rather than repaired, because it is the evidence. A sibling contract,
`tests/ttl-cache.spec.test.js` (sha256 `e62f280c…`), was transcribed from `SPEC.md` and passes **14 of 14**
against the module, which was not changed to suit it; against a null implementation it fails 14 of 14 by
assertion, so it still discriminates and still passes the guard.

One detail is worth more than the result. The two tests that had to be corrected were given to the
transcriber **scenario by scenario** — every clock advance and every expected counter written out. The one
area left to prose, `purge`, came back with a scenario whose own comment called an entry live at `t=110`
when its expiry made it expired at `t=100`; the assertion then contradicted the scenario it was written to
test. The architect's contribution is not the *area* to be tested but the *scenario* that tests it, and a
transcribed contract is only as good as the scenarios it was handed.

## What the experiment does not show

- **The green run was reached only after the contract was corrected** (Finding 5). It shows that a
  specification-faithful contract and a conforming module can be brought together. It does **not** show that
  the loop closes a unit unaided, because what blocked this one was a defect in the artefact the architect
  is forbidden to read.
- **The B1 coherence check was not exercised.** It is operator configuration, is not set in the live
  profile, and enabling it needs a profile edit plus a restart. "Checks from outside the contract" was
  therefore satisfied by `contractFiles` integrity only — a real outside check, since the worker cannot
  alter what judges it, but the project-level variant this item was originally framed around did not run.
- **Nothing here proves the module could have been made to pass the original contract.** It could not: that
  contract is unsatisfiable, and the failure was never the module's (Finding 5).

## The guard, and what it found when pointed back at this experiment

[`scripts/check-contract.cjs`](../scripts/check-contract.cjs) exists to close Finding 2. It is run after a
contract has been transcribed, and it judges the contract **against a null implementation** — a module that
answers every property with itself, every call with itself, and never throws.

That choice of condition is the design. A test that fails by *malfunctioning* looks exactly like a test that
caught a bug, and against a real module the ambiguity cannot be resolved: the module may simply be throwing.
Against a null implementation the module cannot be blamed, so a malfunction is unambiguously the contract's.
The run against the real module is printed and deliberately **not** judged, for the same reason.

Two checks, and only the first decides:

| | against a null implementation | verdict |
| --- | --- | --- |
| **discriminates** | at least one assertion failure | a contract that passes a module returning itself for everything constrains nothing |
| **well-formed** | no malfunction failures | every test reached an assertion, so the failures are disagreements rather than errors |

Pointed back at this experiment's contract, it **exonerated it**:

```
A. against a null implementation: 14 tests, 0 passed, 14 failed by assertion, 0 by malfunction
   ok: it asserts, and every failure is a behavioural disagreement
B. against the real module: 14 tests, 3 passed, 0 failed by assertion, 11 by malfunction
   reported only. ...
OK: the contract is well-formed and discriminating.
```

That is Finding 2 collapsing, and it is the strongest argument for the guard existing. The architect had
already published the opposite conclusion — "the contract's own harness is broken" — in this document. The
guard separated the two possibilities in one run, without reading a line of the contract, and put the fault
where it belonged.

And it is not an always-yes. Against a deliberately vacuous contract written as a fixture
(`experiments/contract-first/tests/vacuous.test.js`, three tautologies that require the module and assert
nothing about it) it refuses:

```
A. against a null implementation: 3 tests, 3 passed, 0 failed by assertion, 0 by malfunction
   FAIL: it passed a module whose every call returns itself, so it constrains nothing
```

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

**Partly supported, with a specific gap — and the gap now has a detector.**

What held up: the architect wrote a specification and no code; the module was implemented twice by a local
worker from that specification alone; no implementation code entered the architect's context; a contract the
worker could not alter judged the result and caught real defects; and the mechanism surfaced a genuine bug in
this project's own code that no oracle had found.

What did not: the architect is structurally unable to tell a *contract* fault from a *module* fault, because
it can neither read the contract nor see past "tests failed". This document demonstrates that failure
directly rather than describing it — the first version of Finding 2 blamed the contract for the module's
errors, and it was published that way.

The guard resolves exactly that ambiguity without reading the contract, which is the only kind of answer
available under rule 3. It does not make the contract *right*: a contract can be well-formed, discriminating
and still test the wrong behaviours, and nothing here would notice. What it removes is the failure this
experiment actually committed — a sound contract condemned and a broken module excused, on the same
evidence.

One correction the guard also forces on the record. The repair that was originally read as helplessness —
the worker returning the contract byte-identical — was the correct outcome. There was nothing to repair.
