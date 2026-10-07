# The lead tier: built, measured, retired

**Status: retired.** The preset directory that implemented it has been removed. This document is the
record — what was built, what the host actually provides, what the measurements said, and what would have
to change for the idea to come back.

It is kept because a good deal of it was learned by reading the installed DSH rather than its
documentation, and that knowledge is worth more than the code it produced.

## What the tier was for

The two-tier loop does not answer one question: **which files does a unit need, and do two units agree?**
The worker cannot answer it — it has no repository read. The architect could, but its window is the
resource the whole plugin exists to protect.

So a third role was proposed: a local thinking model with repository access that reads the code, works out
the contract for each unit, and hands it back. The architect stays out of the code; the lead sits between.

The roles were meant to mirror an engineering organisation — architecting, engineering, writing — with the
lead as the engineer who turns an architectural intent into a concrete code-level change. It never decides
*what should exist*; it decides *how that lands*.

## What the host provides (the useful part)

Learned from the installed packages, not from documentation:

- **Presets are directories** holding `preset.yml` (name, description, order) and `agent.cordis.yml`, an
  *agent-plane* composition. The composition decides the tool schemas and prompt sections an agent sees.
  DSH ships `minimal`, `standard`, `ptc` and `cordis` as working references.
- **Discovery** scans configured `roots`, each with a `path` and `trust`. `includeShippedRoot` prepends the
  bundled presets; `includeUserRoot` appends `<dshHome>/.agent-presets` as a `user` root. So installing one
  is a directory copy. The preset id is the directory name and must match `[a-z0-9][a-z0-9-]*`.
- **Discovery owns health.** A directory whose composition is missing or unloadable becomes a broken roster
  row *with a reason*, not a silent skip.
- **The model route is host-plane.** A preset does not choose a provider or model; the session's selection
  does. That is what made `leadTier`/`leadProviders` the load-bearing plugin setting.
- **`dsh-tool-subagent` instances can set child `persona`, `toolFilter`, `agentOptions` (provider, model,
  reasoningEffort, maxTokens) and `maxDepth`** — and the in-process spawn provider declares support for all
  of them: `capabilities = { agentOptions: true, toolFilter: true, persona: true }`. So an architect can
  spawn a child pinned to a local model, carrying a chosen persona, restricted to chosen tools, and
  forbidden from delegating further. That is the shape a lead tier *should* have been built as — a tool
  the architect holds, not a session the operator opens.

That last point is the correction worth remembering: the tier was first built as a **session preset the
user selects**, which is two configured agents. The host already had the primitive for one configured
agent that spawns the rest.

## Why it was retired

- **The window does not fit.** *Re-measured; this ground no longer holds for a single module.* At
  retirement the lead's configured context was 32,768 tokens and `plugin/src/index.ts` was 147 KB —
  roughly **40,900 tokens**: one file, larger than the whole window, with `plugin/src` together at
  ~46,700. The refactor in [`refactor.md`](refactor.md) has since split it. Measured now: `index.ts` is
  **~13,400 tokens**, the largest module (`delegation.ts`) is **~7,300**, and `plugin/src` together is
  **~45,700**. Any one module therefore fits the lead's window with room to spare, and only the whole of
  `src` does not. The objection as originally written — "the plugin cannot be engineered by its own
  lead" — is dead.
- **The reasoning budget is not ours to set.** *Unchanged.* LM Studio's per-model setting is
  authoritative. Four variants of one request — server default, `enable_thinking: false`, `true`, and
  `reasoning_effort: high` — returned byte-identical results: 64 completion tokens, the same 183-character
  reasoning field, the same answer. Nothing the plugin or DSH sends changes it. Reproduce with
  `scripts/probe-thinking.mjs`.
- **The saving was on the wrong side.** *Re-measured; weaker, still true.* Offloading typing is worth
  ~159,000 tokens across this project's entire history. At retirement the arithmetic was one 41,000-token
  file carried for fifty turns: ~2,046,000 input tokens. With the split, the largest module is ~7,300
  tokens, so the same fifty turns cost **~365,000** — an order of magnitude less, and still more than
  twice the entire typing history. Reading still dominates typing; the margin is simply smaller than
  recorded.
- **Nothing was ever proven.** *Unchanged.* No lead-authored contract was dispatched and verified. The
  failure mode is an under-specified contract producing a confident wrong patch — worse than the frontier
  model writing the code itself.

**The decision stands, and this is what it now rests on.** Grounds 2 and 4 are unchanged, and each is
sufficient on its own: the reasoning budget is not the plugin's to set, and nothing was ever proven.
Grounds 1 and 3 were re-measured after the refactor and both weakened — a module can now be read by a
lead, but the reading still costs more than the typing it saves.

## What would have to change

1. **A codebase that fits.** *Largely satisfied.* The tier is only viable if a unit's relevant code fits
   in roughly 20K tokens. That is a property of the repository, not the model: `index.ts` accumulated
   because the architect had been editing it directly. Split it and the arithmetic changes. It has now
   been split — every module is under ~13,400 tokens, and the largest is ~7,300 — so this is the one
   precondition that has been met since the retirement was recorded.
2. **A way to control reasoning** where the model is served, or a separate non-reasoning model for the
   worker so the two tiers do not contend for one server setting.
3. **Evidence that a local model writes a discriminating contract.** The shape is now known and written
   down; the question is whether a 27B can fill it well enough to be worth a tier.

## What outlived it

`leadTier` / `leadProviders`, `PROFILES.LEAD`, `delegateReadPolicy`, rule 8 and the durable registry are
all still built, tested and available. An operator may still run a local thinking agent alongside the
architect — the plugin will not repin it to the cloud, and will not tell it that it is the architect.
