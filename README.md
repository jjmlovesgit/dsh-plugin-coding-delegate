# DSH Local Router

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that routes each request to the
cheapest place it can safely run: a local GPU for what it can handle, and a cloud architect for
what it cannot — with an enforced gate in front of anything that would leave the machine.

> **Status: 0.1.0, a personal project.** It works and is tested, but the API is not frozen and
> the honest limits are documented rather than glossed. See
> [What this does not claim](#what-this-does-not-claim).

## What it does

Four things, in the order they act:

1. **In-process routing.** No sidecar, no daemon, no extra port. Classification and routing happen
   inside the plugin, so there is nothing extra to run or supervise.
2. **A DLP gate on every outbound request.** Prompts are scanned for credentials and
   high-entropy tokens before the cloud sees them. A hit is refused or rerouted to the local
   worker, never transmitted. The gate accumulates the user messages it has seen, so a credential
   from an earlier turn keeps it closed instead of scrolling out of view.
3. **A code-write guard.** Cloud-authored writes to source files are denied or sent for approval,
   so the model that plans is not the model that edits. Shell writes *and deletions* are covered,
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
# then add "dsh-plugin-local-router" to dsh.profile.bundles in
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
- Local routing saves cost and keeps data on-machine; it does not make a local model as capable as
  a cloud one.
- Provider transport, tool-schema enforcement and session storage live in DSH, not here.

## License

MIT — see [`plugin/LICENSE`](plugin/LICENSE).
