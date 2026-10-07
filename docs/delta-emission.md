# Delta emission: closing the contract loop on existing code

**Status: design, not implemented.** Nothing described here ships. The plugin today is the two-tier
loop described in [README.md](../README.md), and its limits are real: a delegated unit can create new
files and cannot modify existing ones. This document records why, and the shape of a fix.

It lives outside the package on purpose. A design document for unbuilt features inside `files:` reads
as a promise, and this repository's whole argument is that it does not make promises it cannot keep.

## 1. The gap

`delegate_worker` hands a unit to a local model and writes whatever files come back. Three properties
combine so that existing code is out of reach:

| Property | Where | Consequence |
| --- | --- | --- |
| Target files are sent as **paths**, never contents | `plugin/src/index.ts:1055` | The worker cannot see what it is asked to change |
| Output is capped by `PROFILES.WORKER.max_tokens` (8,192) | `plugin/src/index.ts:1089`, `plugin/src/profiles.ts:42` | It could not re-emit a large file even if it could see it |
| Emission understands only whole-file fenced blocks | `plugin/src/index.ts:396` | Whole-file replacement is the only way it can express a change |
| The architect is forbidden to read implementation files | `plugin/src/profiles.ts` (ARCHITECT system instruction) | The one party that could supply context is not allowed to |

The fourth row is deliberate and should stay. The first three are not: they are the current state of a
transport that was left half-built, and the seam is still visible — `delegateWorker` already accepts a
`fileContext` string (`plugin/src/index.ts:1002`, consumed at `:1058`) that no caller ever populates.

**This is a missing transport, not a missing tier.** The plugin runs inside the DSH process and has
filesystem access. It can read a target file and put it in the worker's prompt without the architect
ever seeing a byte of it. No third model is required for the loop to close on existing code.

## 2. What a fix must preserve

Each rule in the policy becomes a design constraint on this mechanism, not a footnote to it.

- **Rule 1 — a credential may not reach the cloud.** Injected context must be scanned by the same DLP
  gate as an outbound prompt. `localEndpoint` may point at a vLLM port on another machine; a "local"
  endpoint that is remote **is** a cloud, and the comment at `plugin/src/index.ts:71-73` already
  anticipates "the file contents it carries". Reading files to inject them creates a new egress path,
  and it has to be gated like every other one.
- **Rule 3 — the architect may not read back what it delegated.** Context travels architect-blind. The
  architect supplies *names and ranges*, never contents, and learns back only metadata.
- **Rule 4 — the worker may not write outside the workspace.** Injection containment mirrors emission
  containment: the same resolution, the same refusal of escapes and absolute paths.
- **Rule 7 — a delegated result is a verdict, not a claim.** Applying a change must be deterministic
  and performed by the tool. What lands on disk is the tool's act, never the worker's assertion.

## 3. Design

### A. Context injection

A new optional argument, names only:

```jsonc
{
  "contextFiles": [
    { "path": "src/thing.ts", "startLine": 40, "endLine": 120 },
    { "path": "src/thing.test.ts" }
  ]
}
```

- Resolved against the workspace with the containment used for emission; anything outside is refused.
- Ranges are first-class because injection competes with the worker's 32,768-token input window. A
  whole large file would evict the instruction it was meant to serve.
- Total injected bytes are bounded, and the bound is reported rather than silently truncating.
- DLP-scanned before transmission, per rule 1 above.
- Attached through the existing `fileContext` parameter. The transport already exists; this fills it.
- The receipt carries `contextInjected: [{ path, lineRange, bytes, sha256 }]` — the architect learns
  what the worker was shown without being shown it.

The sha256 matters more than it looks: it is what lets the tool later prove that a patch matches the
bytes the worker was actually given.

**What this does not do:** it does not let the worker discover anything. The architect must still name
the files. Repository-wide reasoning remains a separate concern (§6).

### B. Delta emission

A second fenced form, alongside the whole-file one:

````
```patch file="src/thing.ts"
<<<<<<< SEARCH
  const y = 2
=======
  const y = 3
>>>>>>> REPLACE
```
````

**Search/replace rather than unified diff, and the reason is the worker's shape.** A unified diff
requires the model to compute `@@ -12,7 +12,9 @@` line arithmetic correctly, and the configured worker
runs with `enable_thinking: false` and `reasoning_effort: 'none'`. Asking a non-reasoning model to
count lines is asking for the one thing it is worst at. A search/replace pair asks it to *copy bytes it
was just shown*, which is the thing it is best at.

`applySearchReplace(content, blocks)` is a pure exported function, in the same style as
`evaluateCodeWriteGuard` and `evaluateVerificationPolicy`, so the invariants are oracle-testable with
no server involved:

- Every SEARCH block must match **exactly once**. Zero matches is a failure; more than one is a
  failure. "Exactly once" is what makes the operation unambiguous without line arithmetic.
- No fuzzy matching, ever. Fuzz is not a tuning knob here; it is the mechanism by which a wrong edit
  lands silently. A near miss must fail loudly and be re-delegated.
- All blocks apply or none do. A partially applied change is worse than no change, because it leaves
  the tree in a state no contract was written against.
- Line endings are normalised (CRLF→LF) exactly as the existing emission path does, and nothing else
  is normalised. Indentation is bytes.
- A block whose SEARCH is trivially short is refused as too ambiguous, independently of the
  exactly-once check.
- Same containment as emission; a patch may only touch paths the unit was permitted to write.

The existing whole-file path keeps its sanity guard, which rejects a rewrite more than 50% smaller than
the file it replaces (`plugin/tests/oracles/verify-integrity.test.cjs`). That guard is a whole-file
guard; patches are bounded by construction and report hunks applied instead.

**The property that makes the verdict trustworthy** is the coupling with unit A: the tool injected the
exact bytes, recorded their hash, and then applies a change that must match those bytes. Application
either succeeds or fails, and the tool does the writing. Nothing about the outcome rests on the
worker's word.

### C. Contract-path integrity

This closes self-certification, and it is the smallest of the three.

1. The architect declares the contract's test files for the unit.
2. The tool hashes them **before** the worker runs, and refuses any emission or patch targeting them.
3. After verification, the tool re-hashes them. A changed contract file fails the verdict regardless of
   what the tests reported.

A passing verdict then means *the architect's tests, unmodified, passed against the worker's code* —
which is what the loop was supposed to mean all along. Today the architect owns only the command, and
nothing stops a worker emitting the test file that command runs.

This unit is **independent of A and B** and can ship first.

## 4. Sequencing

| Unit | Closes | Depends on |
| --- | --- | --- |
| C — contract-path integrity | self-certification | nothing |
| A — context injection | "the worker is blind" | nothing |
| B — delta emission | "cannot modify existing files" | A (a patch needs the bytes it patches) |

Each unit gets an architect-authored contract oracle of the kind used for the debrand pass: written
before the change, demonstrated to fail against the old tree, and never edited by whatever satisfies
it. Each is small enough that a local failure costs wall-clock and nothing else.

## 5. Limits to document if this ships

- Exact-match patching fails on **stale context** — the worker was given bytes that have since changed.
  This is a correct failure and must re-delegate, not retry with fuzz.
- The 8,192-token output cap still bounds patch size. That is the right shape of bound, and raising it
  is a separate `localMaxTokens` configuration key that does not currently exist.
- Injection consumes the worker's input window, so ranges and byte caps are load-bearing rather than
  polish.
- None of this gives the worker the ability to explore. It receives what it is given.

## 6. Still unresolved

- **The lead tier.** A thinking model with repository access, feeding each unit's contract, is the
  answer to cross-unit coherence and to *naming the right files* — a judgement problem that transport
  cannot solve. It is blocked on a host capability: the plugin cannot tell which agent is which (see
  `SECURITY-REVIEW.md`, "Blocked on the host: agent lineage").
- **Argument spelling.** `contextFiles` is a working name.
- **Whether injection is on by default.** Off is the conservative answer; the architect should have to
  ask for context.
- **Patch application and the guard.** The code guard mediates cloud-authored writes. A tool-applied
  patch is a different actor writing, and the interaction with `guardAskPaths` needs deciding rather
  than inheriting.
