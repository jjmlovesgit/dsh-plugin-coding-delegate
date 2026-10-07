# Which DSH core is running, and the Desktop 0.22.4 update

This supersedes an earlier version of this document whose central premise was wrong. The mistake was a
reasonable one and the correction is the useful part, so both are recorded.

## The correction

The earlier version said: dsh `0.1.5-rc.3` is installed, `0.2.0-rc.2` is pending, here is whether the plugin
survives the jump. I then "verified" that by reading the event vocabulary out of the npm-global package tree.

None of it was right, because **`dsh --version` reports what PATH points at, not what is running.**

| | |
| --- | --- |
| What `dsh --version` says | `0.1.5-rc.3` — `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` |
| What actually loads this plugin | **`0.2.0-rc.2`** — `%APPDATA%\dsh-tauri\dependencies\dsh` |
| Who installed that copy | the Desktop app, as a managed dependency |
| The npm-global copy | a stray install that **nothing references** |

Two independent facts make it decisive rather than probable:

- `%APPDATA%\dsh-tauri\dependencies.json` resolves the dependencies explicitly — `node`, `pnpm` and `git` to
  `null` (system environment), but `dsh` to the managed root. The Desktop's `manifest.jsonc` declares that
  root's entry point as `node_modules/@deepseek-ai/dsh/lib/bin.js`, and it exists there.
- `%APPDATA%\dsh-tauri` contains no reference to `AppData\Roaming\npm` at all.

The managed core was installed **2026-10-06 17:58**; the A2 live run happened the following evening. So
everything in [`live-verification.md`](live-verification.md) was exercised against `0.2.0-rc.2`.

## Does the plugin work on 0.2.0-rc.2?

**Yes, and that is measured rather than inferred.** The plugin has been running on it the whole time:

- The A2 loop was live-verified through the registered tool path — three `delegate_worker` calls, a real
  failure at `src/thing.ts:30:5`, and the next attempt receiving lines 20–40 as metadata only. That single
  run exercises `tools.register`, the registered tool path, the approval seam, the verification spawn,
  emission under unit scope, and `session/event`.
- The seven event types the context-quality counters depend on are all present in the running host, out of
  59 unique types, with **nothing removed** relative to `0.1.5-rc.3` — only `developer/message`,
  `image/offload` and `workspace/changes` added. (`image/offload` is listed twice in the generated
  `Set` literal; harmless, and worth knowing before someone counts 60 and expects 60.)

So the question the earlier version of this document tried to answer statically had already been answered
empirically. That is the general lesson: **the running host is an oracle this project already has and keeps
forgetting to consult.**

## The pending update is the Desktop shell, not the core

`deepseek-harness-desktop.exe` on disk is **0.22.3**; **0.22.4** is downloaded and waiting. That is a
different product from `@deepseek-ai/dsh` — different repository (`dsh-tauri/deepseek-harness-desktop`),
different version scheme, different maintainers — and it *bundles or manages* a dsh core rather than being
one.

Its own manifest recommends core **`0.2.0-rc.2`**, which is what is installed. So this update is the app
shell. From the v0.22.4 notes, it is: a nightly-build CI pipeline, multi-mirror fallbacks for GitHub release
downloads, a Skills/MCP toast change that decides restart-need from host HMR capability, and UI/CI fixes.

**Nothing in it touches the plugin's host surface.** The one thing an app update *can* do is change the
recommended core version in `manifest.jsonc` and trigger a core change underneath you — so the single check
worth doing afterwards is re-reading that file next to `dependencies.json`.

## Two things found while checking, neither of them about the update

**1. The oracle suite writes into the live plugin data directory.** `router-debug.log` is 3.3 MB and ~120,000
lines, with test fixtures — a fake Slack token, an RSA key, `hunter2hunter2` — interleaved into live
traffic. `vitest.config.ts` redirects `DSH_HOME` for the unit tests, but the 275 `.cjs` oracles run under
`node --test`, which never loads that config. Only 7 of 28 oracles redirect the data dir themselves. This
matters more than tidiness suggests: `router-debug.log` **is** this project's live-observation instrument,
and the test suite is writing into it. Recorded in [`findings.md`](findings.md).

**2. A stray `dsh` on PATH.** `dsh` resolves to the unreferenced `0.1.5-rc.3` copy. Any diagnostic run from
a terminal — `dsh --dump-config`, `dsh --version`, `--dump-config-schema` — inspects a **different
installation** from the one serving the session. That is exactly the trap this document fell into, and it
will catch the next person too.

## Verification, corrected

**Is the running core what the Desktop says it is?**

```powershell
Get-Content "$env:APPDATA\dsh-tauri\dependencies.json" -Raw
(Get-Content "$env:APPDATA\dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai\dsh\package.json" -Raw |
  ConvertFrom-Json).version
```

**Does the running host still know every event the plugin watches?** This is the check that catches a
rename no changelog mentions, and it silently zeroes the counters rather than crashing:

```powershell
function Get-DshEventVocabulary([string]$Path) {
  Select-String -Path $Path -Pattern "^\s+'([a-z0-9/-]+)',$" |
    ForEach-Object { $_.Matches[0].Groups[1].Value }
}
$core  = "$env:APPDATA\dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai"
$known = Get-DshEventVocabulary "$core\dsh-session\lib\types\known-event-types.js"
$used  = 'turn/start','assistant/message','request/context',
         'compaction/summary','compaction/prune','compaction/end','step/start'
$used | Where-Object { $_ -notin $known }
```

Expect no output. **The earlier version of this document had a broken version of this command** —
`(Select-String ...).Matches.Groups[1].Value` — which indexes the *second match's* group collection instead
of group 1 of every match. It returns a single value, which is why running it the first time reported "1
event type" and all seven missing. A broken detector that reports catastrophic failure is worse than no
detector; it was caught only by disbelieving the result and reading the file.

**Does the plugin still work end to end?** Re-run the three-call A2 loop. It remains the closest thing to a
host integration test this project has.

## One open question, resolved

The earlier version of this document left this unanswered: `~/.dsh/config.json` registers the plugin under
its **old name** `dsh-plugin-local-router` pointing at the same `dist/index.js`, while
`~/.dsh/profiles/web/package.json` registers it as the bundle `dsh-plugin-coding-delegate`. Two
registrations of one plugin.

**It is not a double mount.** The plugin's `console.log`/`console.warn` go to
`%APPDATA%\dsh-tauri\logs\desktop.log` — **not** to `router-debug.log`, which receives only `trace()` output.
Searching the trace log for the duplicate-mount guard was invalid before that log's pollution is even
considered; the earlier note cited the pollution as the reason, which was the wrong reason.

Read from the right file, `desktop.log` carries exactly one
`[LOCAL_ROUTER_INIT] Tool 'delegate_worker' registered successfully on ctx.tools.` per host start, and no
`Plugin already registered` line among 311 plugin markers. Single mount; the guard was never needed.

That file is worth knowing about for a second reason: lines like
`[LOCAL_GUARD] ALLOWED-ONCE pwsh -> plugin/vitest.config.ts` show the guard mediating **reads** of source
files, not only writes.

## The 0.22.4 update, applied and verified

The update was installed. Checked against the same questions as before:

| | before | after |
| --- | --- | --- |
| Desktop shell | 0.22.3 | **0.22.4** |
| manifest recommends dsh | 0.2.0-rc.2 | **0.2.0-rc.2** — unchanged |
| `dependencies.json` → `dsh` | managed root | **same root**, unchanged |
| managed core | 0.2.0-rc.2 | **0.2.0-rc.2**, root untouched |

The app update did not touch the core, which is what the manifest check was for. The plugin re-mounted once
on the restart (one `LOCAL_ROUTER_INIT`), a smoke delegation returned `SUCCESS` while writing no files, and
the trace log shows live `agent/request` and `CONTEXT_QUALITY` entries from the running session afterwards.

## What this does not establish

- **Which core a *future* Desktop update would install.** The `manifest.jsonc` inside 0.22.4 still
  recommends `0.2.0-rc.2`. If a later manifest raises `recommend` above what is installed, the core changes
  and the event-vocabulary check above becomes a real check again rather than a formality.
- **Anything about a *future* core upgrade.** The static audit the earlier version of this document
  contained is still a reasonable method; it was simply pointed at the wrong install.

## The shortcut for next time

Read `dependencies.json` first. It is one small file, it names the resolved root of every runtime
dependency, and it is the difference between auditing the host and auditing a stranger.
