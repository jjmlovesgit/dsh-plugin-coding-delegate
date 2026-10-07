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

- **The window does not fit.** The lead's configured context was 32,768 tokens. `plugin/src/index.ts` is
  147 KB — roughly **40,900 tokens**. One file, larger than the whole window; `plugin/src` together is
  ~46,700. The plugin cannot be engineered by its own lead.
- **The reasoning budget is not ours to set.** LM Studio's per-model setting is authoritative. Four
  variants of one request — server default, `enable_thinking: false`, `true`, and `reasoning_effort: high`
  — returned byte-identical results: 64 completion tokens, the same 183-character reasoning field, the same
  answer. Nothing the plugin or DSH sends changes it. Reproduce with `scripts/probe-thinking.mjs`.
- **The saving was on the wrong side.** Offloading typing is worth ~159,000 tokens across this project's
  entire history. Reading one 41,000-token file once and carrying it for fifty turns costs ~2,046,000 input
  tokens. Adding a tier to avoid reading gives up the larger saving to capture the smaller.
- **Nothing was ever proven.** No lead-authored contract was dispatched and verified. The failure mode is
  an under-specified contract producing a confident wrong patch — worse than the frontier model writing the
  code itself.

## What would have to change

1. **A codebase that fits.** The tier is only viable if a unit's relevant code fits in roughly 20K tokens.
   That is a property of the repository, not the model: `index.ts` accumulated because the architect has
   been editing it directly. Split it and the arithmetic changes.
2. **A way to control reasoning** where the model is served, or a separate non-reasoning model for the
   worker so the two tiers do not contend for one server setting.
3. **Evidence that a local model writes a discriminating contract.** The shape is now known and written
   down; the question is whether a 27B can fill it well enough to be worth a tier.

## What outlived it

`leadTier` / `leadProviders`, `PROFILES.LEAD`, `delegateReadPolicy`, rule 8 and the durable registry are
all still built, tested and available. An operator may still run a local thinking agent alongside the
architect — the plugin will not repin it to the cloud, and will not tell it that it is the architect.
