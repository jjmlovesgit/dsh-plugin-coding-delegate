# Egress Control Benchmark: Empirical Findings

A controlled evaluation of `sourceReadEgress: 'declarations'` in `dsh-plugin-coding-delegate`.

The point of this document is to replace architectural assumption with measurement. Every number below is
either read from a file on disk or counted from the plugin's own trace log; the two places where a claim
rests on reasoning rather than measurement say so.

The short version: **the control works exactly as designed, and its coverage is far narrower than its name
suggests.** That is the finding worth publishing.

---

## 1. What the control actually does (verified end to end)

With `sourceReadEgress: 'declarations'` and a valid `declarationRoot`, a read of a covered TypeScript file
is intercepted at `tools/post-execute` and replaced with the compiler-generated `.d.ts` skeleton.

**Verified live, not inferred.** A read of `plugin/src/declaration-egress.ts` returned the skeleton, with
the header the plugin prepends:

```
// SERVED AS TYPE DECLARATIONS, NOT SOURCE. Implementation bodies are withheld by policy
// Declaration file: C:\Projects\DSHLaya\plugin\dist\declaration-egress.d.ts
```

and the trace log for the same call:

```
[2026-10-10T19:48:17.120Z] === SOURCE_READ ===
[2026-10-10T19:48:17.133Z] === SOURCE_DECLARATION_SERVED ===      13 ms later
```

**Also verified in isolation.** Loading the built plugin in a throwaway process — no session, no host, no
profile — with those two options and driving one `read` dispatch returned `SERVED AS TYPE DECLARATIONS`
and did **not** return the raw text. The mechanism is a property of the built code, not of a lucky
configuration.

### Code transformation breakdown

`plugin/src/declaration-egress.ts` (172 lines, 8170 bytes) against the emitted
`plugin/dist/declaration-egress.d.ts` (37 lines, 1923 bytes):

| metric | raw source | served skeleton |
| --- | --- | --- |
| size | 172 lines / 8170 B | **37 lines / 1923 B** — 4.3x smaller |
| refusal message strings | **6** | **0** |
| quoted literals retained | 6 messages + strings | **type unions only** (`'allow' \| 'serve-declaration' \| 'block'`) |
| doc-comment lines | 60 | 21 (35% survive) |
| exported interfaces | 2 | **2** |
| exported function signature | 1 | **1** |

**The composition matters more than the ratio.** The skeleton is not a lossy compression of the file in
which detail is merely harder to find. For any task whose subject is *message text*, the bytes are
**absent**: a `.d.ts` carries type unions but no value literals. That is a difference in kind, and it is
the mechanical cause of the tier-2 cost in section 3.

**An asymmetry worth knowing before trusting a skeleton.** `mappableSourceFile` (a function) survives as
an exported declaration; `MAPPABLE_SOURCE_EXTENSIONS` (a module-private constant) does not. The skeleton
therefore exposes the *shape* of a policy but not its *data* — a signature that invites the assumption
its contents are knowable from here, when they are not.

---

## 2. Hard coverage boundaries

`declarationPathFor` (`guard.ts:571`) returns a declaration path for exactly four extensions and `null`
for everything else. The caller reads `null` as *"not a source file: nothing to strip"* and serves the
file unchanged (`index.ts:1413`). Verified against the built module:

| path | `declarationPathFor` | what a read returns |
| --- | --- | --- |
| `plugin/src/declaration-egress.ts` | `plugin/dist/declaration-egress.d.ts` (exists) | the skeleton |
| `plugin/tests/plugin.test.ts` | `plugin/dist/plugin.test.d.ts` (**nothing emits this**) | **refused** |
| `plugin/tests/fixtures/classifier-goldens.json` | `null` | **the raw file** |
| `scripts/verification-golden.cjs` | `null` | **the raw file** |
| `README.md`, `cordis.patch.yml` | `null` | **the raw file** |

- **Governed:** `.ts`, `.tsx`, `.js`, `.jsx`
- **Ungoverned:** `.json`, `.cjs`, `.md`, `.yml`, `.yaml`, `.py`, `.go`, `.rs`, `.sh`, `.sql` — and every
  other extension `CODE_EXTENSIONS` recognises but the mapper does not

**Stated precisely, because the distinction is easy to get wrong:** this is not general data-loss
prevention. It is type-skeleton redirection for a four-extension compiler-targeted tree. Repository
configs, fixtures, scripts and documentation are served **raw**, with no prompt and no refusal.

Note the second row: a `.ts` file under `tests/` maps through the basename fallback to a path
`tsconfig.json` never emits (`rootDir: ./src`), so under declarations mode reads of the test suite are
**refused** — not for sensitivity, but because the mapping produces a path nothing produces.

---

## 3. Operational friction by task category

One session per arm, three tasks per session, tree reset after each. Counts are confined to per-task log
line windows. This is **single-run** (n = 1 per task per arm); it can suggest, it cannot prove. The
underlying record, including its own void-condition caveat, is in [`PROTOCOL.md`](PROTOCOL.md).

| tier | arm A turns | arm B turns | delta | wall clock |
| --- | --- | --- | --- | --- |
| 1 — interface / signature work | 9 | 9 | **0** | n/a (A not timed at start) → 32.4 s |
| 2 — patching a message literal | 6 | 13 | **+7** | 18.2 s → **40.0 s** |
| 3 — fixture / raw-data audit | 5 | 4 | −1 (noise) | 5.7 s → 15.4 s |

### Tier 1 — no penalty, and section 1 explains why

Signatures and both exported interfaces survive into the skeleton, so a task that reads types and writes
a contract against them has everything it needs. The measured 0-turn delta is what the composition in
section 1 predicts.

### Tier 2 — a mechanical retry cost, not conversational delay

The task changes one refusal-message literal. Under arm B that literal is **absent from what the
architect can see**, so the agent entered a retry loop — two rejected patch attempts before reconstructing
the text blind — costing **+7 turns and +21.8 s**.

This is the finding with the most practical weight: the cost is not "the model thinks harder". It is
asking for bytes the served artefact does not contain. Better prompting does not remove it; supplying the
missing text as explicit context does.

### Tier 3 — the instrument, not the control

The tier-3 task as written is satisfied by a **search**, which returns matching lines without reading a
file: it emitted **0 `SOURCE_READ` events in both arms**. So the observed −1 turn delta is noise, and this
tier does not measure egress friction at all.

The coverage claim in section 2 for `.json` and `.cjs` comes from evaluating `declarationPathFor`
directly, **not** from this task's windows. The distinction is recorded because attributing it to the run
would be citing a measurement that was never made.

---

## 4. Host configuration finding: `--patch` overlays replace, they do not merge

Discovered while looking for a way to take one ungated baseline without editing the live profile.

A `--patch` overlay's `config` object **replaces** the profile's config for the targeted plugin id rather
than deep-merging into it. A one-key overlay supplying only `sourceReadEgress` was composed by
`--dump-config` as:

```
- id: local-router
    config:
      sourceReadEgress: source
```

and nothing else — `guardAskPaths`, `dlpAction`, `leadTier`, `coherenceVerification` and both `llm-*`
provider entries were gone.

**So a "minimal" overlay is not a smaller version of your harness. It is a different harness**, with no
guard configuration and no provider routing. An overlay used to flip one setting must restate the full
config tree. Retained as [`note-patch-overlay-replaces-config.yml`](note-patch-overlay-replaces-config.yml).

---

## 5. What this establishes, and what it does not

**Established, by measurement:**

- The declarations control works end to end, live and in isolation (section 1).
- Coverage is exactly four file extensions; everything else is served raw (section 2).
- Signature-level work carries no penalty; message-editing work loses the bytes it needs (section 3).
- `--patch` overlays are replacement, not merge (section 4).

**Not established:**

- **Turn counts are n = 1.** The table is a single run per task per arm, self-flagged in `PROTOCOL.md` as
  unconfirmed by the pre-registered in-window criterion. Treat the direction as suggestive.
- **Reads refused is `NOT MEASURED` in both arms.** A refused read emits no `SOURCE_READ`, so refused
  reads are structurally invisible to this instrument and must not be derived by subtraction. The tier-2
  cost is visible in turns and wall clock; the *count* of refusals is not known.
- **Nothing here measures a human working under the restriction**, only agent sessions.

---

## 6. Conclusion

**For source privacy.** The control withholds **implementation bodies and string literals** from reads of
TypeScript/JavaScript sources. It is not an ambient boundary: repository configs, scripts, fixtures and
documentation are served raw. Describing it as a general egress control overstates what it does; describing
it as type-skeleton redirection for compiler-targeted sources is accurate.

**For publishing.** The durable value of `dsh-plugin-coding-delegate` is its **enforced execution
boundaries** — the architect is denied write and shell by policy, worker output is confined to a declared
root, and every delegation leaves a hashable verdict — together with its **432-case oracle suite** and two
published adversarial reviews that list their own open findings. The egress control is one mechanism among
those, with the specific and bounded scope documented above. It is not the headline, and this benchmark is
the evidence for saying so.
