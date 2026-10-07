# dsh-plugin-coding-delegate

> **Your plan is for thinking. Your GPU does the typing.**

A DeepSeek Harness (Cordis) plugin that decides where a request may go, and decides by
**permission rather than preference**. A credential is not permitted to reach the cloud. The
cloud model is not permitted to author source code. Beyond those two rules the destination is
the cloud, and moving work off it is the architect's explicit choice — not a heuristic's guess.

Everything runs **in-process**: there is no separate decision daemon, no HTTP hop, and no
timeout on the routing path. (Earlier versions called an external Python "Laya" scoring service;
that dependency was removed, and the credential rules are now TypeScript in this package.)

> **This plugin does not modify your provider configuration.**
>
> The `cordis.patch.yml` that DSH applies on install registers the plugin itself and nothing
> else — it adds no provider, no model and no API key. Provider setup is entirely yours.
> `cordis.patch.example.yml` ships as an **unapplied** starting point you can copy from.

## The policy

**The architect may reason but not author. The worker may author but not stray. Neither may execute
without consent.**

Every rule in this plugin is an instance of that sentence, and every one fails closed — if a rule
cannot be evaluated, or the approval service cannot be reached, the answer is no.

| # | Rule | Enforced by |
| --- | --- | --- |
| 1 | A credential may not reach the cloud | DLP gate on every outbound request; refused, or pinned local |
| 2 | The architect may not author or delete source | code guard on `tools/pre-execute`; denied, or approval-gated |
| 3 | The architect may not read back what it delegated | reads of worker-written files require approval |
| 4 | The worker may not write outside the workspace | containment on every emitted path, symlinks included |
| 5 | The worker's code may not run inside the server | subprocess only; the in-process fallback is off |
| 6 | A command the architect proposes may not run unchecked | approval seam via `verificationApproval` |
| 7 | A delegated result is a verdict, not a claim | files written without verification report `UNVERIFIED`, never `SUCCESS` |

The division is meant to be mutual and is enforced in both directions: rule 2 stops the architect
typing code into your repository, rules 3–5 stop the worker reaching outside the work it was given,
and rule 7 stops an unchecked result being reported as a pass.

What the policy does **not** cover is listed under [Limitations](#limitations) rather than left
implied: code in prose is not mediated, files this plugin did not write remain freely readable, and
the guard is a deterrent at the tool layer, not an airtight boundary.

## What it does

1. **Gates what may leave the machine.** Every outbound request is scanned for credentials. A hit
   is refused or pinned to the local provider; absent a hit, the request goes to the cloud
   provider. This is the only rule that changes the destination.
2. **Provides a `delegate_worker` tool** that dispatches code-generation subtasks to the
   local model, writes the emitted files, and optionally runs a verification command.
3. **Guards code authorship** with a `tools/pre-execute` hook that refuses cloud-authored
   writes to source files.

## Requirements

- Node.js 22+
- **At least one configured LLM provider** — local, cloud, or both (see
  [Configuring providers](#configuring-providers))
- A local OpenAI-compatible server if you want local routing or `delegate_worker`
- A cloud API key (e.g. `DEEPSEEK_API_KEY`) if you route to a cloud provider

No container runtime is required. Verification runs as an ordinary child process, and the
in-process fallback is off by default; a container is optional hardening, not a prerequisite.

## Install

```bash
npm install dsh-plugin-coding-delegate
```

The package has **no runtime dependencies**: routing, credential detection, the code guard
and `delegate_worker` all run in-process against the host's `ctx`.

## Configuring providers

This plugin is a **router**: it decides *where* a request should go, but it does not create
providers. It selects between providers by **id**, so whatever you configure must be
reachable under the ids you set in `localProvider` / `cloudProvider` (and the matching
`localModel` / `cloudModel`).

### Option 1 — local worker plus cloud (the default)

A local LM Studio server plus DeepSeek Cloud. Copy `cordis.patch.example.yml` into your
profile, or add the equivalent to `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    lm-studio:
      api: openai-completions
      baseURL: http://127.0.0.1:1234/v1
      apiKeyEnv: LM_STUDIO_API_KEY
      models:
        - id: qwen/qwen3.8-27b
          maxTokens: 16384

llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
```

### Option 2 — any other OpenAI-compatible endpoint

`lm-studio` is only a provider *id*; the transport is generic OpenAI-completions. Point it at
vLLM, Ollama, llama.cpp, OpenRouter, a hosted gateway, or a different LM Studio model — local
or on another machine:

```yaml
llm-pi-ai:
  providers:
    lm-studio:
      api: openai-completions
      baseURL: http://192.168.1.50:8000/v1   # vLLM on another box
      apiKeyEnv: LOCAL_ENDPOINT_API_KEY
      models:
        - id: Qwen/Qwen3-Coder-30B-A3B-Instruct
          maxTokens: 32768
```

Then set `localModel` to that `id`, and set `localEndpoint` to the same base URL:

```yaml
localModel: Qwen/Qwen3-Coder-30B-A3B-Instruct
localEndpoint: http://192.168.1.50:8000/v1
```

Both matter, for different paths. `localModel` covers the local *reroute*, which travels through
the host's provider registry. `delegate_worker` talks to the server directly rather than through
that registry, so it needs `localEndpoint` — without it, dispatch would still go to LM Studio's
default port no matter what `baseURL` said. With both set, routing, the DLP gate and
`delegate_worker` all work against whatever the endpoint serves.

One caveat — if the endpoint is remote, "local" now means "not the cloud architect" rather than
"on this machine", and `dlpAction: 'local'` would send a credential-bearing payload *to that
endpoint*. Prefer `'block'` unless you trust it as you would your own machine.

### Option 3 — cloud only, no local model

Point both sides at cloud providers and set `dlpAction: 'block'`:

```yaml
dsh-plugin-coding-delegate:
  localProvider: 'deepseek-official'
  cloudProvider: 'deepseek-official'
  localModel: 'deepseek-chat'
  cloudModel: 'deepseek-chat'
  dlpAction: 'block'
```

Two things to know here:

- `dlpAction: 'local'` assumes a local worker to reroute to. With none configured, a
  credential-bearing request has nowhere safe to go — so use `'block'` instead.
- `delegate_worker` and the local-code guard both assume a local model. In a cloud-only setup
  `delegate_worker` has no worker to dispatch to, so set `localCodeGuard: false` if you do
  not want source writes refused.

## Routing

There is **one enforced rule**, and it is a permission rule rather than a cost or capability
heuristic:

| Condition | Result |
| --- | --- |
| The outbound payload matches a credential rule | **refused** (`dlpAction: 'block'`) or **pinned to the local provider** (`'local'`) |
| High-entropy token, no keyword and no vendor prefix | **always pinned local**, never refused — a digest or a base64 payload looks identical |
| Otherwise | **the cloud provider** |

So the plugin does not pick a model because one is cheaper or faster. It decides what is
*allowed*: a credential has no cloud clearance, and absent that, the destination is the cloud.
Moving work off the cloud beyond this is the architect's own decision — it calls
`delegate_worker`, or it does not.

The scan covers the whole conversation rather than only the newest message: user text is
accumulated per session and re-scanned, so a credential from an earlier turn keeps the gate
closed instead of scrolling out of view.

### The classifier is available but not wired in

`LocalRouter.predictRoute` implements a three-layer heuristic — `scanDLP`, a token-count
threshold, then `classifyLocally` (a privacy score and a complexity score over a bounded window).
It is exported, unit-tested, and has golden fixtures in `tests/fixtures/classifier-goldens.json`.

**The plugin's hooks never call it, so it does not affect where requests go.** An earlier version
of this README presented it as the routing path; that was wrong, and it is corrected here. It is
kept because it is useful on its own and the fixtures document behaviour worth preserving. If you
want complexity-based escalation, call it yourself — but note that making it the routing rule
would turn this into a cost/latency router with a permission gate attached, which is not the
premise this plugin is built on.

### The DLP firewall is enforced on every outbound request

Before a request is dispatched, `scanDLP` inspects the payload. If credentials are found,
`dlpAction` decides what happens:

| `dlpAction` | Behaviour |
| --- | --- |
| `'block'` (default) | The request is **refused**. Nothing is transmitted; the caller receives an error naming the offending pattern. |
| `'local'` | The request is **pinned to the local worker** for that call, so it never reaches the WAN. |

Caveat worth knowing before choosing `'block'`: the scan covers the conversation, so once a
credential is in the session history, every subsequent request keeps failing until it is
removed. Use `'local'` if you would rather the session continue on the local model.

#### Detection is tiered by confidence

| Detector | Confidence | Behaviour |
| --- | --- | --- |
| Vendor shape or keyword-assigned value (`sk-`, `AKIA`, `ghp_`, PEM, `api_key: …`) | high | follows `dlpAction` — **block** by default |
| **High-entropy string** (Shannon entropy, no keyword, no prefix) | medium | **always rerouted local**, never hard-blocked |
| Allowlisted / below threshold | — | passes through |

The entropy backstop exists because pattern matching can only catch shapes it already knows:
`export TOKEN=Zk8Qm3Xr7Tp2Wv9Bn4Ld6Hs1Jy5Gc0Fa` carries no keyword and no vendor prefix, so no
rule would see it.

It is deliberately medium confidence, because a high-entropy token may equally be a digest or
a base64 payload — legitimate content that merely looks random. That is why such hits are
pinned to the local worker rather than failing the request.

Defaults: `entropyCheck: true`, `entropyMinBitsPerChar: 4.5`, `entropyMinLength: 20`. Those
thresholds are **measured, not guessed**: on a corpus containing sha256 digests, base64
payloads, UUIDs, git SHAs, long file paths, prose and minified CSS, 4.5 bits/char at length
>= 20 caught every sampled secret with zero false positives (random keys scored ~5.2, the
noise ~4.2-4.4). Tune against your own code before trusting that boundary — the constants live
in `src/local-classifier.ts`.

The entropy scan is applied to the **gate only**, not to `classifyLocally`, so the unwired
classifier stays behaviour-compatible with its frozen reference corpus.

When you call `predictRoute` directly, its decision output is
`{ provider, model, route, gate, rationale, scores, latencyMs }`, where `route` is
`WORKER_LOCAL` or `ARCHITECT_CLOUD`. Nothing in the plugin acts on it.

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `localProvider` | `lm-studio` | Provider id used for local execution |
| `cloudProvider` | `deepseek-official` | Provider id used for escalated execution |
| `localModel` | `qwen/qwen3.8-27b` | Local model id, used for the local reroute *and* for `delegate_worker` |
| `localEndpoint` | `http://127.0.0.1:1234/v1` | Base URL `delegate_worker` posts to (a full `/chat/completions` URL is also accepted). Operator configuration — a caller-supplied `endpoint` argument is ignored, so a model cannot redirect the task |
| `cloudModel` | `deepseek-chat` | Cloud model id |
| `contextThreshold` / `contextTokenThreshold` | `30000` | Tokens above which requests go straight to cloud |
| `timeoutMs` | `2000` | Timeout for the worker HTTP call |
| `enforceDLP` | `true` | Enable the credential firewall |
| `dlpAction` | `'block'` | `block` refuses a credential-bearing request; `local` pins it to the local worker |
| `entropyCheck` | `true` | Enable the high-entropy backstop |
| `entropyMinBitsPerChar` | `4.5` | Entropy threshold, in bits per character |
| `entropyMinLength` | `20` | Minimum token length before entropy is scored |
| `localCodeGuard` | `true` | Refuse cloud-authored source writes |
| `guardMode` | `deny` | `deny` or `ask` for guard hits |
| `guardAskPaths` | `["tests/", "tools/"]` | Paths downgraded from deny to an approval prompt |
| `verificationApproval` | `'ask'` | `ask`, `allow` or `deny` for a delegated `runVerification` command |
| `verificationAllowlist` | `[]` | Programs whose verification commands skip the prompt (matches the program, not its arguments) |
| `emitAllowlist` | `[]` | Extra directories a delegated worker may write into besides the workspace |
| `allowInProcessFallback` | `false` | Run a denied spawn's verification module inside the server process |

`guardAskPaths` **replaces** the built-in default rather than adding to it. Setting it to
`["plugin/src/"]` therefore makes `tests/` and `tools/` hard denies: list every path you want to
stay approval-eligible, e.g. `["plugin/src/", "tests/", "tools/"]`.

## The `delegate_worker` tool

Dispatches a discrete implementation task to the local worker and returns a structured
receipt: `{ success, status, filesWritten, filesWrittenRelative, resolvedWorkspace,
workspaceSource, testResults, tokens, summary }`, plus `contractFiles` and `contractViolations`
when the unit declared a contract.

The worker receives the `instruction`, the `targetFiles` **paths**, and the verification command —
and nothing else. It has no repository read and is never handed file contents, so it cannot modify
code it has not been shown: a delegated unit has to be self-contained. That is what makes creating new
files the case this closes cleanly today, and editing an existing file a problem it does not solve.

- **File emission** is driven by fenced code blocks whose header names the target, e.g.
  ```` ```ts file="src/thing.ts" ```` or a `// FILE: src/thing.ts` first line.
- **Safety**: output that does not look like source code is refused rather than written, and
  a rewrite more than 50% smaller than an existing file is rejected — both exist because an
  earlier version silently replaced a working module with a tool-call transcript.
- **`workspaceDir`** selects the destination explicitly. Pass it. Automatic resolution
  cannot see the DSH session workspace (the Cordis `Agent` exposes only an id, and the path
  lives in session metadata behind a store the plugin cannot reach), so omitting it resolves
  to the server's working directory and says so in `summary`.
- **`contractFiles` declares the contract's tests, and the architect owns them.** Each is hashed
  before the worker runs, refused as a worker emission target, and re-hashed afterwards. Any change
  voids the verdict and reports `status: 'CONTRACT_MODIFIED'`, which outranks even a passing
  verification — because what passed was no longer the contract. A declared file that does not exist
  is a violation too, so a typo fails closed rather than passing quietly. The receipt carries paths,
  hashes and an `unchanged` flag, never contents.

  Enforcement is **opt-in**, and that is a real limit. A unit that declares no `contractFiles` gets no
  protection, and nothing detects that the architect should have declared one. The mechanism makes a
  declared contract unrewritable; it cannot make declaring one mandatory.
- **Verification** runs `runVerification` with the resolved workspace as cwd, and the
  command's **exit code is authoritative** — unrecognised output can never be scored a pass,
  because `tsc`-style failures would otherwise report success.

### Failure reports are redacted

Every retained field — subtest name, location, code and prose message — is secret-scanned with
the same rules the DLP gate uses and length-bounded before it can travel, because a TAP label
can carry a credential as easily as a diff can. An offending value is replaced by
`[redacted: …]`; counts and structure still travel.

Raw verification output is a **source-egress channel**: compiler errors quote the offending
line, assertion blocks carry `expected`/`actual` values, and stack frames name code. Routed to
a cloud architect, that leaks source incrementally — and persistently, since a conversation's
whole history is re-sent on every request.

So what travels back is **structure, not source**:

| Kept | Dropped |
| --- | --- |
| pass/fail counts, exit code | assertion diffs (`expected`/`actual`) |
| subtest names | stack frames and code excerpts |
| `file:line:col` | diff markers (`+`/`-` blocks) |
| error kind and code (`TS1434`, `ERR_ASSERTION`) | any assertion message that reads as code |

The **full raw text stays local**, written to
`$DSH_HOME/local-router/last-verification.log` (path returned as `rawOutputPath`), because the
delegated worker needs complete detail to fix mechanical failures. The redaction happens on
the way out, not on the way in.

Set `DSH_LOCAL_ROUTER_RAW_VERIFICATION=1` (or `redactVerification: false`) to return raw output
— useful locally, but it puts source back into whatever context reads the receipt.

Note this is a *mitigation*, not immunity: an assertion message written in prose can still
describe intent, and `file:line` still reveals structure. It removes the bulk carrier, not
every signal.

### Verification runs as a subprocess — a container is optional hardening

`runVerification` is executed as a command string with the authority of the DSH process, and the
code under test is written by the local model.

**By default it runs as an ordinary child process, and no container is required.** Output is
captured through file descriptors rather than pipes, because DSH's confined sandbox modes refuse
a piped spawn outright (`spawn EPERM`). That refusal used to make the subprocess path unusable in
the default configuration, leaving the in-process fallback as the only one that worked — the
wrong trade in every direction, since that fallback runs model-written code inside the server.
Descriptor capture means verification needs no opt-in and no runtime.

`allowInProcessFallback` stays `false`, and enabling it is worse, not better: the failures seen in
practice were ordinary, not crafted — a fixture calling `process.exit()` terminated the host
running the tests, and `process.exitCode` corrupted the server's own exit code, so ten tests
passed while the runner exited 1. Both are now isolated, but an infinite loop still hangs the
server and in-process code can still mutate globals. **In-process execution cannot be made safe;
it can only be made less bad.**

A child process is bounded by your user account rather than by the plugin — the files it can
write, the network it can reach. The approval prompt is the practical control. To bound it more
tightly, run the verification inside a **container**: optional hardening for those who have a
runtime, not a prerequisite. Pass the container command as `runVerification` (it is a
`delegate_worker` argument, not a plugin config key, so the caller supplies it per delegation):

```js
delegate_worker({
  instruction: '...',
  targetFiles: ['src/thing.ts'],
  workspaceDir: '/path/to/workspace',
  runVerification:
    'docker run --rm --network none --read-only --tmpfs /tmp ' +
    '--cap-drop ALL --pids-limit 256 --memory 1g ' +
    '-v /path/to/workspace:/w -w /w node:22-alpine node /w/tests/thing.test.cjs',
})
```

What each flag buys: `--network none` stops executed code from exfiltrating; `--read-only`,
`--tmpfs /tmp` and `--cap-drop ALL` bound what it can touch; `--pids-limit` and `--memory`
bound resource abuse; `--rm` makes every run ephemeral. Mount only the workspace — and note a
read-write mount still lets the worker write code there, because isolation bounds *execution*,
not authorship.

Stated plainly, so this is not over-read:

- Most operators have no container runtime, and that is fine: the default path is a plain child
  process and works without one. Containers are for bounding execution more tightly than your own
  account does. Check with `docker version` (or `podman info`) before relying on the example
  above.
- The plugin cannot conjure a boundary the host does not have. If even a descriptor spawn is
  refused, verification fails closed and reports a refusal rather than executing anything.
- Nothing forces the caller to use a container. The command is model-supplied, so the approval
  prompt is what catches a plain host command — read it before approving.
- Docker shares the host kernel. It is a strong boundary, not a guarantee — kernel escapes,
  `--privileged`, and careless mounts all defeat it. For code from genuinely untrusted
  sources, a VM or gVisor-class sandbox is stronger.
- It does **not** address egress. What the architect reads is a separate channel, handled by
  the redaction above.
- It does **not** change the guard's detection limits, nor stop code appearing in prose.

## Local-code guard

Once enabled, `write`/`edit`-style tool calls targeting source extensions are refused with a
message directing the work to `delegate_worker`.

### Reading back what was delegated

The guard runs in both directions. A `read`-style tool call — or a shell command that reads through
`Get-Content`, `cat`, `Select-String`, `grep` and the like — is **asked** when the target is a file
this plugin wrote on a delegation's behalf. The reason is the one the delegation exists for: pulling
that code back into the architect's context defeats the point of having delegated it. There is no
route that gets the file summarised back either, because the worker has no repository read and cannot
inspect a file it was not given. Either approve the read and accept the context cost, or re-plan the
unit so that it does not need the contents.

The registry is in-memory and process-scoped — it is a workflow guard, not durable state — and it is
bounded at 500 paths. Only files this plugin wrote are covered; everything else reads freely, and a
delegated path is only recognised in a shell command when the command names it in full.

Paths matching `guardAskPaths` (default `tests/`, `tools/`) are **asked** rather than refused:
the guard calls `ctx.approval.request(...)` on `@deepseek-ai/dsh-user-approval`, and only an
`allowed-once` outcome lets the write through. That seam fails closed — no approval service, no
agent, an idle conversation, or a throwing answerer all resolve to `unavailable`, which the guard
treats as a refusal. Set `guardMode: 'deny'` to skip asking on those paths entirely.

Note that a `tools/pre-execute` listener returning `{ kind: 'ask' }` does **not** prompt anyone;
the pipeline understands only `deny`, and every other kind is an allow. That is why the guard
reaches for the approval service explicitly instead of returning `ask`.

Known limits:

- The guard sees tool calls, not prose — it cannot stop code being typed into a reply.
- The read guard covers files **this plugin wrote**. Every other file is still freely readable, and a
  delegated file is recognised in a shell command only when the command names it in full — a path
  built at runtime, or a glob that happens to match one, is not detected.
- Shell writes **and deletions** are detected heuristically. Two scans run: a script named on
  the command line **for execution** is read and followed up to depth 2 (with cycle protection),
  and the **command line itself** is checked for a source-extension reference combined with a
  mutation signal — a write verb (`Set-Content`, `cp`, `mv`, `Move-Item`, `sed -i`,
  `git checkout`/`git apply`, …), a delete verb (`Remove-Item`, `rm`, `del`, `rmdir`, `git rm`,
  `os.remove`, …), a real redirection, or inline program text (`python -c`, `node -e`). A file
  named in order to be *read* is not treated as invoked, so inspecting a `.js` file with
  `Select-String`, `grep` or `Get-Content` does not ask. Destroying source is gated the same way
  as authoring it, and both verb lists are word-anchored — unanchored, `Move-Item` matches
  inside `Remove-Item` and a plain delete is misread as a write. Because this is a text scan, a
  command that merely *mentions* a mutation is gated as well — over-asking is deliberate, since
  that is the safe direction. Where several source paths appear, the longest is reported as the
  target, so extension-shaped prose cannot displace the real path.
- **Relative script paths can evade inspection.** A relative path is resolved against the
  server's working directory, not the session workspace, which the plugin cannot see (the
  Cordis `Agent` exposes only an id, and the path lives in session metadata behind a store the
  plugin cannot reach). Invoke scripts by **absolute path** — that is the form the guard can
  read, and the form its message steers you toward. Absolute invocations are inspected;
  relative ones may not be.
- Writes made *indirectly* are not detected: if a script or a command delegates the work to a
  library, the write primitive never appears in the inspected text.
- A write target computed at runtime (`f = 'src/' + name`) cannot be matched by a text scan.
- Config files (`.yaml`, `.json`, `.env`) are out of scope — only source extensions are gated.
- `delegate_worker` does not go through this guard, but it carries its own limits: a path that
  resolves outside its workspace is refused, and its model-supplied `runVerification` command
  is gated (see below).

Treat it as a strong deterrent at the tool layer, not an airtight boundary.

## Delegated verification and file writes

`delegate_worker` accepts `runVerification`, a shell command the **cloud model** chooses, and it
runs with the full authority of the DSH process. It is therefore gated:

| `verificationApproval` | Behaviour |
| --- | --- |
| `'ask'` (default) | The operator approves the exact command through the approval seam before anything runs. No reachable approval service means refusal. |
| `'allow'` | Runs unattended. Under `'ask'`, `verificationAllowlist` lets named programs skip the prompt; it matches the program only, so allowing `node` also allows `node -e "<anything>"`. |
| `'deny'` | Verification never runs. |

A command that does not run is reported as `status: 'VERIFICATION_NOT_APPROVED'` with a
`verificationSkipped` reason and `success: false`.

**A result is a verdict on a contract, and the verification command *is* the contract.** So a
delegation that wrote files without being given a command to check them reports
`status: 'UNVERIFIED'` and `success: false`, with the summary saying the contract was never checked.
It previously reported `SUCCESS`, which was the same false green as counting unrecognised test output
as a pass. A delegation that wrote no files — a question answered, say — has nothing to verify and
still reports `SUCCESS`. `runVerification` is not confined to the workspace, so read the approval prompt, and see
[verification runs as a subprocess](#verification-runs-as-a-subprocess--a-container-is-optional-hardening)
for the container option.

**File writes are contained.** A fenced path or `targetFiles` hint that resolves outside the
resolved workspace — an absolute path, a `..` segment, or a symlink pointing out of it — is
refused and reported in `errors` instead of being written. `emitAllowlist` extends the permitted
roots explicitly.

**`allowInProcessFallback`** (default `false`) decides what happens when the sandbox refuses a
piped spawn. Off, verification fails closed. On, the target module is `require`d inside the DSH
**server** process, running model-influenced code with full host authority — it can terminate
the server. Enable it only where the spawn restriction cannot be lifted, and prefer a container.

## State

All local state derives from one directory, never a hard-coded path:

1. `DSH_LOCAL_ROUTER_DATA_DIR` if set
2. otherwise `$DSH_HOME/local-router`
3. otherwise `~/.dsh/local-router`

It holds `router-debug.log` and `savings-ledger.json` — per-step and cumulative token accounting,
split local versus cloud, plus a cost column. The dollar figure is the **cloud-equivalent** of work
run locally: it measures the metered plan's exposure, and it is not money saved, because the GPU is a
fixed cost this plugin neither pays for nor reduces.

## Throughput reference

At startup the plugin logs a measured decode baseline, e.g.
`[WORKER_BENCH] qwen/qwen3.8-27b 130.6 tok/s`. Each `[LEDGER_AUDIT]` line then reports the
**actual** end-to-end rate for that call, plus the model name. Re-measure after changing
quantisation or presets, and update `WORKER_BENCHMARKS` in `src/profiles.ts`.

Note that the ledger's `Rate` is end-to-end and therefore includes prompt prefill: short
generations read far below the decode baseline (that is expected, not a regression).

## Development

```bash
npm run build     # tsc -> dist
npm test          # vitest
```

## Limitations

- Reading a file into the architect's context is also egress; local-first routing does not
  prevent a cloud model from *seeing* source it is asked to review.
- `delegate_worker` executes a caller-supplied verification command, by default as a child
  process with your account's authority. Treat that string as trusted input, and see
  "Verification runs as a subprocess" above for the container option.
- Credential detection is pattern-based plus an entropy backstop. It cannot recognise
  confidential material that looks ordinary — proprietary code, customer data or PII are
  caught by neither layer.
