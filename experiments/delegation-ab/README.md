# Delegation A/B experiment

The protocol is [`PROTOCOL.md`](PROTOCOL.md). This note records the artifact the runs produced, so the
evidence is pinned rather than left as an untracked working file.

## `src/aggregation-window.js`

A bounded sliding aggregation window, implemented by a **delegated local worker** against
[`SPEC-2.md`](SPEC-2.md) and judged by the frozen [`tests/spec-conformance-2.test.cjs`](tests/spec-conformance-2.test.cjs)
(27 checks).

| | |
| --- | --- |
| sha256 | `6d5ff93bcb04dca8f01a17df41c505613740a610eb877c45e1abbb082b18661c` |
| size | 3,273 bytes |
| judge | **27 pass / 0 fail**, re-verified locally after the run |
| registry | `mode: created`, `outcome: UNIT_PASSED`, `succeeded: true` |
| contract | unchanged across the delegation, sha `91fe3a4352e54a7d…` |

It is kept because it is the experiment's one clean positive result: the contract verified the work, the
verdict came back as a count and a hash, and **the module never entered the architect's context** — the
session trajectory contains no read of it at all.

## The convergence baseline it establishes

Same task and same frozen judge, three arrangements:

| run | how it was driven | delegations | architect judge runs | outcome |
| --- | --- | --- | --- | --- |
| 1 | subagent, loop outside the unit | 1 | **5** | 27/27, but the architect did the iterating |
| 1b | subagent, loop inside, verification refused | 4 | 0 | **never converged**; no valid artifact (superseded as a plan, see PROTOCOL.md) |
| 1c | top-level session, loop inside, verification ran | **1** | **0** | **27/27 first attempt** |

That is the n=1 baseline for the claim that the local worker is the diagnostic engine: **one attempt with
verification running, four without it and no convergence.** It is one observation, and it is recorded here
rather than in prose somewhere else so the next run has something to compare against.

## Not committed here

`.verifier/` **is** committed, and the arms must not read it: it contains a reference implementation and
the mutation harness that verified the judge in both directions (green on a correct implementation, red on
all six mutations). It is tracked because a verification result that lives in a scrollback is not evidence.
