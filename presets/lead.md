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

DSH composes agents from **presets**: a directory holding `preset.yml` and `agent.cordis.yml`, whose
composition decides the tool schemas and prompt sections the agent sees. DSH scans configured `roots`
for them and appends `<dshHome>/.agent-presets` as a user root by default, so installing one is a
directory copy:

```
copy  presets/lead   →   <dshHome>/.agent-presets/lead
```

That is `C:\Users\<you>\.dsh\.agent-presets\lead\` on Windows. The preset id is the directory name and
must match `[a-z0-9][a-z0-9-]*`. Discovery is health-checked rather than forgiving: a directory whose
composition is missing or unloadable appears as a broken roster row with a reason, not as a silent skip,
so a mistake is visible rather than mysterious.

Then select the **local** provider and model for that session. The preset deliberately does not choose a
model route — that stays on the host plane — so the session's selection is what the plugin keys on.
Point it at the cloud and the lead is a cloud lead, whatever the composition says.

### What the preset provides

`presets/lead/agent.cordis.yml` is a real composition — real package ids, taken from the shipped
`standard` preset rather than guessed. It has **not been run**. It mounts:

- `@deepseek-ai/dsh-persona` with the lead's instruction. `prefix`/`suffix` rather than `complete: true`,
  so tool guidance and runtime context still reach the model; a lead that cannot see its working
  directory cannot read a repository.
- `@deepseek-ai/dsh-agent-instructions`, for repositories that document their own conventions.
- `@deepseek-ai/dsh-tool-fs` and `@deepseek-ai/dsh-tool-fs-search`, for reading and searching.
- the platform's shell tool, because history, listings and running a test are what repository reading
  actually consists of.
- compaction, because surveying a repository fills a window faster than anything else an agent does.

Two properties are worth knowing rather than discovering.

**The read tools cannot be mounted without the write tools.** `dsh-tool-fs` registers read, read_image,
write and edit together; there is no read-only split. That is tolerable because the separation does not
rest on this preset being well behaved: the plugin's code guard refuses source writes from *any* agent,
so a lead that tries to author implementation is stopped by the same rule that stops the architect.

**A shell makes this preset only as safe as its model route.** Running locally, the output stays on the
machine. A cloud lead with a shell is a different proposition, which is why the provider selection above
is the load-bearing part of the arrangement.

Deliberately absent: subagents, workflows, plan mode, skills, todos and goals. The lead authors
contracts; the architect dispatches them and holds state across units. An agent with both is the
orchestrator, and the architect would have nothing left to do.

The lead's instruction, for reference:

> You are the Lead. You read the repository and author the contract for each unit of work. You do not
> write implementation code, and you do not dispatch the worker — the architect does that with your
> contract. For each unit, state: the files it touches, the exact change expected, the code the worker
> must see, and the command that decides whether the unit passed. Quote any code you are changing
> exactly as it appears, because a patch that does not match byte-for-byte is refused rather than
> approximated.

## What is verified, and what is not

Honest status, because the two halves have very different evidence behind them.

**The plugin half is built and tested.** `leadTier` / `leadProviders`, the role decision, and the
pass-through are covered by `plugin/tests/oracles/agent-role.test.cjs` and
`plugin/tests/oracles/lead-tier.test.cjs`, and both were written to fail before the implementation
existed.

**The host half is written, and still not verified.** The composition now exists, with package ids read
from the shipped `standard` preset rather than guessed. What has not happened is a mount: nobody has
copied it into a preset root, selected it, and watched it come up. Discovery is health-checked, so a
mistake should surface as a broken roster row with a reason rather than as silence — but "should" is
carrying real weight in that sentence, and testing it is the next step.

**The read guard will over-ask.** Until the host exposes which agent is which, the guard cannot tell the
lead from the architect, so the lead is prompted when it reads a file a worker wrote. That is item 1 on
the roadmap and it is blocked on agent lineage. `delegateReadPolicy` is the interim escape hatch, and it
trades away part of rule 3 — see the plugin README.

Two ways to try it. **Install the preset** — copy the directory into a preset root, open a session with
it, and select the local provider — which is the real thing and is what the next test should cover. Or,
with no setup at all, run a second session against the local provider with the instruction above and
paste its contract into the architect's conversation as a unit instruction. The second is the whole loop
with a human carrying the contract across, and it asks nothing of anyone.
