# Running a lead alongside the architect

The two-tier loop closes on existing code, but it leaves one question unanswered: **which files does a
unit need, and do two units agree with each other?** Nothing in the loop decides that. The worker
cannot — it has no repository read. The architect cannot — it is forbidden to read source, because
reading it is what the plugin exists to prevent.

That question needs a third role: a thinking model that reads the repository, works out what a unit
touches, and authors the contract the worker is then held to.

## Why the lead is local

A cloud lead would mean source reaching the cloud, paid for with the metered allowance this plugin
exists to protect — the plugin's own rules say the architect may not read back what it delegated, and
source should not leave the machine. So the lead runs on the same local endpoint as the worker, with
thinking enabled. The GPU is already a fixed cost; the lead spends wall-clock and nothing else.

The lead is also deliberately **not** given `delegate_worker`. The lead authors contracts; the
architect dispatches them. A lead that could also dispatch would be the orchestrator, and the architect
would have nothing to do.

## What the plugin needs

One setting. Either the shortcut:

```yaml
- id: local-router
  config:
    leadTier: true
```

or the explicit form, if your lead provider is not the one in the `LEAD` profile:

```yaml
- id: local-router
  config:
    leadProviders: ['lm-studio']
```

With this set, a request the host has already resolved to that provider is passed through **untouched**
— same provider, model, context window and instruction, and no `delegate_worker`. Before this, the
`agent/request` hook repinned every agent to the cloud and appended "You are the Lead Architect…", so a
lead would have been redirected to the cloud and told it was the architect.

The DLP firewall still runs on a lead request. Opting a provider out of the architect role does not opt
it out of the credential gate.

> **Do not** name the provider your architect session uses. The hook would stop pinning it, which is the
> one failure direction that ends with source leaving the machine. `leadProviders` is an allowlist
> rather than an inference precisely so this cannot happen by accident.

## What the host needs

DSH composes agents from **presets**: a directory holding `preset.yml` and `agent.cordis.yml`. The
composition decides the tool schemas and prompt sections the agent sees. Two presets ship with DSH as
working references — `minimal` (persona plus a persistent shell) and `standard` — and the fastest route
is to copy one and adapt it:

```
presets/lead/
  preset.yml          # name, description, order
  agent.cordis.yml    # the composition: persona + repository-read tools
```

For the lead, the composition should give it:

- a `@deepseek-ai/dsh-persona` entry whose `prefix` is the lead's instruction. The text below mirrors
  `PROFILES.LEAD.systemInstruction` in the plugin, so the two agree on what the lead is for.
- **read-only repository tools** — searching and reading files. Not write tools: the lead produces a
  contract, not an implementation, and it should not be editing the tree it is surveying.
- no `delegate_worker`.

Then select the **local** provider and model for that session. That selection is what the plugin keys
on, so if it points at the cloud the lead is a cloud lead regardless of what the preset says.

The lead's instruction, for reference:

> You are the Lead. You read the repository and author the contract for each unit of work: what must be
> built, the interfaces and behaviour it needs, the files involved, and the tests that decide whether
> the unit passed. You do not write implementation code, and you do not dispatch the worker — the
> architect does that with your contract. Quote any code you are changing exactly as it appears,
> because a patch that does not match byte-for-byte is refused rather than approximated.

## What is verified, and what is not

Honest status, because the two halves have very different evidence behind them.

**The plugin half is built and tested.** `leadTier` / `leadProviders`, the role decision, and the
pass-through are covered by `plugin/tests/oracles/agent-role.test.cjs` and
`plugin/tests/oracles/lead-tier.test.cjs`, and both were written to fail before the implementation
existed.

**The host half is documented, not verified.** The preset directory shape, the two file names and the
`agentPresets` service are read from the DSH installed here — but I have not created a lead preset and
run it. Take the tool package ids from a working preset such as `standard` rather than from this
document; the ids here would be guesses.

**The read guard will over-ask.** Until the host exposes which agent is which, the guard cannot tell the
lead from the architect, so the lead is prompted when it reads a file a worker wrote. That is item 1 on
the roadmap and it is blocked on agent lineage. `delegateReadPolicy` is the interim escape hatch, and it
trades away part of rule 3 — see the plugin README.

Until the host half is wired, the lead tier is usable **manually**: run a second session against the
local provider, with the instruction above, and paste its contract into the architect's conversation as
a unit instruction. That is not automated, but it is the whole loop with a human in the middle of it.
