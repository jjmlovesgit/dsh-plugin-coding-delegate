#!/usr/bin/env node
/**
 * Measure what the architect actually READS, from the plugin's own audit trace.
 *
 * WHY THIS EXISTS. Every remaining question about this design turns on one number nobody has looked at:
 * how much source the architect reads, in bytes and in tokens, against how much it emits. The plugin has
 * recorded every source read since the read guard was built, so the measurement is available from
 * telemetry rather than from an experiment that has to be arranged.
 *
 * WHAT THE TRACE DOES AND DOES NOT CARRY, because the difference decides how honest the output is.
 * `SOURCE_READ` is emitted per read with `{ role, agent, tool, target, extension }`. It carries NO byte
 * count, no line range and no hash -- an earlier revision of `docs/control-effectiveness.md` claimed all
 * three, and that was wrong. Byte sizes are therefore resolved from the file ON DISK at analysis time,
 * which is a good approximation for files that have not changed since the read and a wrong one for files
 * that have. Every figure below is reported with that caveat attached rather than laundered through it.
 *
 * A second limit, and it is not small: the trace fires only for `CODE_EXTENSIONS`. Reads of markdown,
 * JSON, logs and configuration are invisible here. So this measures SOURCE reading, which is the reading
 * the guard exists for, and not total context ingestion. `measure-session.cjs` in `experiments/` measures
 * total metered tokens; the two are different instruments answering different questions.
 *
 * Usage:
 *   node scripts/measure-reading-cost.cjs
 *   node scripts/measure-reading-cost.cjs --log <router-debug.log>
 *   node scripts/measure-reading-cost.cjs --json
 *   node scripts/measure-reading-cost.cjs --top 15
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

function dataDir() {
  const explicit = process.env.DSH_LOCAL_ROUTER_DATA_DIR
  if (explicit && explicit.trim()) return explicit.trim()
  const home = process.env.DSH_HOME
  if (home && home.trim()) return path.join(home.trim(), 'local-router')
  return path.join(os.homedir(), '.dsh', 'local-router')
}

/** Four characters per token is the usual rough constant for source. Named so it can be argued with. */
const BYTES_PER_TOKEN = 4

function argValue(name, argv) {
  const at = argv.indexOf('--' + name)
  return at !== -1 && argv[at + 1] ? argv[at + 1] : null
}

/**
 * Every `SOURCE_READ` record in the trace.
 *
 * The log is a sequence of blocks each opening with `[timestamp] === EVENT ===`, so splitting on the
 * timestamp is what keeps a JSON body from being read as two records. A block whose body will not parse
 * is COUNTED as malformed rather than skipped silently -- a measurement that quietly drops input it does
 * not understand is the failure this whole file is meant to avoid.
 */
function readTrace(logPath) {
  const text = fs.readFileSync(logPath, 'utf8')
  const blocks = text.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/)
  const records = []
  let malformed = 0
  for (const block of blocks) {
    if (!block.includes('=== SOURCE_READ ===')) continue
    const firstBrace = block.indexOf('{')
    const lastBrace = block.lastIndexOf('}')
    if (firstBrace < 0 || lastBrace < firstBrace) {
      malformed++
      continue
    }
    try {
      records.push(JSON.parse(block.slice(firstBrace, lastBrace + 1)))
    } catch {
      malformed++
    }
  }
  return { records, malformed }
}

/** Size on disk now, or null when the file is gone. Cached, so each path is stat'ed once. */
function sizeCache() {
  const seen = new Map()
  return (target) => {
    if (seen.has(target)) return seen.get(target)
    let size = null
    try {
      const stat = fs.statSync(target)
      if (stat.isFile()) size = stat.size
    } catch {
      size = null
    }
    seen.set(target, size)
    return size
  }
}

function main() {
  const argv = process.argv.slice(2)
  const logPath = argValue('log', argv) || path.join(dataDir(), 'router-debug.log')
  const top = Number(argValue('top', argv) || 12)
  const asJson = argv.includes('--json')

  if (!fs.existsSync(logPath)) {
    console.error('no trace at ' + logPath)
    process.exit(2)
  }

  const { records, malformed } = readTrace(logPath)
  const sizeOf = sizeCache()

  const byRole = {}
  const byTool = {}
  const byPath = new Map()
  let unreadable = 0

  for (const record of records) {
    const role = String(record.role || 'unknown')
    const target = String(record.target || '(unknown)')
    const tool = String(record.tool || '(unknown)')
    const size = sizeOf(target)
    if (size === null) unreadable++

    byRole[role] = byRole[role] || { reads: 0, distinct: new Set(), bytes: 0 }
    byRole[role].reads++
    byRole[role].distinct.add(target)
    if (size !== null) byRole[role].bytes += size

    byTool[tool] = (byTool[tool] || 0) + 1

    const entry = byPath.get(target) || { reads: 0, size }
    entry.reads++
    byPath.set(target, entry)
  }

  const architect = byRole.architect || { reads: 0, distinct: new Set(), bytes: 0 }
  const distinctBytes = [...architect.distinct].reduce((sum, p) => {
    const size = sizeOf(p)
    return sum + (size === null ? 0 : size)
  }, 0)

  const hottest = [...byPath.entries()].sort((a, b) => b[1].reads - a[1].reads).slice(0, top)

  const summary = {
    log: logPath,
    sourceReadRecords: records.length,
    malformedBlocks: malformed,
    pathsNotFound: unreadable,
    architect: {
      reads: architect.reads,
      distinctFiles: architect.distinct.size,
      /** Every read counted separately: what was paid for if each entered the window once. */
      bytesIfCountedPerRead: architect.bytes,
      /** Each file counted once: the irreducible size of the source it looked at. */
      bytesDistinct: distinctBytes,
      tokensIfCountedPerRead: Math.round(architect.bytes / BYTES_PER_TOKEN),
      tokensDistinct: Math.round(distinctBytes / BYTES_PER_TOKEN),
      /** Reads per distinct file: above ~2 means the same file is re-read across turns. */
      readAmplification: architect.distinct.size
        ? Number((architect.reads / architect.distinct.size).toFixed(2))
        : 0,
    },
    byRole: Object.fromEntries(
      Object.entries(byRole).map(([role, v]) => [
        role,
        { reads: v.reads, distinctFiles: v.distinct.size, bytes: v.bytes },
      ])
    ),
    byTool,
    hottestPaths: hottest.map(([p, v]) => ({ path: p, reads: v.reads, bytes: v.size })),
  }

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }

  const n = (value) => Number(value).toLocaleString('en-US')
  console.log('trace            ' + logPath)
  console.log(
    'source reads     ' +
      n(records.length) +
      ' records' +
      (malformed ? '  (' + malformed + ' unparseable, counted not skipped)' : '')
  )
  console.log('')
  console.log('ARCHITECT READING FOOTPRINT')
  console.log('  read events          ' + n(architect.reads))
  console.log('  distinct files       ' + n(architect.distinct.size))
  console.log('  reads per file       ' + summary.architect.readAmplification + '   (re-reading across turns)')
  console.log(
    '  bytes, per read      ' +
      n(summary.architect.bytesIfCountedPerRead) +
      '  ~' +
      n(summary.architect.tokensIfCountedPerRead) +
      ' tokens'
  )
  console.log(
    '  bytes, distinct      ' +
      n(summary.architect.bytesDistinct) +
      '  ~' +
      n(summary.architect.tokensDistinct) +
      ' tokens'
  )
  if (unreadable) {
    console.log('  paths not on disk    ' + n(unreadable) + '  (size unknown, excluded from byte totals)')
  }
  console.log('')
  console.log('BY ROLE')
  for (const [role, v] of Object.entries(summary.byRole)) {
    console.log(
      '  ' +
        role.padEnd(12) +
        n(v.reads).padStart(6) +
        ' reads   ' +
        n(v.distinctFiles).padStart(5) +
        ' files   ' +
        n(v.bytes).padStart(12) +
        ' bytes'
    )
  }
  console.log('')
  console.log('BY TOOL      ' + JSON.stringify(byTool))
  console.log('')
  console.log('HOTTEST PATHS')
  for (const row of summary.hottestPaths) {
    console.log(
      '  ' +
        String(row.reads).padStart(4) +
        'x  ' +
        String(row.bytes === null ? '?' : row.bytes).padStart(9) +
        '  ' +
        row.path
    )
  }
  console.log('')
  console.log('CAVEATS, because they change what this number means:')
  console.log('  * byte sizes come from the file on disk NOW, not from the read; a file edited since is mis-sized')
  console.log('  * the trace fires only for CODE_EXTENSIONS, so markdown, JSON and config reads are invisible')
  console.log('  * ~' + BYTES_PER_TOKEN + ' bytes per token is a rough constant for source, not a tokeniser')
  console.log('  * "per read" is not "metered": a file read once is re-sent on every later turn, which this')
  console.log('    instrument cannot see. That figure is in the session transcript, not here.')
}

main()
