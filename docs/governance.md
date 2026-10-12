# Governance: the attestation threat model

What a signed generation record does and does not establish, where the key lives and where it does
not, why the verification step is an execution vector, what happens when an invariant fails, and how
a downstream pipeline checks a record. Written as a threat model and a verification spec.

**This is not a certification, a compliance claim, or a security audit.** It describes mechanisms in
this plugin and states their limits beside them. What any particular regime requires of these
mechanisms is for the people answerable for the regime, not for this file.

The implementation lives in `plugin/src/crypto-attestation.ts`, `plugin/src/canonical-json.ts` and
`plugin/src/attestation-notes.ts`; the tests that pin the claims below are in
`plugin/tests/attestation.test.ts`, `plugin/tests/attestation-notes.test.ts` and
`plugin/tests/delegation-attestation.test.ts`.

---

## 1. Scope of the assertion

The record asserts, narrowly: **the host process executed the recorded verification command against
the recorded contract, at the recorded git commit, over artifacts whose hashes are recorded — and
nothing in that statement has changed since the key holder signed it.**

A signature binds a **payload** to a **key**. It establishes two things:

1. the holder of the private key signed exactly those bytes; and
2. nothing in those bytes has changed since.

It does not establish:

- **Who holds the key.** A signature names a key, not a person or an organisation. Section 2 covers
  where that key can live and what that is worth.
- **That the verification described actually ran as reported.** The record asserts that a command was
  executed and reports the status observed. The signature makes that assertion tamper-evident; it does
  not make it true. It was true when the plugin wrote it, which is the same claim any log makes.
- **That the host is uncompromised.** The thing that signs is the thing that records. If the host
  process is subverted, it signs whatever it is told to sign, and the signature is exactly as good as a
  forgery — because the forger is the signer. This is the same same-process limitation the README
  records for the ledger and the guard, and signing does not remove it. Closing it needs the recorder
  to be somewhere the recorded cannot reach.
- **That the worker had no ambient OS access while code ran.** This one is not a nuance; it is the
  boundary most readers will get wrong. The verification step **executes code**, and it executes it as
  the same OS user as the host. A signed record therefore says nothing about what that code did while
  it ran — what it read, what it sent anywhere. Sections 2 and 3 are about exactly this.

**In one sentence:** the record is evidence that the host asserted a specific contract and a specific
verification outcome against a specific commit and specific artifact hashes, and that the assertion has
not been altered since. Everything stronger than that has to come from somewhere else.

## 2. Key management: host-side, not OS-level isolation

**Where the key is read.** `attestationPrivateKeyPath` names a PKCS#8 Ed25519 private key **file**. The
plugin reads it with `fs.readFileSync` inside the plugin process and signs in that process. It holds
the key for the duration of that call, stores no key state, and writes no key material anywhere.

**The public half is derived, not provisioned.** `publicKeyFromPrivate` computes the SPKI public key
from the private key in memory. There is one file to provision rather than a pair that can disagree
silently — a mismatch there produces verification failures indistinguishable from tampering.

**The worker cannot ask for the key, because there is no worker subprocess.** `delegate_worker` reaches
the local model over HTTP: it POSTs to an OpenAI-compatible endpoint with a body containing the model
id, a system and a user message, and sampling parameters. No environment is passed, no working
directory is passed, no file descriptor is inherited, and the key path is not in the request. This is
stronger than "we do not put the key in the worker's environment" — there is no environment to put it
in. The model sees prompt text and returns text.

**But that is not key isolation, and the plugin does not claim it is.** What the paragraph above
establishes is that *the model* never holds the key. It does not establish that *code the model wrote*
cannot reach the key, and Section 3 is where that breaks.

## 3. The subprocess verification boundary

This is the load-bearing limit of the whole feature.

**How the command runs.** `runSandboxVerification` → `captureCommandOutput` spawns the verification
command with `shell: true`, `cwd` set to the workspace root, output routed to file descriptors, and
**no `env` override** — which means the child inherits the DSH host process's entire environment. It is
**not confined to the workspace**; the plugin's own refusal message for an unapproved command says the
command "would run with the full authority of the DSH process and is not confined to the workspace",
and that is a description, not a warning label.

It follows that the verification step runs **as the operator's user account, inside the operator's
ambient filesystem security context.** That ambient context — not this plugin — is the boundary.

**Two ways model-influenced code gets into that step:**

1. **The command itself.** `runVerification` is a tool argument, so the calling model supplies the
   string. This is the vector the approval seam was built for.
2. **The repository's own scripts — and this one the approval seam does not see.** `runVerification`
   is normally something innocuous like `npm test` or `pytest`, and it is approved *as a command*. What
   it actually runs is a test file that the local worker just wrote. Approving `npm test` does not vet
   the code inside it. A worker-authored script that walks the filesystem looking for a PEM file and
   posts it somewhere executes under an approved command and never appears in the approval prompt.

**The approval seam, stated honestly.** `verificationApproval` defaults to `'ask'`, routes the command
through the operator before anything executes, and fails closed when no approver is available — an
`ask` with nobody to answer is a refusal at the call site. That is a real control against vector 1.
It is not a cryptographic boundary, and `verificationAllowlist` is weaker than it looks **by
construction**: it matches the command's *first token* only, so allowlisting `node` also permits
`node -e "<anything>"`. The configuration's own documentation says so, and this document will not
describe it as containment.

**The DSH file sandbox is a write boundary, not a read boundary.** It is why a workspace-write session
can read a file anywhere on the host but cannot write one outside the workspace. It therefore does not
protect the confidentiality of a key file, and it is not a reason to keep one somewhere convenient.

**The consequence, plainly.** If verification executes code that an adversary influenced — directly, or
by way of a repository file the worker authored — and the key is readable by that user, then the key can
be read. A record subsequently signed with the real key is indistinguishable from a genuine one,
because it *is* one. No verification logic downstream can detect this. Only key custody can.

### Placements, and what each is worth

| placement | what it withstands |
| --- | --- |
| a plaintext PEM on the same filesystem as the workspace, readable by the operator's user | nothing. Any code run under the verification command, and any process running as that user, can read it |
| a file outside the workspace with a user-only ACL | other accounts on the host, and accidental inclusion in a commit or archive. **Not** code running as the same user — which is what verification is |
| a file readable only by a different account, with the host and its subprocesses running as another | process-level separation, for as long as that separation holds |
| an OS keystore or a hardware token that requires an unlock the host does not perform | the host cannot sign without the operator present — this is the only row that changes the trust domain, and the only one that closes the gap Section 1 describes |

**Nothing in this plugin requires the key to be on the same machine as the code**, and nothing about
the format prevents the private half from living in a token. What is true today is that the plugin
accepts a file path, so a file path is what it gets, with the consequence in the first row.

### What an operator should actually do

1. **Keep the key out of the workspace and out of the repository.** There is no reason for it to be
   anywhere near the tree being governed, and every reason for it not to be committable or archivable
   by accident.
2. **Restrict the file to the account that signs.** POSIX:

   ```bash
   mkdir -p ~/.dsh-keys && chmod 700 ~/.dsh-keys
   chmod 600 ~/.dsh-keys/attestation.pem
   ```

   Windows, removing inherited permissions and granting read to one principal:

   ```powershell
   icacls "$env:USERPROFILE\.dsh-keys" /inheritance:r /grant:r "$env:USERNAME:(R)"
   icacls "$env:USERPROFILE\.dsh-keys\attestation.pem" /inheritance:r /grant:r "$env:USERNAME:(R)"
   ```

   Understand what this buys: it excludes *other accounts*. It does not exclude the verification
   subprocess, which runs as this account by design.
3. **Treat any verification that executes model-authored code as untrusted**, and run it accordingly —
   a container or restricted runner with the key's directory not mounted and the host environment not
   passed through. A runner that is given the key so that it can sign has reintroduced the problem.
4. **Vet the command as a pointer, not as the whole story.** Reading `npm test` tells you what will be
   invoked, not what the invoked code does. The prompt is a checkpoint, not a sandbox.
5. **Prefer custody the host cannot read unattended.** A hardware token or an OS keystore requiring an
   operator unlock per signature is the only measure that changes the answer to "can a compromised
   verification step forge a record?" from yes to no.

## 4. Fail-closed states

Signing is opt-in and the decision is a value, not a control-flow accident. `buildAttestationPlan`
returns exactly one of three states, and "not opted in" is deliberately distinct from "opted in but
could not attest" — collapsing them would hide a misconfiguration behind a normal-looking silence.

| state | when | what the verdict carries |
| --- | --- | --- |
| `none` | no `attestationPrivateKeyPath` | nothing. No key is read, no subprocess spawns, and no field appears |
| `withheld` | opted in, and an invariant below did not resolve | `attestationSkipped` with the reason. **Nothing is signed** |
| `sign` | every invariant resolved | `attestation` with the envelope |

Each state is asserted through the real delegation path by an integration test, including that the
`none` case performs no git call at all.

### The invariants

| invariant | why it is required |
| --- | --- |
| a private key is configured **and readable** | there is nothing to sign with otherwise |
| the workspace is on a **readable git commit** | `baseCommit` is the anchor. An envelope anchored to a guessed commit would verify perfectly while attesting to a tree that never existed — worse than an absent record, because it looks like a complete one |
| a **verification process ran** | a record of an unchecked delegation is a claim about nothing |

`baseCommit` is **read** from the workspace with a read-only `git rev-parse`, never accepted from a
caller. The principle is already established elsewhere in this repository: `recordOperatorAttestation`
reads a file's hash from disk rather than accepting one, because a caller-supplied hash would let an
attestation be recorded for content that was never on disk. A commit is the same kind of fact.

**`withheld` fails closed without failing the unit.** A missing record is not a failed delegation, and
refusing verification work because metadata could not be produced would make the option hostile. The
unit keeps its verdict; only the record is absent, and the reason is named.

## 5. Deterministic canonicalization

A signature is over **bytes**, and two processes that agree on a document do not automatically agree on
its serialization: `JSON.stringify` preserves insertion order, so `{a,b}` and `{b,a}` are the same
object and different byte strings. The payload is serialized with **RFC 8785 (JSON Canonicalization
Scheme)** before signing, which is what makes "sign this record" a well-defined instruction.

**Why the same bytes come out in a different environment.** JCS is defined by *reference* to the
ECMAScript algorithms for numbers and strings rather than by a grammar of its own, so a conformant
implementation in any runtime produces identical output. The test suite pins this against the RFC's own
vectors rather than against the implementation's own output: the Section 3.2.4 canonical form
byte-for-byte, the Section 3.2.3 UTF-16 property ordering, and all 24 Appendix B number vectors built
from their IEEE 754 bit patterns.

Two deliberate divergences from `JSON.stringify` are **required by the RFC**, and both refuse rather
than coerce: NaN and Infinity must terminate rather than serialize to `null`, and lone surrogates must
error rather than be escaped.

**A property worth relying on.** The canonical payload is carried as a **string** inside the envelope,
and the signature is over those exact bytes. A verifier therefore does **not** re-serialize the payload,
so it does not need a conformant canonicalizer to check a signature — a whole class of
canonicalization-mismatch failures is removed by construction. (A consumer that wants to *compare*
records still needs one, which is what the vectors above are for.)

## 6. Storage

`attestationNotesRef` is a second and independent opt-in. Set to a full `refs/notes/...` path — the
repository's convention is `refs/notes/delegations` — the envelope is also written as a git note
against the commit it anchors to. Signing is a computation; writing a ref mutates the repository being
governed, and an operator may reasonably want one without the other.

**Storage is non-invasive and local by default.** The plugin writes a note and does nothing else: it
creates no commits, amends nothing, touches no working-tree file, and **never pushes**. A record stays
on the machine that produced it until an operator or a CI job publishes the ref explicitly.

**This is Git-anchored metadata storage, not an append-only ledger, and the difference is
load-bearing:**

- `refs/notes/*` is an ordinary ref. Anyone with write access can rewrite or delete it, and
  `git notes remove` exists.
- The plugin writes with `-f`, so **re-running a unit replaces its record** rather than failing.
- Notes are neither fetched nor pushed by default; an explicit refspec is required in both directions.

**What protects a record is the signature and the hashes inside it, not the ref.** A reader who verifies
the signature learns that the payload has not changed since it was signed, wherever it was found. A
reader who trusts the ref because it is a ref has trusted nothing.

Genuine append-only properties need a mechanism that enforces them — a WORM sink, or a transparency log
such as Sigstore Rekor. A git ref does not, and this document will not call it one.

Publishing is the operator's or CI's call:

```
git push origin refs/notes/delegations:refs/notes/delegations
```

**A failed write never fails a unit.** The code was verified and signed before storage ran, so
conflating the artifact with its receipt would fail a promotion over metadata. The verdict keeps its
envelope and reports `attestationNotesStatus` — `{ written: true }`, or `{ written: false, reason }`
naming a held lock, a corrupt notes tree or a permission error.

## 7. Verifying a record in a pipeline

Fetch the ref (notes are not fetched by default), read the note, **pin the key**, and check the
signature over the carried bytes:

```bash
git fetch origin refs/notes/delegations:refs/notes/delegations
git notes --ref=refs/notes/delegations show HEAD > attestation.json
EXPECTED_KEY=./ci/attestation-pub.pem node -e '
  const fs = require("fs"), crypto = require("crypto");
  const e = JSON.parse(fs.readFileSync("attestation.json", "utf8"));
  const expected = fs.readFileSync(process.env.EXPECTED_KEY, "utf8").trim();

  // The key carried inside the envelope is the artifact s own claim about itself. Verifying with
  // it proves only self-consistency: anyone able to rewrite the note can substitute their own key
  // and re-sign, and the check passes. Pin the key from somewhere the artifact cannot reach.
  if (e.publicKeyPem.trim() !== expected) {
    console.error("public key does not match the pinned key - refusing");
    process.exit(1);
  }
  const ok = crypto.verify(
    null,
    Buffer.from(e.payload, "utf8"),
    expected,
    Buffer.from(e.signature, "base64")
  );
  const p = JSON.parse(e.payload);
  console.log(
    (ok ? "signature OK" : "signature INVALID"),
    p.baseCommit,
    p.contractHash,
    p.verification.command,
    "exit=" + p.verification.exitCode
  );
  process.exit(ok ? 0 : 1);
'
```

**The pin is not optional.** An envelope carries its own `publicKeyPem` so that a verifier needs no key
registry to check one record — which is convenient, and which turns the check into a tautology if the
pinned key is not compared first. `crypto.verify` against the artifact's own key answers "is this
internally consistent", never "did the key we trust sign this". The library function
`verifyEnvelope` has the same shape and says the same thing in its own documentation: it does not
establish that `publicKeyPem` is the key it claims to be.

`git notes show HEAD` resolves while HEAD is the commit the record anchors to. After a later commit,
name that commit explicitly — the anchor is in the payload as `baseCommit`.

**What that exit code means.** `0` says the bytes are the ones the pinned key signed and nothing in
them has changed. It does **not** say the key belongs to whom you assume, that the verification ran as
reported, or that the host was honest. Those need the key custody described in Section 3 and whatever
independent evidence the regime asks for. A pipeline that treats a green signature as an assurance
beyond integrity has read more into it than it carries.

## 8. What would have to change for non-repudiation

Recorded so the gap is a plan rather than an implication:

1. **Key custody outside the host.** The private key must live where this process cannot read it without
   a human action — a hardware token, or an OS keystore the operator unlocks per signing operation.
   Until then, the signer and the recorded are the same trust domain, and Section 1's limit stands. This
   is also the only measure that survives Section 3, because no ACL helps against code running as the
   same user.
2. **A recorder the recorded cannot reach.** An external sink that the plugin can append to but not
   rewrite, so the absence of an alteration is evidence rather than a property of a local file.
3. **A pinned key identity, published out of band.** A verifier must have a key it trusts from
   somewhere other than the record — a registry, a CI secret, a signed policy file. Section 7 shows the
   pin; producing and distributing the pin is the operator's problem, not this plugin's.
4. **Counterparties.** Non-repudiation is a claim about a third party being able to rely on a record.
   Nothing in one machine's filesystem can establish that on its own.
