# Attestation spec 1.2 — dual-signature provenance (PLAN, NOT YET IMPLEMENTED)

**Status: specification only. No 1.2 code, key, or note exists.** This document exists so the next
session resumes at Step 1 with no context drift. Nothing here has been built; the plan is what was
agreed, and the ordering is load-bearing.

Baseline it was written against: `main` at `26ac54b`, tag `v0.5.2` → `314b8a4` (published to npm),
ledger `refs/notes/delegations` at `fd4b2d2` with 7 notes, four-stage `npm run gate` green.

## What 1.2 is for

1.1 binds a worker run to the artifacts it produced, under one Ed25519 operator key. 1.2 adds a
**human reviewer as a separate principal**: the operator key proves execution integrity (this model,
this prompt, this contract, this duration), and the reviewer key proves human authorization (a named
person inspected the diff against `baseCommit`).

The whole value depends on one thing: **the reviewer key must be pinned out-of-band.** Both keys pinned
by constants inside the repository being verified are exposed to the same attacker — we established, and
documented in `scripts/operator-key.cjs`, that a committer who can edit a pinned constant can re-pin it.
That makes a trust-root change *visible in review*; it does not make it impossible. Two signatures under
one mutable root are not two independent principals, and the document must not imply otherwise.

## The 11 settled decisions

1. **The field stays `specVersion`, with value `'1.2'`.** Not `schema`. Every existing check keys on
   `specVersion` — the 1.0/1.1 branches, the ancestry cutoff, contract coverage — and a second field
   name would silently orphan all of it.
2. **The 1.1 payload shape is preserved.** `artifacts`, `contracts`, `baseCommit`, `verification` keep
   their names and meaning. There is no `target` (that is `artifacts[0].path`), and `worker.stdoutHash`
   is not new — it already exists as `verification.stdoutHash`, the digest of the redacted output. 1.2
   adds `worker{}` and `reviewer{}` blocks; it does not rename what is already recorded.
3. **Both envelopes are signed over canonical JSON**, `canonicalizeJson(payload minus that signature)`
   via the existing RFC 8785 canonicaliser — **signing the canonical BYTES directly, not a digest of
   them.** The plan specified `sha256(canonicalizeJson(...))`; Ed25519 hashes the message internally
   (RFC 8032) so an extra SHA-256 buys nothing, and the repository's existing envelope scheme
   (`signManifest` / `verifyEnvelope`) signs the payload string rather than a digest of it. One signing
   convention, because a signer that hashes first and an auditor that does not would reject every 1.2
   note silently and totally. **No concatenated tuple**: hashing variable-length fields with no
   delimiters collides across field splits (`"ab"+"c"` vs `"a"+"bc"`).
4. **Ed25519 PEM keys, not OpenSSH wire format.** There is no SSH public-key parsing anywhere in the
   plugin or `scripts/`, and Node cannot verify an OpenSSH key without conversion. Supporting
   `id_ed25519.pub` would add a key-format axis to a PEM-only toolchain for no gain.
5. **Private keys never enter the repository.** Operator key stays at
   `~/.dsh/keys/delegation_ed25519.pem`; the reviewer key goes to
   `~/.dsh/keys/delegation-reviewer.pem`. The repo holds public keys only.
6. **The out-of-band pin is authoritative.** `DSH_REVIEWER_PUBKEY` (a PEM path or the PEM itself) and
   `DSH_REVIEWER_FINGERPRINT` are consulted FIRST, and when present they are the only trust root used.
7. **The in-repo fallback is for local bootstrapping only**, and it announces itself:
   `keys/delegation-reviewer.pub` is accepted only when no out-of-band pin is set, and the audit prints
   `[AUDIT_NOTICE: in-repo reviewer key used; out-of-band pin recommended for CI]`. Silent use of the
   weaker root is the failure this notice exists to prevent.
8. **Fail closed when neither root is present.** A 1.2 note with no resolvable reviewer key is
   **rejected** — never downgraded to 1.1 checking, never accepted with an `UNVERIFIABLE` result. The
   check cannot pass by not running.
9. **The reviewer key must differ from the worker key.** If `reviewer.keyFingerprint` equals the
   operator fingerprint, the note is refused: a worker approving its own output is not review.
10. **Timestamps are ordering evidence, not a security property.**
    `reviewer.timestamp >= worker.timestamp` is checked and reported, but both values are self-asserted
    by the signing side. A clock is not a control, and the document must say so rather than let a reader
    infer that ordering proves anything about who acted when.
11. **Staging is `.git/dsh-attestation-pending.json`, and attachment is atomic.** `--prepare` writes a
    pending envelope inside `.git/`, which is untracked and cannot be committed; `--approve` attaches the
    finished note exactly once. A half-formed 1.2 note must never reach the ref, because a 1.2 payload
    missing its reviewer block now fails the audit — the ledger would go red between the two phases.
    Pushing the ref stays the operator's explicit step.

## Trigger semantics: the declared version, not an ancestry cutoff

`SPEC_1_1_CUTOFF` exists because 1.0 notes were **legitimate** before 1.1 and must stay grandfathered by
ancestry. There is no legacy 1.2, so a cutoff buys nothing and costs two things: the constant would have
to name a commit that does not exist yet (the chicken-and-egg we already hit), and any note created
between the signer landing and the cutoff being set would sit unenforced.

**The rule is therefore: if a payload declares `specVersion === '1.2'`, it must carry a valid,
independently-pinned reviewer signature, or it is rejected.** A 1.2 claim without one is a lie about the
note's own format, which is a self-inconsistency the auditor can refuse on sight. The 1.0 branch
(convention-reconstructed `contractHash`) and the 1.1 branch (self-described contracts plus
discrimination-gate coverage) are unchanged, and the 7 existing notes keep verifying exactly as they do
today.

## Safe execution sequence

The order is not stylistic. **Signer-first is fail-open**: a 1.2 payload already satisfies
`Array.isArray(payload.contracts)`, so today's auditor accepts it on the 1.1 branch — and a note that
claims dual attestation while nothing verifies the second signature is worse than no 1.2 at all, because
it reads as enforced. The auditor must land before, or with, the signer.

1. **Reviewer keypair.** Generate Ed25519 PEM; private key to `~/.dsh/keys/delegation-reviewer.pem`,
   public key to `keys/delegation-reviewer.pub` for the fallback, and record its fingerprint.
2. **Auditor branch** in `scripts/verify-delegation-ledger.cjs`: out-of-band precedence, fallback notice,
   fail-closed when neither, distinct-key refusal, timestamp comparison, and the 1.2 payload checks
   (worker signature, reviewer signature, both tree-anchored artifact/contract digests).
3. **Four red-team probes** in `scripts/redteam-probe.cjs`, each asserting its own specific refusal
   string and requiring a non-zero exit: missing reviewer signature; forged/invalid reviewer signature;
   unpinned/unknown reviewer fingerprint; reviewer key identical to the worker key. Each needs
   fail-before evidence, which means building the probe against the pre-change auditor first.
4. **Verify the 7 existing notes are untouched** and `npm run gate` is green. Commit.
5. **Signer** in `scripts/attest-unit.cjs`: `--prepare` (worker run, contract, worker signature, pending
   file, attaches nothing) and `--approve` (inspect the diff from `baseCommit`, confirm the human
   identity, sign the reviewer block, attach once, delete the pending file).
6. **End-to-end in a throwaway clone.** Create a real 1.2 note there and check that it is accepted, and
   that each of the four attacks is rejected. **No 1.2 note touches the published ledger without
   explicit operator approval** — the note is a published record and the ref is pushed deliberately.
7. Gate, oracles, probes, `dist` parity. Release as `v0.5.3` only if wanted; `v0.5.2` is immutable.

## Tranche 3: the three-signature ordering (pinned before implementation)

A 1.2 note carries **three** signatures, not two, and the order is forced rather than stylistic.

| signature | produced by | signed over |
|---|---|---|
| `worker.signature` | `--prepare` | `canonicalizeJson(payload \ {reviewer, worker.signature})` |
| `reviewer.signature` | `--approve` | `canonicalizeJson(payload \ {reviewer.signature})` — includes the frozen worker block |
| envelope `signature` (check 1) | **`--approve`, last** | the completed payload string |

**THE ENVELOPE MUST BE SEALED LAST.** Check 1 (`verifyEnvelope`) runs on every note, 1.2 included, so the
envelope signature has to exist — but it can only be computed once the payload is final, and appending the
reviewer block changes the canonical payload. A `--prepare` that seals the envelope would therefore
invalidate itself the moment `--approve` adds the reviewer, and every 1.2 note would fail check 1. So
`--prepare` writes a payload that is deliberately **unsigned at the envelope level**: worker block signed,
envelope open. `--approve` adds the reviewer block, signs it, and only then seals the envelope with the
operator key.

Each signature is excluded from its own signing payload. That is what stops the second signature
invalidating the first: the worker signs a record without the reviewer block, so its signature survives
the review, while the reviewer signs a record *including* the worker's signature, so it binds to the
worker's receipt rather than to some later form of it.

**`--approve` REQUIRES an explicit `--reviewer-identity`.** Deriving the identity from the environment is
how a session UUID gets recorded as a human reviewer — the failure `attestation-identity.oracle.mjs` exists
to catch — so an absent or empty flag is a refusal, not a default.

### Clone lifecycle test protocol

Two constraints, both learned the hard way in this repository:

1. **Copy the uncommitted scripts into the clone.** `git clone` yields committed code, so a lifecycle test
   that runs in a fresh clone exercises `HEAD`, not the signer under test. Three measurements in this
   session were broken by exactly this; the clone must receive `scripts/attest-unit.cjs`,
   `scripts/verify-delegation-ledger.cjs` and `scripts/redteam-probe.cjs` before anything runs.
2. **Fetch the ledger explicitly.** `git clone` does not carry `refs/notes/*`, and the audit now fails
   closed on an empty ledger, so `git fetch origin refs/notes/delegations:refs/notes/delegations` seeds
   the 7 existing notes and lets the empty-ledger rule pass legitimately rather than be worked around.

## Traps this repository has already paid for, worth not repeating

- **A test that passes vacuously.** Assert the extraction is non-empty *before* inspecting it, or an
  empty result looks like a pass. An oracle here did exactly that, and the leak assertions "passed" over
  nothing.
- **A nested runner.** An oracle that spawns `node --test` from inside `node --test` inherits the test
  context env and emits no TAP `not ok` lines. Strip `NODE_TEST_CONTEXT` and `NODE_OPTIONS` before
  spawning.
- **A too-loose pattern.** `/[A-Za-z]:/` matches the `s:` in `cjs:4:11` and fails a correct relative
  path. Assert a drive letter as `/[A-Za-z]:[\\/]/`.
- **A flag that silently does not apply.** `npm run test:oracles -- --test-concurrency=1` appends the
  flag after the file glob, where node ignores it: measured 3.0s ignored against 10.5s honoured. The
  effective form puts it before `--test`.
- **A pathspec that silently does not match.** `git checkout HEAD -- plugin/dist/x.js` run from `plugin/`
  fails and leaves the tree untouched, so a "before" and "after" measurement can be the same build.
- **A swap-and-restore that stages the swap.** `git checkout <rev> -- <path>` writes the old blob into the
  INDEX as well as the working tree, so a fail-before measurement that swaps a file that way and restores
  only the working tree will commit the swapped version. MEASURED: it committed a reversion of the 1.2
  branch and pushed it, with the new probes left unstaged beside it. Restore through the index (`git add`)
  and confirm with `git show :<path>` before committing — three separate measurements in this session were
  broken by a silent git mechanic rather than by the code under test.
- **CRLF, anywhere near a hash.** The signer hashes bytes on disk; the auditor reads the blob from the
  commit. `.gitattributes` now pins `* text=auto eol=lf`, and `scripts/check-file-hygiene.cjs` fails the
  gate on CRLF, a missing trailing newline, or a BOM.
- **Verification reads the tree, not the disk.** Artifact and contract digests come from
  `git cat-file` at `payload.baseCommit`. A working-tree edit does not invalidate an old note — and a
  signer that hashed CRLF disk bytes would produce a note the audit rejects.

## What 1.2 does not give you

With the in-repo fallback in use, a committer who can edit `keys/delegation-reviewer.pub` **and** the
operator pin can substitute both roots — the reviewer signature then proves nothing about a human.
Independence comes from the out-of-band pin, and only from it. The `[AUDIT_NOTICE]` exists so that a run
relying on the weaker root says so in its own output rather than reading as fully independent.
