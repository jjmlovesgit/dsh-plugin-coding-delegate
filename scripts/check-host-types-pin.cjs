#!/usr/bin/env node
/**
 * Contract check: the host type packages this plugin compiles against must be the versions the running
 * host actually is.
 *
 * `plugin/src/session-events.ts` checks this plugin's event vocabulary against `@deepseek-ai/dsh-session`'s
 * own `SessionEventMap` at compile time. That check is worth something only while the pinned types
 * describe the host that is running. Types that have drifted describe a host that does not exist, and a
 * green build against them is worse than no check at all, because it looks like evidence.
 *
 * The running host is located the way the Desktop locates it: `%APPDATA%/dsh-tauri/dependencies.json`
 * records the resolved root of each runtime dependency, and `dsh` there points at the managed core rather
 * than at whatever `dsh` on PATH happens to be. Confusing those two already cost this project one
 * entirely wrong audit -- see `docs/dsh-0.2-upgrade.md`.
 *
 * The declared dependency is checked as well as the installed one, because `^0.2.0-rc.2` would let a
 * later install silently move the types while the build stayed green.
 *
 * Usage:  node scripts/check-host-types-pin.cjs
 * Exit 0 when the pins match the running host, or when no host is resolvable; 1 when they do not.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const PLUGIN = path.join(REPO, 'plugin')

/**
 * The host packages whose types this plugin compiles against.
 *
 * `session-events.ts` needs `dsh-session` for session event TYPES and `dsh-compaction` for the
 * declaration-merged `compaction/*` events. `host-events.ts` needs `cordis` for the `Events` interface
 * and `dsh-agent`/`dsh-tools` for the augmentations that put `agent/*` and `tools/*` into it. A pin that
 * drifts on any of them silently describes a host that is not running.
 */
const HOST_TYPE_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
]

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Where the Desktop records each runtime dependency's resolved root. `null` means "system environment". */
function resolveHostCoreRoot() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const deps = readJson(path.join(appData, 'dsh-tauri', 'dependencies.json'))
  if (!deps || typeof deps.dsh !== 'string' || !deps.dsh) return null
  return deps.dsh
}

function installedVersion(root, pkg) {
  const manifest = readJson(path.join(root, 'node_modules', pkg, 'package.json'))
  return manifest && typeof manifest.version === 'string' ? manifest.version : null
}

const coreRoot = resolveHostCoreRoot()
if (!coreRoot) {
  console.log('SKIP: no managed dsh core is resolvable from this environment.')
  console.log('      This check compares the pinned host types against the RUNNING host, so it can only do')
  console.log('      its job where that host is. In CI it is inert by design -- see ROADMAP item 21.')
  process.exit(0)
}

const declared = (readJson(path.join(PLUGIN, 'package.json')) || {}).devDependencies || {}

const rows = HOST_TYPE_PACKAGES.map((name) => ({
  name,
  host: installedVersion(coreRoot, name),
  pinned: installedVersion(PLUGIN, name),
  spec: typeof declared[name] === 'string' ? declared[name] : null,
}))

console.log('host core root : ' + coreRoot)
console.log('')
let drift = 0

for (const row of rows) {
  const matches = row.host !== null && row.pinned === row.host
  if (!matches) drift++
  console.log(
    (matches ? 'OK    ' : 'DRIFT ') +
      row.name.padEnd(30) +
      ' host=' +
      String(row.host) +
      '  installed=' +
      String(row.pinned)
  )
}

// An exact pin is what keeps `npm install` from moving the types on its own. A caret is not a smaller
// version of the same thing; it is a different claim.
for (const row of rows) {
  if (row.spec === null) {
    console.log('DRIFT ' + row.name.padEnd(30) + ' not declared in plugin/package.json')
    drift++
  } else if (!/^\d/.test(row.spec)) {
    console.log('DRIFT ' + row.name.padEnd(30) + ' declared as "' + row.spec + '" -- must be an exact version')
    drift++
  }
}

console.log('')
if (drift === 0) {
  console.log('OK: every pinned host type package matches the running host, and is pinned exactly.')
  process.exit(0)
}

console.log('FAIL: the pinned host types no longer describe the running host.')
console.log('      Re-pin and rebuild:')
console.log('')
console.log('        cd plugin')
for (const row of rows) {
  if (row.host !== null && row.pinned !== row.host) {
    console.log('        npm install --save-dev --save-exact ' + row.name + '@' + row.host)
  }
}
console.log('        npm run build && npm run test:oracles')
process.exit(1)
