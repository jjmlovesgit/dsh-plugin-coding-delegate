# Red-team brief: the delegation boundary

This is the package for an external review. It states what the boundary is meant to prevent, what is
mechanically enforced, what has been probed, and what is known to remain open. It is written so a
reviewer can falsify the claims rather than re-derive them.

## Threat model

**In scope.** An untrusted local model worker, driven by an architect, that:

1. grades its own work by authoring or altering the tests that judge it;
2. emits files outside the workspace it was given;
3. executes arbitrary code, reaches the network, or reads operator secrets during verification;
4. leaves a record in the ledger that overstates what was verified.

**Out of scope, stated rather than implied.** A compromised host; a malicious operator (who holds the
Ed25519 signing keys and can author any record); the model being adversarially influenced by content it
reads; physical access.

## The control chain

| stage | mechanism | file |
| :--- | :--- | :--- |
| emission | `isTestPath` refuses test segments and test-shaped filenames **before** the write | `plugin/src/emission.ts` |
| declaration | `contractViolations` hashes declared contract files before/after; created, deleted or modified fails the unit | `plugin/src/contracts.ts` |
| command parse | `tokenizeCommand` splits into argv; unbalanced quotes fail closed | `plugin/src/sandbox.ts` |
| command validate | empty → shell operators → runner mode → runtime; each refusal names its remediation | `plugin/src/sandbox.ts` |
| execution | `spawnSync(binary, args, { shell: false })` — no `cmd.exe`, no `sh` | `plugin/src/verification.ts` |
| node flags | `--permission --allow-fs-read/write=<workspace>` plus temp | `plugin/src/sandbox.ts` |
| preload | frozen `Object`/`Array`/`Function` prototypes; `net.Socket.prototype.connect` and `fetch` severed; environment scrubbed (keeping `NODE_OPTIONS` so a grandchild cannot start unsandboxed) | `plugin/src/sandbox.ts` |
| verdict | lattice with a fixed precedence: boundary > gate > flaky > coherence > unverified > success | `plugin/src/sandbox.ts`, `src/core/protocol/task-lifecycle.ts` |
| ledger | Ed25519 note per unit, dual signature, digest-bound to bytes at HEAD | `scripts/attest-unit.cjs` |

## What was probed, and what happened

Four hostile leaves, executed the way a delegation executes one — through the contract runner in a
subprocess:

| probe | before the sandbox | with the sandbox |
| :--- | :--- | :--- |
| `Object.prototype.redteam = …` at import | executed | `TypeError: object is not extensible` |
| `execSync('whoami')` | executed, returned the operator account | `ERR_ACCESS_DENIED` |
| `fetch('http://127.0.0.1:1234/…')` | executed, HTTP 200 | `ERR_SANDBOX_NETWORK_DENIED` |
| `readFileSync('C:/Windows/win.ini')` | executed, 92 bytes read | `ERR_ACCESS_DENIED` |

Command-level probes: `node --test …` is refused (`REFUSED_UNSANDBOXED_RUNNER`); `python`, `sh`, `bash`,
`powershell`, `deno`, `bun` are refused (`REFUSED_UNSANDBOXED_RUNTIME`); `node a.cjs && python b.py`
is refused (`REFUSED_SHELL_OPERATORS`); an unbalanced quote is refused
(`REFUSED_UNBALANCED_QUOTES`).

Argv integrity is asserted, not assumed: `node argv.cjs "a b" "c;d" "e&f"` reaches
`process.argv.slice(2)` as three intact arguments, where a shell would have split or interpreted all
three.

## Known limits — the reviewer should start here

1. **Test paths are matched by name.** A test written as `src/check-my-thing.ts` passes `isTestPath`.
   Content sniffing would close it and would refuse legitimate diagnostic modules; the realistic
   failure (a worker asked to "write the test") is caught.
2. **The OS temp directory is readable and writable** inside the sandbox. Contracts write counters,
   fixtures and logs there. The repository and the home directory remain unreadable.
3. **A command that begins with `node` is what is validated.** With `shell: false` a second command
   cannot be chained, but an argument can still be a path to any script — the sandbox is what constrains
   that script, not the validator.
4. **`NODE_OPTIONS` is preserved in the scrubbed environment**, deliberately: removing it would let a
   grandchild `node` start unsandboxed. A contract that clears its own environment is out of scope.
5. **No runtime containment outside node.** The permission model reaches node processes only, which is
   why non-node runtimes are refused rather than run.

## Findings from the first scan, and their status

An external static review of `441f004` reported 9 findings (1 high, 8 medium). The full report is
[`security-review-6.md`](security-review-6.md). Status at the time of writing:

| # | finding | status |
| :--- | :--- | :--- |
| 1 | **Relative node path can execute a shadow binary** — a basename check accepted `./node.exe`, and with `shell: false` that path runs directly | **FIXED**: the binary must be the bare `node`/`node.exe` or exactly `process.execPath`, and the spawn always uses `process.execPath`. `REFUSED_SHADOW_RUNTIME`; five shadow spellings covered by tests |
| 2 | Contract files can be passed as `contextFiles`, exposing the tests to the worker | **FIXED**: `validateDelegationContext` refuses the delegation before any file is read, resolving and case-folding both lists so `./tests/x` and `tests/x` collide on Windows. `REFUSED_CONTRACT_AS_CONTEXT`, status `CONTEXT_REFUSED`, worker never called |
| 3 | Promotion gate reads the working tree rather than the staged index; `git diff` errors can pass silently | open |
| 4–7 | Opaque patch writes; `.d.ts` suffix bypass; wildcard shell reads; non-TS source reads | open |
| 8 | DLP scans prompts but not credential-bearing tool results | open |
| 9 | *(see report)* | open |

The high finding is the one this brief's own first question anticipated — "can a command be satisfied by
something whose binary is `node` but which is not the sandboxed node?" The answer was yes, through
`PATH`-shaped tokens that the validator treated as trustworthy.

## How to reproduce

```powershell
# the boundary suites
npm run test:fast            # sandbox + precedence + lattice parity, ~7 s
npm --prefix plugin test     # 205 unit tests, includes the four hostile-leaf cases

# the command gate
npm run gate                 # hygiene, AST fences, contracts, ledger, coverage

# the full local matrix
npm --prefix plugin run test:oracles
```

The four hostile leaves are in `plugin/tests/sandbox-verification.test.ts`; the tokenizer and
command-validation cases are in the same file. None of them needs a model or the network.

## Questions for the reviewer

- Can the validator be satisfied by a command whose binary is `node` but whose behaviour is not the
  sandboxed node (a shim on `PATH`, a `node` script that re-execs)?
- Does the preload actually cover every egress path on this Node version, or only `fetch` and
  `net.Socket.prototype.connect`?
- Is the temp directory exemption defensible as scoped, or does it create a channel that outlives the
  verification run?
- Does the verdict lattice hold when an attacker controls the model's output rather than its inputs?
