# DSH Local Router

> **Your plan is for thinking. Your GPU does the typing.**

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that decides where a request may
go by **permission rather than preference**: a credential is not permitted to reach the cloud, the
cloud model is not permitted to author source code, and everything beyond those rules is the
architect's explicit choice to delegate or not.

Why it matters: on a metered plan the scarce resource is frontier tokens, and reading code is what
spends them. Routing code work to a local model keeps that allowance for the work only a frontier
model can do, so the plan lasts instead of timing out. That is a **capacity** claim, not a cost one —
see [What this does not claim](#what-this-does-not-claim).

> **Status: 0.1.0, a personal project.** It works and is tested, but the API is not frozen and
> the honest limits are documented rather than glossed. See
> [What this does not claim](#what-this-does-not-claim).

## The policy

**The architect may reason but not author. The worker may author but not stray. Neither may execute
without consent.**

Every rule here is an instance of that sentence, and every one fails closed — if a rule cannot be
evaluated, or the approval service cannot be reached, the answer is no.

| # | Rule | Enforced by |
| --- | --- | --- |
| 1 | A credential may not reach the cloud | DLP gate: refused, or pinned local |
| 2 | The architect may not author or delete source | code guard: denied, or approval-gated |
| 3 | The architect may not read back what it delegated | reads of worker-written files need approval |
| 4 | The worker may not write outside the workspace | containment on every emitted path |
| 5 | The worker's code may not run inside the server | subprocess only; in-process fallback off |
| 6 | A command the architect proposes may not run unchecked | approval seam |
| 7 | A delegated result is a verdict, not a claim | files written without verification report `UNVERIFIED` |

## What it does

Four things, in the order they act:

1. **In-process, no sidecar.** No daemon, no extra port, nothing to supervise. The gate and the
   authorship guard run inside the plugin.
2. **A DLP gate on every outbound request.** Prompts are scanned for credentials and
   high-entropy tokens before the cloud sees them. A hit is refused or rerouted to the local
   worker, never transmitted. The gate accumulates the user messages it has seen, so a credential
   from an earlier turn keeps it closed instead of scrolling out of view.
3. **A code guard, in both directions.** Cloud-authored writes *and deletions* of source are denied
   or sent for approval — and so is reading back a file the worker wrote, since that pulls the
   delegated code into the very context the delegation kept it out of. Shell forms are covered,
   including inline program text (`python -c`, `node -e`).
4. **`delegate_worker`.** A tool the architect calls to hand implementation to a local
   OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp, a remote gateway). File writes
   are contained to the workspace, verification output is redacted to structure before it travels,
   and the verification command itself requires approval.

## Requirements

- **Node.js 22+**
- **A local OpenAI-compatible server** if you want local routing or `delegate_worker`
  (LM Studio on `127.0.0.1:1234` by default; anything else via `localEndpoint`)
- **A cloud provider** for the architect role (DeepSeek by default)

**No container runtime is required.** Verification runs as an ordinary child process. A container
is optional hardening — see [Verification](plugin/README.md#verification-runs-as-a-subprocess--a-container-is-optional-hardening).

## Install

The plugin lives in `plugin/`. DSH loads a profile bundle, so register it into the profile you use:

```powershell
# The CLI profile is `web`; the desktop app boots `tauri`.
.\scripts\register-plugin.ps1 -Profile web
```

Or by hand, which is all the script does:

```bash
dsh plugin --profile <name> add ./plugin
# then add "dsh-plugin-codeoffload" to dsh.profile.bundles in
# ~/.dsh/profiles/<name>/package.json
```

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

**Full configuration reference, provider setups and every security key: [`plugin/README.md`](plugin/README.md).**
It is the real documentation; this file is the summary.

## Security

The plugin was reviewed externally, and the response to that review — including the defects found
afterwards, the live verification run, and what remains out of scope — is in
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md).

Two properties worth stating plainly:

- **Approvals are real.** A gate that auto-admits is decoration. The approval seam was verified to
  prompt for a human decision, with 1.9–3.1 s decision latencies in the session audit and no
  `auto` preset active.
- **The guard is a deterrent, not a boundary.** It mediates tool calls and shell text. A path
  computed at runtime, a mutation inside a library, and code written into prose are all outside it.

## Repository layout

```
plugin/                     the publishable package (src, dist, tests, README, LICENSE)
plugin/tests/oracles/       regression oracles: guard, DLP, redaction, containment, verification
plugin/cordis.patch.yml     registers the plugin; ships no provider or model config
plugin/cordis.patch.example.yml  a complete configuration example, NOT applied automatically
scripts/register-plugin.ps1 registers the plugin into a DSH profile
SECURITY-REVIEW.md          review findings, remediation, and limits
```

## Development

```bash
cd plugin
npm ci
npm run build          # tsc -> dist
npm test               # unit tests (vitest)
npm run test:oracles   # regression oracles (node:test)
npm run test:all       # both
```

`dist/` is committed because DSH loads `dist/index.js`. CI rebuilds and fails if the committed
`dist` has drifted from `src`.

## What this does not claim

- The guard sees tool calls and shell text, not intent. Runtime-computed paths and library-mediated
  writes are invisible to it; configuration files are out of scope.
- The DLP gate scans the user messages the plugin has seen — not assistant output or tool results —
  and pattern-plus-entropy matching cannot recognise confidential material that looks ordinary.
- Local routing does **not** save money. The GPU is a fixed cost this plugin neither pays for nor
  reduces, and a local card will not pay for itself against a metered plan. What is preserved is the
  plan's allowance: metered tokens stay for the work only a frontier model can do, instead of being
  spent reading code.
- It does not make a local model as capable as a cloud one.
- Provider transport, tool-schema enforcement and session storage live in DSH, not here.

## License

MIT — see [`plugin/LICENSE`](plugin/LICENSE).
