# dsh-plugin-coding-delegate

**Repo-native cryptographic attestation, anti-self-approval enforcement, and an execution perimeter for
autonomous coding agents.**

Every verified delegation leaves a signed record in the repository's own Git notes, bound to the commit it
describes: the execution receipt and the human approval are two signatures made by two different keys, and
the audit that checks both runs offline. Control mapping for SOC 2 CC8.1, ISO/IEC 42001 and the EU AI Act:
[docs/enterprise-governance.md](docs/enterprise-governance.md).

Who this is for — the roles that are blocked today, and the obligation each one is trying to discharge:
[Target audience and market positioning](docs/target-audience.md).

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that separates **who specifies** work
from **who implements** it, and refuses to let the first party write the second party's code. It is a
technical control, not a policy: enforcement happens in a tool-call hook before a write lands, so it does
not depend on the model choosing to comply.

The metered model has no write tool and no shell. A fully prompt-injected architect can plan anything and
still cannot change a byte of your host, because the permission is never granted.

## The two guarantees this control exists to make

Two properties, both of the kind a pipeline usually asserts rather than enforces. Everything else in this
README is in service of them.

### 1. Anti-self-approval: two principals, two keys, checked

A record under attestation spec **1.2** carries a `worker` receipt and a `reviewer` approval, with three
signatures sealed in order: the worker signature over the payload, the reviewer signature over the payload
*including* the frozen worker block, and the outer envelope seal last, because adding the reviewer block
would invalidate an earlier seal.

* **The two keys must differ.** Equal fingerprints are refused with `self-approval refused`. Red-team probe
  10 signs a reviewer block with the worker's own key; without that check the record verifies perfectly.
* **The record must name the key that verifies it.** A genuine signature from a key the record names but the
  resolved trust root does not know is refused (probe 9).
* **Approval is a separate, human, two-phase act.** `--prepare <target> <contract>` runs the contract and
  stages an untracked draft that cannot be committed; `--approve <target> --reviewer-identity "<name>"`
  re-verifies the draft against the anchored tree, adds the reviewer block, attaches once, reads the note
  back byte-identical, and only then removes the draft. It does **not** re-run the contract: the record must
  carry what phase one saw, not a second opinion collected later.
* **No plugin path can author a human claim.** `delegate_worker` settles execution status only — the four
  registry outcomes `UNIT_PASSED`, `UNIT_FAILED`, `UNIT_UNVERIFIED` and `UNIT_FLAKY`, which are verdicts and
  not signing keys. The three tool parameters that once let a caller name a reviewing human are gone, and a
  compile-time assertion keeps them gone.

**Residual boundary.** With the in-repo reviewer key in use, a committer who can edit both
`keys/delegation-reviewer.pub` and the operator pin could substitute both roots. Pin the reviewer root out of
band with `DSH_REVIEWER_PUBKEY` or `DSH_REVIEWER_FINGERPRINT`, and a second signature becomes evidence about
a principal the record's author cannot reach. Details:
[dual attestation](#dual-attestation-the-worker-receipt-and-the-human-reviewer-spec-12).

### 2. Repo-native provenance: the record cannot outrun its commit

Attestations are Ed25519-signed notes in `refs/notes/delegations` — objects in the same database as the
code, so they clone and verify offline. Every claim in a record is re-derived at audit time from the
**anchored commit's tree**, never from the working copy: a note that names one commit and lives on another,
whose anchor is not an ancestor of `main`, or whose artifact or contract digest does not match the blob at
that commit is refused. The full check list is under
[Cryptographic Provenance & Attestation Model](#cryptographic-provenance--attestation-model), and is
specified in full in [docs/enterprise-governance.md](docs/enterprise-governance.md) §3.

**Residual boundary.** A Git ref is not write-once storage: notes can be edited, re-attached or removed, and
the ref can be force-pushed. The audit catches every mutation that leaves a record behind — the red-team
harness performs ten of them — and it refuses an empty ledger, but it cannot detect one note removed while
others remain. That needs an external sink, and the auditor says so in its own closing line.

## Auditing it yourself

Run these from a clone. The published npm package is the plugin (`plugin/dist`); the gate and signing tooling
deliberately live in the checkout rather than in the tarball, so there is no standalone CLI to install and no
extra artefact to trust:

```bash
npm run gate                                 # all seven commands (eight tools), offline
node scripts/verify-delegation-ledger.cjs    # the ledger audit alone
node scripts/redteam-probe.cjs               # ten attack classes; restores the ledger afterwards
```

A green run prints `AUDIT PASSED`, then the one limit that matters: *"this proves the records present are
sound. It cannot detect a record that was deleted."* To check a **published** release against its tag — this
one needs the network — run
`powershell -File scripts/verify-release-tarball.ps1 -Version <version> -Tag v<version>`, substituting the
release you are checking; it compares the tarball and the tag in both directions by Git blob hash.

The same gate runs on every push in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), with
`fetch-depth: 0` and an explicit `refs/notes/delegations` fetch, because a depth-1 checkout would audit an
empty ledger and report success. The `v0.5.7` release commit was gated by
[run 210](https://github.com/jjmlovesgit/dsh-plugin-coding-delegate/actions/runs/38932268538), which concluded
`success`. A CI workflow holds no signing key, so the signer lifecycle step reports a named `# SKIP` there
rather than passing silently.

## How it works: a contract out, a verdict back

Coding needs two different jobs done, and they want two different contexts. The plugin gives each one its
own window and lets exactly two things cross between them.

**The architect** is the metered thinking model. It holds the design conversation, decides how the work
decomposes, and writes a **contract** for each unit: what to build, where the worker may write, and the
command that decides whether the unit passed. It does not write source. Reading it back is governed
rather than forbidden: with the default `sourceReadEgress: 'source'` a read returns the file, rule 3 makes
a read of a freshly-delegated one ask first, and `sourceReadEgress: 'declarations'` serves a type skeleton
instead of the body.

**The worker** is whatever your GPU is already running. It receives one unit and everything that unit
needs — nothing else — writes the code, and is discarded. A fresh context per unit costs nothing.

| Direction | What crosses | What never crosses |
| --- | --- | --- |
| architect → worker | the contract: instruction, permitted paths, the verification command | the design conversation, the other units |
| worker → architect | the verdict: pass/fail counts, a redacted failure structure, the names of files written | the code |

The verification command runs as an ordinary subprocess, with the operator's approval. Its raw output
stays on the local machine; what travels back is the failure *structure*, with source stripped out.

> **Status: 0.5.7**, published to npm and gated in CI. The mechanisms work and are tested, and their
> **limits are documented rather than glossed**, including several that cannot be closed from inside the
> process — see [What this control does not cover](#what-this-control-does-not-cover) and the consolidated
> residual table in [docs/enterprise-governance.md](docs/enterprise-governance.md). Read those before
> deciding whether it fits your situation.

```text
  CLOUD  (metered, holds the design conversation)          LOCAL  (your box, your GPU)
  +------------------------------------------------+       +-------------------------------+
  |  ARCHITECT                                     |       |  WORKER                       |
  |    •  no write        (pre-execute, rule 2)    |       |    •  fresh context per unit  |
  |    •  no shell        (pre-execute, rule 5)    |       |    •  ephemeral, then discarded|
  |    •  reads served as .d.ts stubs (when active)|       |    •  workspace root enforced |
  |                                                |       |    •  verification: subprocess|
  +------------------------------------------------+       +-------------------------------+
            |                                                        ^
            |  1. CONTRACT                                           |  2. VERDICT
            |     instruction, declared paths,                       |     pass/fail counts
            |     the verification command                           |     redacted failure shape
            |                                                        |     names of files written
            v                                                        |
  ==============================[ SUBPROCESS BOUNDARY ]==============================
                          human approval before it runs  (rule 6)

  What the channel does NOT carry:
    no design conversation   no other units   no code crossing by emission
    (reads are GOVERNED, not blocked: see the egress row below)

  WHERE THE GATES ACT, and what each one is called in the policy table:

    architect requests a tool call
       |
       +-- write / modify ------> pre-execute, rule 2 ---> DENY
       +-- shell / exec --------> pre-execute, rule 5 ---> DENY
       +-- read / search / shell-> post-execute, rules 2/3
       |                              |
       |                              +-- sourceReadEgress: 'declarations' (OPT-IN)
       |                              |     read  -> served as the .d.ts skeleton
       |                              |     search-> refused (matched lines are bodies)
       |                              |     shell -> refused when it reads source
       |                              |
       |                              +-- sourceReadEgress: 'source' (DEFAULT)
       |                                    a read returns the file; rule 3 still
       |                                    asks about files a worker just wrote
       |
       +-- delegate_worker ------> the worker, inside the containment matrix

  ==============================[ HOST BOUNDARY ]==============================
  The outbound request is assembled by DSH AFTER this plugin's hooks run.
  Assistant output and tool results are therefore NOT scanned by the DLP gate,
  which sees the session's user messages. Closing that needs a host seam that
  exposes the outbound payload; it cannot be closed from inside the plugin.
  See SECURITY-REVIEW-2.md, findings 13 and 15.
```
    
## Understanding the audit system

The layer-by-layer explanation of what the gate proves — negative-fixture discrimination, the signed ledger,
and tree-accurate auditing — is in
[empirical-findings.md](docs/empirical-findings.md#appendix-the-audit-system-in-plain-english), kept beside
the measurements that retired three of this project's own claims. The mechanisms are specified below, and
the control mapping is in [enterprise-governance.md](docs/enterprise-governance.md).

## Cryptographic Provenance & Attestation Model

Every verified utility module (`tools/*.ts`) is governed by an Ed25519-signed provenance ledger in Git
notes (`refs/notes/delegations`). Tooling scripts such as `tools/worker-build.mjs` are build dispatchers
and sit outside the contract boundary.

1. **Dual-gate verification.** Module/contract parity is enforced 1:1 (`scripts/check-contracts.cjs`), and
   every contract must reject a deliberately defective twin (`scripts/check-contract-fixtures.cjs`) while
   still passing at least one case — a fixture that fails everything is reported as evidence about nothing.
   Both the signer and the auditor refuse a contract the discrimination gate does not cover.
2. **Git object ledger audit.** The auditor (`scripts/verify-delegation-ledger.cjs`) bypasses the working
   copy: every artifact and contract SHA-256 is re-derived from the anchored commit's tree through
   `git cat-file`, the note must be attached to the very commit its payload names, that commit must be an
   ancestor of `main`, and an empty ledger is fatal rather than green.
3. **Dual attestation (spec 1.2).** A 1.2 record carries two principals and three signatures: a worker
   receipt and a separate reviewer approval, made under different Ed25519 keys and sealed in order. Equal
   fingerprints are refused (`self-approval refused`), the fingerprint the record names must be the one
   that actually verifies it, and the reviewer trust root resolves out of band first
   (`DSH_REVIEWER_PUBKEY`, then `DSH_REVIEWER_FINGERPRINT`, then the in-repo fallback, which announces
   itself). `UNIT_PASSED` is an execution status, not a signature, and `OPERATOR_ATTESTED` is written by
   no shipped path.
4. **Active red-team verification.** Ten attack classes — key substitution, payload tampering, lineage
   orphaning, re-attachment to a different commit, time-travelling artifacts, malformed and mis-signed 1.2
   records, and self-approval — each required to produce its specific refusal string *and* a non-zero exit
   (`scripts/redteam-probe.cjs`).

The full specifications, the seven auditor checks, the residual boundaries and the probe-by-probe mapping
are in [docs/enterprise-governance.md](docs/enterprise-governance.md) §2, §3 and §7.

## Verification and Integrity Gate

One command runs every check that stands between a change and a record of it:

```bash
npm run gate
```

It runs **seven commands, executing eight tools**, in order. A failure in any one stops the rest:

1. **File hygiene** — `scripts/check-file-hygiene.cjs`. Refuses files under `tools/`, `plugin/src/`,
   `scripts/` and `src/` that are missing a trailing newline, are stored with CRLF, or carry a UTF-8 BOM. CRLF is not
   cosmetic here: the signer hashes the bytes on disk while the auditor reads the blob from the commit, so a
   CRLF checkout produces a note the audit then rejects.
2. **Architecture and complexity** — `npm run gate:arch`, two tools in one step. `dependency-cruiser`
   (`.dependency-cruiser.cjs`) refuses a Tier 1 module that imports anything at all, a Tier 1 or Tier 2
   module that imports Tier 3, and `plugin/src` reaching outside its own package. `eslint`
   (`eslint.config.mjs`) enforces a cyclomatic ceiling of 10 and 40 lines per function on Tier 3 paths,
   against a named file baseline that may only shrink. Both read their numbers from
   `scripts/policy-config.cjs`, so the enforced ceiling is the documented one.
3. **Negative discrimination** — `scripts/check-contract-fixtures.cjs`. Refuses a contract that passes its
   real module but *also* passes `tests/contracts/fixtures/<name>.negative.ts`, a contract with no fixture
   at all, or a fixture that fails every case — which is a malfunction rather than discrimination.
4. **Module ↔ contract parity** — `scripts/check-contracts.cjs`. Refuses a contract with no
   `tools/<name>.ts`, a `tools/*.ts` with no contract, or a contract that is not well-formed against its
   module.
5. **Ledger attestation audit** — `scripts/verify-delegation-ledger.cjs`. Refuses a note whose Ed25519
   signature does not verify under the pinned operator key, that is attached to a different commit than the
   one its payload names, whose `baseCommit` is not an ancestor of `main`, whose artifact or contract
   digests do not match the anchored commit's tree, or whose contract is not covered by step 3. It also
   refuses a record that declares spec 1.2 without both blocks and a valid reviewer signature under the
   resolved trust root, that names a reviewer fingerprint the root does not verify, or whose reviewer key
   is the worker's own key.
6. **Tree coverage** — `scripts/verify-tree-attestations.cjs`. Walks `HEAD` and requires that every
   contract-governed `tools/*.ts` is covered by a signed note recording that path with the **SHA-256 of the
   bytes at HEAD**. This closes the gap the audit structurally cannot: an audit of the notes it finds cannot
   detect a primitive that has none, so a commit made with `--no-verify`, or on a clone without
   `core.hooksPath`, used to pass CI. Coverage is content-addressed, not commit-addressed, so it survives
   rebase, squash and amend.
7. **Signer lifecycle** — `tests/attest-unit-lifecycle.test.cjs`, also `npm run test:lifecycle`. Creates a
   throwaway clone, copies the working-tree scripts into it, and drives a real `--prepare` and `--approve`
   there: the worker phase must leave the ledger ref exactly where it was, exactly one note must be added,
   the audit must accept that note under an out-of-band reviewer pin, and must reject it under a pin that
   does not match. The temporary clone is removed in a `finally`, and the repository's own ledger is never
   written. On a host without the operator and reviewer private keys — always the case in a CI workflow,
   which must not hold a signing key — it reports `# SKIP` with that reason rather than passing silently.

Steps 1 and 4 are also available on their own as `npm run check:hygiene` and `npm run gate:wellformed`,
with `npm run audit` for the ledger audit alone, `npm run gate:arch` for the boundary and complexity tools,
and `npm run test:lifecycle` for the signer lifecycle.

### The three tiers

| Tier | Paths | What is mechanically enforced |
| :--- | :--- | :--- |
| **1 — leaf primitives** | `tools/*.ts` | zero imports of any kind; a discrimination contract plus a targeted negative fixture; three-run flake evidence; a signed Schema 1.2 note whose digest matches the bytes at HEAD |
| **2 — protocol engines** | `plugin/src/**` | must resolve entirely inside `plugin/`, because the package ships as `plugin/dist` and is installed on its own |
| **3 — imperative shell** | `scripts/**`, `src/routes/**` | cyclomatic ceiling 10, 40 lines per function, no nested ternaries; may not be imported by tier 1 or tier 2 |

The tier patterns and ceilings live in `scripts/policy-config.cjs`, and the paths the repository has not
grown yet are armed rather than merely documented: `src/engine/**` importing `src/routes/**` already fails
the fence, and a complexity-11 function under `src/routes/` already fails the linter.

### Adding a Tier 1 primitive

Tier 1 modules cannot be committed by hand: the pre-commit hook refuses a staged `tools/*.ts` unless the
atomic harness set `AI_SDLC_ATOMIC_RUN=1` for its own commit.

1. Author the contract with a self-describing `@requirements` header — `tests/contracts/<name>.contract.cjs`.
   The harness extracts that block and sends it to the worker; the dispatcher table is only a fallback.
2. Author the targeted negative mutant — `tests/contracts/fixtures/<name>.negative.ts`. It must be correct
   in every respect except one, or the discrimination gate refuses it for failing everything.
3. Have the local worker serving — `qwen/qwen3.8-27b` on `http://127.0.0.1:1234/v1` (LM Studio).
4. Run the harness:

   ```powershell
   npm run delegate:unit -- --target tools/<name>.ts --contract tests/contracts/<name>.contract.cjs --mutant tests/contracts/fixtures/<name>.negative.ts
   ```

   It verifies the mutant through a byte-identical contract mirror, dispatches, normalises the emitted bytes
   (BOM, CRLF, trailing newline), runs the contract three times, commits, and stages the attestation draft.
5. Seal it — the harness deliberately stops here, and will not name a reviewer for you:

   ```powershell
   node scripts/attest-unit.cjs --approve tools/<name>.ts --reviewer-identity "Your Name <email@example.com>"
   ```

`--dry-run` prints the whole plan without unlinking, dispatching, committing or signing.

### Checking a release

A `v*.*.*` tag runs `.github/workflows/release.yml`. It refuses a tag that disagrees with either
`package.json` before installing anything, materialises `main` (a tag checkout is detached, and the ledger
audit names that ref), re-runs the gate and the 27-run flake sweep at the tagged tree, regenerates the ledger
population at that commit, and attaches three assets to the GitHub Release:
`ledger-audit-population.txt`, `flake-gate-sweep.txt` and `SHA256SUMS.txt`.

Each digest can be checked three independent ways — the published `SHA256SUMS.txt`, a local
`sha256sum` after download, and the digest GitHub computes on upload — and the coverage gate makes the
ledger population meaningful: a release whose evidence named a primitive the tree no longer contains would
fail before publishing.

### Synchronising the ledger

Git does not push `refs/notes/*` by default, and a repository that gates on verdicts without publishing
them keeps its audit trail to itself:

```bash
git push origin refs/notes/delegations
```

A clone does not receive the notes either — `git fetch origin refs/notes/delegations:refs/notes/delegations`
is what makes the audit runnable on a fresh checkout. Without it the audit fails closed rather than
reporting success over an empty ledger, because an empty ledger and a deleted one are indistinguishable.

## What it does

Five things, in the order they act:

1. **In-process, no sidecar.** No daemon, no extra port, nothing to supervise. The gate and the
   authorship guard run inside the plugin.
2. **A DLP gate on every outbound request.** Prompts are scanned for credentials and high-entropy tokens
   before the cloud sees them. A hit is refused or rerouted to the local worker, never transmitted. The
   gate accumulates the user messages it has seen, so a credential from an earlier turn keeps it closed
   instead of scrolling out of view. The scanned window is bounded at 200,000 characters, and that
   conclusion is not — for a hit a **pattern** confirmed. Once a session has carried an API key, a token or
   a private-key block it stays local for the rest of the session, because the flag recording it is not
   evicted along with the text. A high-entropy string on its own does **not** pin the session: the entropy
   backstop is a per-turn soft landing, so a random hash, a UUID or a base64 blob is rerouted for that turn
   and re-decided on the next one rather than locking the session down permanently.
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
| 5 | The worker's code may not run inside the server | subprocess only; the in-process fallback was removed |
| 6 | A command the architect proposes may not run unchecked | approval seam |
| 7 | A delegated result is a verdict, not a claim | files written without verification report `UNVERIFIED` |
| 8 | Source may not reach the cloud | cloud-bound requests carrying fenced source are refused by default; `sourceEgress` decides |

Rule 8 is a heuristic: it looks for fenced blocks with a source language tag of at least
three lines, so source pasted without a tag, described in prose, or split across short blocks is not
detected. It is also the one rule that can refuse a request you typed yourself.

## The enforced invariants

Five boundaries, and each says what it does *not* cover, because a boundary count is only meaningful if
every item is the kind of boundary it claims to be.

| # | boundary | enforced by | fails closed how |
| --- | --- | --- | --- |
| 1 | **Mutation integrity** | `tools/pre-execute` blocks cloud writes and shell execution | the planning tier physically cannot write or run on the host |
| 2 | **Egress privacy** | `tools/post-execute` serves `.d.ts` stubs via `sourceReadEgress: 'declarations'`, for `.ts`/`.tsx`/`.js`/`.jsx` only | a read is refused if the declaration is **absent or older than its source**; every other extension is served raw |
| 3a | **Workspace root** | `workspaceDir` + `emitAllowlist` | **policy-gated** — the worker cannot escape the sandbox directory, and the *base* directory is trusted only when it is the session root or an allowlisted one |
| 3b | **Task unit scope** | `targetFiles`, `unitScope: 'enforce'` | **conditional** — refused for undeclared paths, but **a unit that declares nothing is unrestricted across the workspace** |
| 4 | **Flakiness containment** | `runVerification` runs 3 passes by default | non-deterministic drift records `UNIT_FLAKY` and halts promotion |
| 5 | **Promotion socket** | `scripts/check-promotion.cjs` | any post-verdict edit flips the exit code to 1 |

Four of those are qualified and the qualifications matter more than the rows:

- **Row 3a is policy-gated, not merely declared.** Containment of the emitted files is sound — both sides
  are canonicalised, so a symlink or a `..` cannot escape the base. What the base *is* was a model-visible
  argument, so naming a directory outside the session workspace used to make every later check true by
  construction. The base is now trusted only when it is the session workspace, a path inside it, or under
  an `emitAllowlist` root; anything else prompts, and is refused when no approval service is reachable.
- **Row 3b is opt-in.** The workspace root is a hard perimeter; the *unit* boundary exists only when the
  architect declared one, and nothing forces it to. Confusing the two is how a table reads as five
  unconditional boundaries when one is a contract property.
- **Row 2 is provenance, not verification.** The read is redirected to a declaration the build emitted, and
  staleness is checked by **mtime** — evidence that a rebuild happened, defeated by a `touch`, a checkout, or
  clock skew. `tsc` is trusted, not proven.
- **Row 5 binds content; it does not authenticate a person.** An `OPERATOR_ATTESTED` record holds a SHA-256
  and two self-reported strings. Editing the file flips the socket to 1, but nothing verifies that the named
  operator did the reviewing. That is **tamper-evidence, not cryptographic non-repudiation** — there is no
  key, no signature, and no third party.

### Three refusals that used to be fail-open

Both of these are boundaries that reported success while the condition they exist to catch was true, so
they are recorded as refusals rather than as features.

**A scope resolved against an unestablished workspace is refused.** Under `sourceReadEgress:
'declarations'`, a relative scope is resolved against the session workspace. When no workspace could be
established — no `DSH_WORKSPACE_ROOT`, no workspace from the host — the base used to fall back to
`process.cwd()`, which is a *guess*: it is whatever directory the server happened to start in. A relative
scope resolved against a guess cannot be shown to avoid source, so it is refused instead, naming the
condition (*"…this scope was resolved against the process working directory — a guess — and its reach
cannot be shown to avoid source"*). Absolute paths are unaffected. The distinction is recorded as
provenance rather than inferred from a path: the resolver now reports whether the base was *verified*
(`DSH_WORKSPACE_ROOT` or a session workspace the host supplied) or merely *fell back*, and the evaluator
fails closed on the unverified case. `contextFiles` injection is outside this control; it is governed by
containment and credential checks instead.

**A content-reading shell command is refused on an unverified base too.** A shell command is the one route
where the scope the host will resolve never reaches the evaluator *as* a scope — it travels inside a
command string — so `grep TODO docs/findings.md` was served on a guessed base while the search route
refused the same file as unresolved, and `rg TODO docs` was allowed where a proven base refuses it,
because the directory predicate answers against the guess as well. The question is now asked on this route
too, and asked *after* the three specific shell refusals — a named source file, a directory scope, quoting
that cannot be parsed — because those are true whatever the base turns out to be, and a later change to
the base question must not be able to hide them. A command that only *lists* a directory reads no bytes
and keeps its allow.

**A context file larger than the byte ceiling is refused before it is read.** `contextFiles` requests
carry a `maxBytes` budget, and the check that enforces it used to run only when the request asked for a
*whole file*. A request naming a line range — `startLine`/`endLine` — skipped it, so a 5 MiB file was read
into memory in full and dropped afterwards when it overran the budget. The read, not the injection, was
the exposure: the bytes were already resident before anything decided they were too many. The size check
is now unconditional, so the refusal happens **before** the buffer is allocated. The trade is deliberate
and worth stating: a file larger than the entire remaining budget is refused even when the request wanted
one line of it, because the budget bounds a file's total size and there is no smaller read on that path.

### Declarations mode: what the read control actually does

`sourceReadEgress: 'declarations'` is **opt-in**; the default is `'source'`, under which a read returns the
file. Arming it changes what a read of a *covered* file returns. Five facts bound what that means, each
stated at the level it is enforced — describing this control by its intent rather than its mechanism is
how it gets quoted for properties it does not have.

**1. The substitution happens on the tool-return payload, after the read.** The mechanism is registered on
**`tools/post-execute`**. The tool execution layer reads the file from disk exactly as it otherwise would;
the hook then replaces the returned payload with the compiled declaration before it enters the model's
context. Body bytes are withheld from the **model**, not from the **filesystem** — any process on the
host, including this plugin's own worker, can still read the file. Blocking mutation is a separate
mechanism (`tools/pre-execute`); this one is egress only.

**2. A refusal names the condition, and there are three of them.** When no declaration can be served the
read is refused rather than silently falling back to source:

| condition | what the reader is told |
| --- | --- |
| no skeleton was emitted for the path | *"…was refused: sourceReadEgress is 'declarations' and no type skeleton exists at '…'"* |
| the skeleton is older than its source | *"…its type skeleton at '…' is OLDER than the source, so it may describe a signature that has since changed"* |
| a code extension no build can map (`.py`, `.go`, `.rs`, …) | *"…was refused: sourceReadEgress is 'declarations' and no type skeleton can be produced for …"* |

These three are the conditions under which no declaration can be **served**. The same mode refuses for a
different reason when a shell command searches a **directory** rather than naming a file — the arguments
reach files the serve path never sees — and when a command's quoting cannot be parsed deterministically,
so the arguments it names cannot be shown to avoid source at all. The first of those is the rule that makes
`rg SECRET src` a refusal while `Get-ChildItem src` is still a listing.

Staleness is decided on **file mtime**, not on content. It is evidence that a rebuild happened after an
edit, and it is defeated by a `touch`, a `git checkout` or clock skew: it closes the common case —
planning without building — and does not prove the declaration matches the source. This is **provenance,
not verification**.

**3. Coverage is exactly four extensions.** `declarationPathFor` returns a path for `.ts`, `.tsx`, `.js`
and `.jsx`, and `null` for everything else, so reads of `.json`, `.cjs`, `.mjs`, `.md`, `.yml`, `.py`,
`.go`, `.sh`, `.ps1`, `.sql` — or any other extension — are **served raw, in both modes**. The control
stops at the four, and the benchmark record measures it: the fixture-audit task returns the same nine
matches in both arms precisely because both of its files are outside the covered set.

**4. The substitution does not prompt; the controls around it do.** The post-execute redirect is
deterministic and non-interactive — no *allow this read?* dialog appears for a covered source file. That
holds for *this hook only*. Around it, `delegateReadPolicy: 'ask'` (the default) prompts when reading back
a file a worker wrote, `guardMode: 'ask'` and `guardAskPaths` downgrade a deny to an approval prompt, and
the approval seam fails closed when no answerer is reachable.

**5. Three egress paths sit outside this hook.** It filters tool *result* payloads, so it never sees:

- **`contextFiles` injected into a worker's prompt** — governed by containment and credential checks, not
  by `sourceReadEgress`, and the architect receives a record of what was injected rather than contents;
- **files outside the four extensions** (point 3) — returned whole;
- **the outbound payload the desktop host assembles** — the host builds and dispatches the final request
  *after* this plugin's hooks have run, so assistant output and tool results are not inspected here.

**Bottom line, as a bound rather than a slogan.** With the control armed, a read of a covered `.ts`,
`.tsx`, `.js` or `.jsx` file returns the compiled type declaration or is refused; it does not return the
body. That is not the claim that the model cannot reach source — it is the claim that *this read path, for
these four extensions*, does not carry it.

## For an enterprise review

Enterprise evaluation of hybrid frameworks usually stalls on **structure**, not on hardware efficiency or
token cost. The recurring objection is that a cloud agent with host tool access relies on prompt
instructions ("do not modify out-of-scope files") or reactive approval popups — permission that is a pause
rather than a boundary, and an author that grades and commits its own work.

Three things here address that directly, each with its limit stated beside it, because a control whose
limits are hidden is the thing enterprise review exists to catch.

**1. Separation of duties is mechanical, not instructed.** The cloud model is an architectural oracle. It
is blocked from file mutation and shell execution at `tools/pre-execute` — across the fifteen routes in
[`control-bypass.test.cjs`](plugin/tests/oracles/control-bypass.test.cjs), four refused outright and eleven
held for approval, none reaching source without a grant. Mutation authority sits with a local worker inside
a bounded workspace.
*The limits:* containment **inside a chosen base** is unconditional — a symlink or a `..` cannot escape it
— but the **base itself is policy-gated**, because `workspaceDir` is a model-visible argument: the session
workspace and allowlisted roots are trusted, anything else prompts, and is refused when no approval service
is reachable. Beyond that, **the per-file `targetFiles` restriction is conditional on declaration** — a unit
that declares nothing is unrestricted across the workspace. A policy that forces declaration is a reasonable
ask and is not built.

**2. Promotion is tamper-evident rather than a vibe check.** Git shows commits; it does not show whether a
remote model or a certified local unit produced the bytes. The promotion socket binds a file to a SHA-256
registered during on-box consensus (three runs, with non-deterministic drift recorded as `UNIT_FLAKY`) or
explicit human review (`OPERATOR_ATTESTED`). Any post-verdict edit invalidates it and the socket exits 1.
[`promotion-socket.oracle.mjs`](plugin/tests/oracles/promotion-socket.oracle.mjs) covers all twelve
judgement cases and **runs in CI** — a missing verdict branch is the bug it exists to catch, because a
fall-through to a generic refusal is indistinguishable from correct strictness.
*The limits:* the registry is **per-machine and not in the repository**, so the socket is a local pre-commit
gate rather than a CI gate; `operator` is **a self-reported string with no key and no signature**, so an
attestation is caller-*attributed* metadata rather than an authenticated identity; and an attestation covers
**only files the unit actually wrote and verified**, because the gate is membership in that unit's
`filesWritten` and a unit that wrote files cannot reach `SUCCESS` unverified. What that closes is a caller
attesting an arbitrary readable path from a delegation that wrote nothing — the shape that forged a human
review over an untouched file. What it does not close is a caller **naming a person**, which no amount of
gating inside this process can establish. That is tamper-evidence, not cryptographic non-repudiation.

**3. The planning tier receives API surface, not implementation.** With `sourceReadEgress: 'declarations'`,
a read of a covered source file is answered with the compiler-emitted `.d.ts` stub, so the architect plans,
decomposes tasks, designs contracts and specifies tests against exported types and signatures rather than
against bodies. That is a **boundary rather than an instruction**: it does not rely on the model choosing to
respect module limits, and unlike a prompt it cannot be argued with. Measured on this repository: **zero**
`for`/`while`, `if`/`switch` and `fs.` calls in the served declarations, against 16, 80 and 2 in the sources.
*The limits:* coverage is exactly four extensions — `.ts`, `.tsx`, `.js`, `.jsx` — and every other file
(`.json`, `.cjs`, `.mjs`, `.md`, `.yml`, `.py`, `.go`, `.sh`, `.ps1`, `.sql`) is served **raw in both
modes**, so this bounds one read path rather than "the model cannot see source"; `contextFiles` injected to
a worker, and the outbound payload the host assembles after these hooks run, sit outside it entirely. The
build is **trusted, not verified** — staleness is checked by `mtime`, which a `touch`, a checkout or clock
skew defeats — the option is **off by default** and needs a plugin restart, and the worker that implements
is not governed by it at all. **It is a structural control, not a savings claim**: this plugin's cost and
privacy claims were measured and retired — see [Retired claims](docs/empirical-findings.md#retired-claims-and-why) — and nothing here
changes those numbers.

### What an enterprise review will find missing

Stated here rather than discovered in a procurement conversation:

- **The registry is local, unsigned and per-machine.** Audit records cannot live only on laptops; they need
  signing with a real identity and shipping to a central manifest or attestation store.
- **An attestation is not durable.** A later delegation touching the same file supersedes the record —
  correct semantics, since a verdict describes content, but it means a human attestation must be
  re-established and is not a permanent certificate.
- **Task scoping is opt-in**, as above: nothing forces an architect to declare `targetFiles`.
- **A personal project at 0.2.1.** The API is not frozen. The honest limits are documented rather than
  glossed, which is the trait an evaluation should weigh in its favour given how rare it is.

The proposition is not that this shaves a metered bill — measured, that is worth about **fifteen cents**. It
is that local hardware becomes a boundary with a record behind it, and that the model which specifies the
work is provably not the one that writes it.

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
  [Retired claims](docs/empirical-findings.md#retired-claims-and-why) rather than deleted, because a control whose author has
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


### Signed generation records

A resolved delegation can be signed. With `attestationPrivateKeyPath` set to a PKCS#8 Ed25519 key, the
verdict carries an `attestation` envelope whose payload is RFC 8785 canonical JSON binding the base
commit, the whole contract set with a digest over it, the artifact paths and hashes, and the verification
command with its observed exit status. Deterministic serialization is what makes that a signature over
*bytes* rather than over an object whose property order varies between runs.

**Spec 1.1 records the contract set, not only its digest.** A 1.0 payload carried `contractHash` alone —
a digest over `{path, sha256}` pairs the document never contained — so recomputing it meant already
knowing the input, and a record whose contract set could not be reconstructed was unverifiable rather
than wrong. From 1.1 the payload carries the array beside the digest, so a reader reproduces the hash
from the document itself and checks every contract against disk with no path convention involved.

**Spec 1.2 adds a second principal, not a second copy of the first.** The plugin's planner still emits
1.1; a 1.2 record is written by `scripts/attest-unit.cjs`, which signs an execution receipt at the end of
the worker run and a separate reviewer approval afterwards, under two different keys. What that second
signature is worth depends entirely on where its key is pinned — see *Dual attestation: the worker receipt
and the human reviewer* above.

The operator key is pinned by fingerprint rather than by the file alone: `TRUSTED_OPERATOR_PUBKEY_SHA256`
in `scripts/operator-key.cjs` is computed over the LF-normalised public key, and both
`keys/delegation-operator.pub` and the key derived from the local private key are checked against it. That
is not out-of-band immutability — a writer who can change the key can change the constant in the same
commit — it forces a trust-root change into a distinct, reviewable diff instead of a silent working-tree
substitution. `scripts/attest-unit.cjs` signs a unit against the same pin, so a signature the audit would
reject is refused before it is created; `scripts/verify-delegation-ledger.cjs` audits the whole ledger, and
`npm run gate` runs that audit together with the contract, architecture and coverage checks.

**What it establishes, and what it does not.** It binds a payload to a key: the holder signed those
bytes and nothing in them changed. It does not establish who holds the key. The key lives in this
process, so the record is evidence against anyone without it and no evidence against anyone with it,
and the worker never holds one. Call it **key-attributed tamper-evidence**, never non-repudiation:
the gap closes only when the private key is under the operator's sole control, in a hardware token or
an OS keystore this process cannot read.

**The worker not holding a key is not the key being out of reach.** Verification runs out of process
as your own OS user, so a test file the worker wrote and a command you approved can read whatever you
can. Keep the key outside the workspace on a user-only ACL, and run verification that touches
model-authored code in a container that cannot see it.

**It is withheld rather than weakened.** No readable key, no readable base commit, no verification
process, a unit that did not end `SUCCESS`, or a unit that wrote no files, and nothing is signed — the
verdict says so in `attestationSkipped`. The last two are what stop a vacuous green record: a verification
can pass because the tree was already correct, so a signed envelope over an empty artifact list would
attest a passing check over nothing, and nothing downstream could tell it from a verified change. The base
commit is read
from the workspace, never accepted from a caller, for the same reason the registry re-hashes files
instead of trusting a supplied hash. Two further limits: `stdoutHash` covers the **redacted** output,
because the raw log stays local, and an unobserved exit status is recorded as `-1`, never `0`.

**Storage is a second and independent opt-in.** `attestationNotesRef` writes the envelope as a git note
against the anchored commit. This is Git-anchored metadata storage, not an append-only ledger:
`refs/notes/*` can be rewritten or deleted, `-f` overwrites a re-run, and git neither fetches nor pushes
it without an explicit refspec (`git push origin refs/notes/delegations:refs/notes/delegations`). What
makes a record tamper-evident is the signature, not the ref. The plugin never pushes, and a failed write
is reported in `attestationNotesStatus` beside an intact verdict rather than failing the unit.

For the complete threat model, key containment invariants, and CI verification mechanics, see
[`docs/governance.md`](docs/governance.md).

This is a provenance record, not a compliance claim. It gives a security or audit pipeline a
machine-checkable statement of what was produced and what checked it; what any given regime requires
of that statement is for the people answerable for the regime, not for this file.


## Requirements

- **Node.js 22+**
- **A local OpenAI-compatible server** if you want local routing or `delegate_worker`
  (LM Studio on `127.0.0.1:1234` by default; anything else via `localEndpoint`)
- **A cloud provider** for the architect role (DeepSeek by default)

**No container runtime is required.** Verification runs as an ordinary child process. A container
is optional hardening — see [Verification](plugin/README.md#verification-runs-as-a-subprocess--a-container-is-optional-hardening).

## Install

DSH does not read plugins from a config file — **there is no `config.json` and no `plugins` array
to edit.** A DSH install is one or more **profiles**, each a directory at `$DSH_HOME/profiles/<name>`
holding a `package.json` and a `cordis.patch.yml`, and installing a plugin means adding it to the
profile you boot.

### From npm

```bash
dsh plugin --profile web add dsh-plugin-coding-delegate
```

`dsh plugin` forwards its remaining arguments to pnpm inside the profile directory, so this is a
`pnpm add` underneath. Substitute whichever profile you actually boot — `web` for the CLI, `tauri`
for the desktop app, `headless`, or one of your own.

### From this checkout

```powershell
# The CLI profile is `web`; the desktop app boots `tauri`.
.\scripts\register-plugin.ps1 -Profile web
```

The script installs `plugin/` into the profile, adds the bundle to `dsh.profile.bundles`, and merges
the plugin config and provider entries into that profile's `cordis.patch.yml`. By hand, that is:

```bash
dsh plugin --profile <name> add ./plugin
# then add "dsh-plugin-coding-delegate" to dsh.profile.bundles in
# ~/.dsh/profiles/<name>/package.json
```

### From a pinned tag, for a restricted or air-gapped host

```bash
dsh plugin --profile web add github:jjmlovesgit/dsh-plugin-coding-delegate#v0.5.5
```

Pin the tag whose controls you have audited rather than tracking `main`. How a release is verified against
its own tag is recorded in [`docs/releasing.md`](docs/releasing.md); the records themselves are covered in
[Technical auditability and provenance](plugin/README.md#technical-auditability-and-provenance).

### Confirm it loaded

```bash
dsh --profile web --dump-config
```

The plugin's row id **`local-router`** appears in the composed tree. It will not fail silently
instead: a bundle that does not resolve fails startup loudly rather than booting without the control.

### What is not an install

`npm install -g dsh-plugin-coding-delegate` places files on the machine and registers nothing — no
profile lists the plugin, so the runtime never loads it. A `plugins` array in `~/.dsh/config.json` is
read by nothing in the runtime; an earlier version of this repository's own registration script wrote
one, reported success, and now deliberately does not.

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

## Operator requirement: self-verifying delegations need a top-level session

A delegated unit cannot verify itself from inside a subagent — DSH pins a child agent's `approvalPolicy` to
`'never'`, so the approval seam is absent and the verification is refused with `VERIFICATION_NOT_APPROVED`
(*"approval was not granted"*). Run the delegation from a top-level session, and allowlist the program it
calls in your profile. Measured cost of getting this wrong: **179,840 tokens on the verification loop plus
440,500 around it**, against one delegation call when the loop stayed in the contract.

The full explanation, the profile snippet, and the settings that widen the allowlist:
[plugin/README.md](plugin/README.md#self-verifying-delegations-need-a-top-level-session).

## Checking that delegated work is verified

A repository can gate on the verdicts without the plugin touching git:

```powershell
node scripts/check-promotion.cjs --changed        # pre-commit: nothing changed since its verdict
node scripts/check-promotion.cjs --path src/x.ts  # one file
```

Exit **0** means settled; **1** means not; **2** means the question could not be answered — an unreadable
registry is a refusal, never a pass. It recomputes each file's hash, because a verdict describes *content*:
a file that passed and was then edited is not the version anything verified. It covers files a **delegated
worker** wrote; one written by the architect or by hand has no record and reports as unknown.

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
| [`experiments/delegation-ab/`](experiments/delegation-ab/) | the A/B protocol that produced the retired claims, including the run that could not be taken and why || [`experiments/contract-first/`](experiments/contract-first/) | an unsatisfiable contract preserved as evidence, and its corrected sibling |
| [`docs/enterprise-governance.md`](docs/enterprise-governance.md) | the control mapping: SOC 2 CC8.1, ISO/IEC 42001 and EU AI Act obligations against what is actually enforced |
| [`docs/empirical-findings.md`](docs/empirical-findings.md) | the retired claims and their measurements, plus the audit system explained in plain English |
| [`docs/findings.md`](docs/findings.md) | defects found, with what each one cost |
| [`docs/experiment.md`](docs/experiment.md) | measurements, including the ones that undercut the plugin |
| [`docs/control-effectiveness.md`](docs/control-effectiveness.md) | the five-point design against what is actually enforced, tested, or only documented |
| [`docs/verification-architecture.md`](docs/verification-architecture.md) | why the loop has to put verification on-box, and the one tier where that reasoning breaks |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | what was built, measured and retired |
| [`scripts/check-promotion.cjs`](scripts/check-promotion.cjs) | the promotion socket: gate a commit on whether delegated work is verified |
| [`scripts/verify-release-tarball.ps1`](scripts/verify-release-tarball.ps1) | checks a published tarball against its release tag blob-for-blob, in both directions |
| [`scripts/measure-reading-cost.cjs`](scripts/measure-reading-cost.cjs) | what the architect actually reads, from the plugin's own audit trace |

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
node scripts/check-dist-in-sync.cjs         # builds, then requires dist to be staged
node scripts/check-contract.cjs --spec      # specification-conformance suite
```

## Security

The plugin was reviewed externally, and the response to that review — including the defects found
and left unfixed, with reasons — is in [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md).

## License

MIT — see [`LICENSE`](LICENSE). The package carries its own copy at [`plugin/LICENSE`](plugin/LICENSE),
because the published artifact is standalone.
