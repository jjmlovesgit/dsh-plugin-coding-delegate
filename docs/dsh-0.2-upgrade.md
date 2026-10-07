# DSH 0.1.5-rc.3 → 0.2.0-rc.2: what this plugin needs

Pre-flight note, written before the update. Every claim below was measured against the plugin source,
the host packages installed at `0.1.5-rc.3`, or the published `0.2.0-rc.2` type declarations — not
recalled from the changelog. What could not be measured is listed under "What this does not establish".

## What is pending

| | |
| --- | --- |
| Installed | `0.1.5-rc.3` (`dsh --version`, and the same in `@deepseek-ai/dsh/package.json`) |
| Published `latest` | `0.2.0-rc.2`, 2026-09-29 |
| Also out | `0.2.1-alpha.1`, 2026-10-03 — an alpha, so not the pending update |

The delta from what is installed is the [`dsh-v0.1.7-rc.1` release notes][v017], whose own compare link
is `v0.1.5-rc.3...v0.1.7-rc.1`. That list is the diff, not a summary of it, which is why it is the right
thing to audit against. `v0.2.0-rc.1` and `v0.2.0-rc.2` add the rest.

[v017]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1

## The finding that shapes the risk

**This plugin has no compile-time contract with the host at all.** No `@deepseek-ai/*` package appears in
`dependencies`, `devDependencies` or `node_modules`; there are no `peerDependencies`; there is no
`declare module` augmentation. Every host interaction is `as any` over hand-written assumptions about
event names and payload shapes.

The consequence, stated plainly: **nothing in `npm run build` can catch a host change.** The 39 unit tests
and the 275 oracle assertions encode *this plugin's* assumptions, so they will go on passing against a host
that has moved underneath them. The only real detectors are live observation and the event-vocabulary check
below. Everything else in this document is static analysis, and static analysis is exactly what this project
does not accept as proof.

## Checked, item by item

Every breaking change in the `0.1.5-rc.3 → 0.2.0` diff, and whether it reaches this plugin.

| Change | Reaches the plugin? | Evidence |
| --- | --- | --- |
| `agent/session-start` → async `agent/created` | **No** | The plugin registers `agent/request`, `agent/post-step`, `agent/step-finish`, `agent/assistant-stream`. `session-start` appears nowhere in `plugin/src` |
| `snapshotEvents`, `eventAt`, `ownEvents` deprecated | **No** | Not referenced |
| Session logs upgraded to V4 + migration tool | **No** | The plugin never reads a session log. It folds the `session/event` firehose (`context-quality.ts`) |
| `SandboxProvider.confine` / `ShellExecutor.start` → cancellable async | **No** | `verification.ts:493` uses Node's own `child_process.spawnSync` with **file-descriptor** capture, deliberately, because a piped spawn is refused in confined mode. It never calls the host sandbox |
| Workspace file reads move to `readBytes` | **No** | The plugin reads through `fs` directly |
| `spill-policy` `maxInlineBytes` → `maxInlineTokens` | **No config to migrate** | No spill configuration anywhere in `~/.dsh` |
| PTC / `workflow-ptc` / Ralph-off / E2B removal / `spawn_teammate` | **No** | None referenced |
| Continuable subagent chains capped at 8, depth 1 | **No** | The plugin starts no subagents |
| Cordis `4.0.2` → `~4.0.4` | **No runtime impact** | `dist/*.js` contains no `cordis` string at all: `import { Context } from 'cordis'` is type-only and erased. Note the plugin's `cordis: ^3.18.1` devDependency is the **unscoped community `cordis`** package — a different package from `@deepseek-ai/cordis`, not a v3-vs-v4 fork of one |
| Plugin locale/icon in `package.json`; multi-file bundle patches | **Additive** | The single-file `dsh.bundle.patch` form is retained |
| Plugin ↔ DSH compatibility check at install and startup | **Compatible by construction** | See below |
| Settings move to profile plugin configuration; `settings.yaml` imported **once** | **Profile-level** | See below |
| Hot reload loses transactional rollback | **Profile-level** | See below |
| pi-ai `0.87.1`; older model IDs removed | **Profile-level** | See below |

## Compatible by mechanism, not by inspection

The compatibility gate that would refuse a plugin is keyed on **declared peers**. From the shipped
`@deepseek-ai/dsh-plugin-manager@0.2.0-rc.2` declarations:

> `IncompatiblePlugin` — a package whose **declared DSH peers** reject the running DSH version, without an
> exemption for the exact pair. `peers: Record<string, string>` — *only the DSH peer ranges the running
> version does not satisfy.*

This plugin declares no `peerDependencies` at all, so the check has nothing to reject. The refusal also
carries `incompatible-version` on `ManagementError` and an exact-version exemption, so even a false
positive is recoverable rather than silent.

## What needs attention in the profile

None of these are plugin defects. All three are in `~/.dsh`, and all three are worth handling before the
update rather than after.

**1. `settings.yaml` is imported once, ever.** `~/.dsh/settings.yaml` (367 bytes) declares `ui-onboarding`,
`llm-deepseek.apiKeyEnv` and the `llm-pi-ai` `lm-studio` provider. The same provider block is *also* in
`~/.dsh/profiles/web/cordis.patch.yml`, which is the mechanism `0.2.0` keeps and improves. The migration is
attempted once and never retried, so a partial import has no second chance. The profile patch is the copy
that matters; the settings copy is the one to back up.

**2. `patchReload: live` now has no rollback.** The profile sets `"patchReload": "live"`. `0.1.7` removed
transactional rollback from hot reload: a parse failure preserves the original configuration, but an
**activation failure can leave partial changes** that must be corrected by hand. Capture the patch files
before the update.

**3. Model IDs.** `qwen/qwen3.8-27b` is a *custom* `llm-pi-ai` provider entry, so it is not in the built-in
catalog and should survive the catalog refresh. `cloudModel: deepseek-chat` and the architect's own
selection come from the catalog, so a saved selection may need reselecting. The plugin's local worker path
talks to LM Studio directly and is unaffected either way.

## Before updating

```powershell
$h = "$env:USERPROFILE\.dsh"
Copy-Item "$h\settings.yaml"                                    "$h\settings.yaml.pre-0.2.0"
Copy-Item "$h\profiles\web\cordis.patch.yml"                    "$h\profiles\web\cordis.patch.yml.pre-0.2.0"
Copy-Item "$h\profiles\web\package.json"                        "$h\profiles\web\package.json.pre-0.2.0"
```

The plugin is installed as `"dsh-plugin-coding-delegate": "link:C:/Projects/DSHLaya/plugin"` and declared
in `dsh.profile.bundles`, so it loads from this checkout's `dist/`. Rebuild before restarting, or the host
will start the previous build.

## After updating

1. `dsh --version` — expect `0.2.0-rc.2`.
2. `dsh --dump-config` — the `local-router` row must still be present with its config. `0.2.0` also adds
   `--dump-config-schema` for a static check of the same thing.
3. **Event vocabulary.** The host ships a generated, complete list of the event types it understands, and
   the plugin's context-quality counters depend on seven of them. This check is mechanical and is the one
   thing here that can catch a rename that no changelog line mentions:

   ```powershell
   $n = Join-Path (npm root -g) '@deepseek-ai\dsh\node_modules\@deepseek-ai'
   $known = (Select-String -Path "$n\dsh-session\lib\types\known-event-types.js" `
             -Pattern "^\s+'([a-z0-9/-]+)',$").Matches.Groups[1].Value
   $used  = 'turn/start','assistant/message','request/context',
            'compaction/summary','compaction/prune','compaction/end','step/start'
   $used | Where-Object { $_ -notin $known }
   ```

   **Expect no output.** Anything printed is an event the plugin watches that the new host no longer
   knows — which does not crash anything, it silently zeroes the counters. All seven are present in
   `0.1.5-rc.3`; that is the baseline this diff is against.
4. **Restart, then re-run the A2 live loop** (three `delegate_worker` calls, recorded in
   [`live-verification.md`](live-verification.md)). This is the only end-to-end host-integration test that
   exists: it exercises `tools.register`, the registered tool path, the approval seam, the verification
   spawn, emission under unit scope, and `session/event`, all at once. If it still passes, the host surface
   this plugin actually uses is intact.
5. `cd plugin; npm run build && npx vitest run && node --test tests/oracles/*.test.cjs` — 39 and 275. Green
   here means the plugin is self-consistent, not that the host is compatible; see the finding above.

## Rollback

```powershell
npm install -g @deepseek-ai/dsh@0.1.5-rc.3
```

Restore the three backed-up files if the settings migration wrote anything unexpected.

## What this does not establish

- **`0.2.0-rc.2` has not been run.** Everything above is static: this plugin's source, the `0.1.5-rc.3`
  host packages on disk, and the published `0.2.0-rc.2` type declarations. A behaviour change that no
  changelog line names would not appear in this document.
- **The compatibility conclusion rests on one doc comment.** The shipped `IncompatiblePlugin` says the
  check is on *declared peers*. `0.2.1-alpha.1`'s notes say compatibility is also checked "during startup",
  and if that path inspects something other than peers, the conclusion needs revisiting. It is the most
  load-bearing inference here.
- **A green oracle run is not evidence of compatibility**, for the reason in the first section.

## What would close this properly

Give the plugin the host contract it lacks: add `@deepseek-ai/dsh-session` (and whichever packages carry
the hooks it uses) as a pinned `devDependency`, and let the event names and payload shapes be *typed*
rather than asserted. That turns step 3 above from a manual pre-flight into a compile error, and it is the
honest follow-on to this document. It is not part of the update.
