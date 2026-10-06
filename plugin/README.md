# dsh-plugin-local-router

A DeepSeek Harness (Cordis) plugin for **local-first LLM routing**. It classifies every
request in-process and routes it to either a local OpenAI-compatible worker (LM Studio is
the default assumption) or a cloud provider — keeping private material on the machine by
default.

Routing is **fully in-process**: there is no separate decision daemon, no HTTP hop, and
no timeout on the routing path. (Earlier versions called an external Python "Laya" scoring
service; that dependency has been removed. The classifier is now TypeScript inside this
package.)

> **This plugin does not modify your provider configuration.**
>
> The `cordis.patch.yml` that DSH applies on install registers the plugin itself and nothing
> else — it adds no provider, no model and no API key. Provider setup is entirely yours.
> `cordis.patch.example.yml` ships as an **unapplied** starting point you can copy from.

## What it does

1. **Routes requests** between a local provider and a cloud provider based on a three-layer
   decision, cheapest check first.
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

## Install

```bash
npm install dsh-plugin-local-router
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

Then set `localModel` to that `id`. Nothing else changes: routing, the DLP gate and
`delegate_worker` work against whatever that endpoint serves. One caveat — if the endpoint is
remote, "local" now means "not the cloud architect" rather than "on this machine", and
`dlpAction: 'local'` would send a credential-bearing payload *to that endpoint*. Prefer
`'block'` unless you trust it as you would your own machine.

### Option 3 — cloud only, no local model

Point both sides at cloud providers and set `dlpAction: 'block'`:

```yaml
dsh-plugin-local-router:
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

`predictRoute` applies three layers, in order:

| Layer | Condition | Result |
| --- | --- | --- |
| 1. DLP firewall | The prompt matches a credential pattern | **local**, `Gate 1 (Local Classifier - DLP Firewall)` |
| 2. Token guard | Estimated tokens exceed `contextThreshold` | **cloud**, `Gate 0 (Guard - Token Threshold)` |
| 3. Local classifier | Otherwise | privacy > 0.80 → local; complexity ≥ 2 → cloud; else local |

The classifier scans the **entire prompt** for credentials, while complexity scoring is
applied to a bounded tail window (`windowChars`, default 2000). This asymmetry is
deliberate: a key near the top of a long file must still be caught, but complexity scoring
must stay cheap.

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

The entropy scan is applied to the **gate only**, not to `classifyLocally`, so the classifier
stays behaviour-compatible with its frozen reference corpus.

Decision output: `{ provider, model, route, gate, rationale, scores, latencyMs }`, where
`route` is `WORKER_LOCAL` or `ARCHITECT_CLOUD`.

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `localProvider` | `lm-studio` | Provider id used for local execution |
| `cloudProvider` | `deepseek-official` | Provider id used for escalated execution |
| `localModel` | `qwen/qwen3.8-27b` | Local model id |
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

## The `delegate_worker` tool

Dispatches a discrete implementation task to the local worker and returns a structured
receipt: `{ success, status, filesWritten, filesWrittenRelative, resolvedWorkspace,
workspaceSource, testResults, tokens, summary }`.

- **File emission** is driven by fenced code blocks whose header names the target, e.g.
  ```` ```ts file="src/thing.ts" ```` or a `// FILE: src/thing.ts` first line.
- **Safety**: output that does not look like source code is refused rather than written, and
  a rewrite more than 50% smaller than an existing file is rejected — both exist because an
  earlier version silently replaced a working module with a tool-call transcript.
- **`workspaceDir`** selects the destination explicitly. Pass it. Automatic resolution
  cannot see the DSH session workspace (the Cordis `Agent` exposes only an id, and the path
  lives in session metadata behind a store the plugin cannot reach), so omitting it resolves
  to the server's working directory and says so in `summary`.
- **Verification** runs `runVerification` with the resolved workspace as cwd, and the
  command's **exit code is authoritative** — unrecognised output can never be scored a pass,
  because `tsc`-style failures would otherwise report success.

### Failure reports are redacted

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

## Local-code guard

Once enabled, `write`/`edit`-style tool calls targeting source extensions are refused with a
message directing the work to `delegate_worker`.

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
- Shell writes are detected heuristically, and **script invocations are inspected**: the guard
  reads a script named on the command line, follows nested invocations up to depth 2 (with
  cycle protection), and gates it when the script contains *both* a write primitive and a
  source-extension reference. Because this is a text scan, a script that merely *mentions* a
  write is gated as well — over-asking is deliberate, since that is the safe direction.
- **Relative script paths can evade inspection.** A relative path is resolved against the
  server's working directory, not the session workspace, which the plugin cannot see (the
  Cordis `Agent` exposes only an id, and the path lives in session metadata behind a store the
  plugin cannot reach). Invoke scripts by **absolute path** — that is the form the guard can
  read, and the form its message steers you toward. Absolute invocations are inspected;
  relative ones may not be.
- Writes made *indirectly* are not detected: if a script delegates the work to a library, the
  write primitive never appears in the script itself.
- Config files (`.yaml`, `.json`, `.env`) are out of scope — only source extensions are gated.
- `delegate_worker` writes through `fs` and deliberately bypasses the guard.

Treat it as a strong deterrent at the tool layer, not an airtight boundary.

## State

All local state derives from one directory, never a hard-coded path:

1. `DSH_LOCAL_ROUTER_DATA_DIR` if set
2. otherwise `$DSH_HOME/local-router`
3. otherwise `~/.dsh/local-router`

It holds `router-debug.log` and `savings-ledger.json` (token/cost accounting).

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
- `delegate_worker` executes a caller-supplied verification command in the server process;
  treat that string as trusted input.
- Credential detection is pattern-based plus an entropy backstop. It cannot recognise
  confidential material that looks ordinary — proprietary code, customer data or PII are
  caught by neither layer.
