#!/usr/bin/env node
/**
 * Read one DSH session's own transcript and report the numbers PROTOCOL.md needs.
 *
 * WHY THIS EXISTS. The protocol names `CONTEXT_QUALITY` as the source of its primary metric, and that
 * was wrong when it was written. The trace is a *snapshot*: `context-quality.ts` folds session events
 * into `lastPromptTokens` and `peakPromptTokens` and nothing else, so per-call prompt sizes are never
 * recorded and the cumulative figure the experiment needs cannot be recovered from it. Checking this
 * cost one read of the module; assuming it would have cost the experiment's primary metric.
 *
 * The transcript does carry it. `session.v3.jsonl.zstd` is a sequence of independent zstd frames, each
 * holding JSONL session events, and every `assistant/message` carries the host's own usage record for
 * that call. Summing `inputTokens + cacheReadTokens` over those records is the cumulative prompt the
 * model was billed to carry across the run -- the metered cost the protocol wants to compare.
 *
 * The number is reported two ways on purpose. `inputTokens` alone is the uncached remainder and
 * `cacheReadTokens` is the cached prefix; on a long session the prefix is almost all of it. They are
 * different prices and different claims, so one collapsed figure would hide which one moved.
 *
 * NOTE ON SCOPE. A session transcript records the *session's* model calls. A delegated worker runs in
 * the plugin's own process, not as session calls, so for the delegated arm this measures the architect
 * and not the worker -- which is the comparison the protocol asks for, since the worker is not metered.
 * Do not add the ledger's worker tokens into these totals.
 *
 * Usage:
 *   node experiments/delegation-ab/measure-session.cjs <session-id-prefix>
 *   node experiments/delegation-ab/measure-session.cjs --path <file.jsonl.zstd>
 *   node experiments/delegation-ab/measure-session.cjs --list
 *
 * Add --json for a single machine-readable object, which is what gets pasted into the results table.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

/** zstd magic number, little-endian. Frames are concatenated; the stream API stops at the first. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const TRANSCRIPT_NAME = 'session.v3.jsonl.zstd'

function sessionsRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
}

/** Every transcript under the sessions root, newest first, with its session id parsed from the folder. */
function listSessions() {
  const root = sessionsRoot()
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name === TRANSCRIPT_NAME) {
        const stat = fs.statSync(full)
        // The folder is named either `session-<uuid>` or bare `<uuid>`.
        const id = path.basename(dir)
        found.push({ id, file: full, bytes: stat.size, mtime: stat.mtimeMs })
      }
    }
  }
  walk(root, 0)
  return found.sort((a, b) => b.mtime - a.mtime)
}

function resolveTargets(argv) {
  if (argv.includes('--list')) return { list: true }
  const pathFlag = argv.indexOf('--path')
  if (pathFlag !== -1) {
    const file = argv[pathFlag + 1]
    if (!file) throw new Error('--path needs a file')
    return { files: [{ id: path.basename(path.dirname(file)), file: path.resolve(file) }] }
  }
  const prefix = argv.find((a) => !a.startsWith('--'))
  const all = listSessions()
  if (!prefix) {
    if (all.length === 0) throw new Error('no transcripts found under ' + sessionsRoot())
    return { files: [all[0]] }
  }
  const matched = all.filter((s) => s.id.includes(prefix))
  if (matched.length === 0) throw new Error('no session matching ' + JSON.stringify(prefix))
  return { files: matched }
}

/**
 * Split a concatenated-zstd file into frames and decompress each.
 *
 * `zlib.zstdDecompressSync` decodes only the FIRST frame, which is why reading this file the obvious
 * way returns the 201-byte session header and nothing else -- and why a careless reader would conclude
 * the transcript holds no usage data. Splitting on the magic number is the whole trick. A frame that
 * fails to decode is skipped rather than fatal: one unreadable frame must not void a whole run.
 */
function readTranscript(file) {
  const buffer = fs.readFileSync(file)
  const offsets = []
  for (let at = 0; ; ) {
    const found = buffer.indexOf(ZSTD_MAGIC, at)
    if (found < 0) break
    offsets.push(found)
    at = found + ZSTD_MAGIC.length
  }
  const events = []
  let badFrames = 0
  for (let index = 0; index < offsets.length; index++) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8')
    } catch {
      badFrames++
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        badFrames++
      }
    }
  }
  return { events, frames: offsets.length, badFrames }
}

/** `inputTokens` is the uncached remainder, `cacheReadTokens` the cached prefix; both are metered. */
function promptOf(usage) {
  if (!usage || typeof usage.inputTokens !== 'number' || !Number.isFinite(usage.inputTokens)) {
    return null
  }
  const cached =
    typeof usage.cacheReadTokens === 'number' && Number.isFinite(usage.cacheReadTokens)
      ? usage.cacheReadTokens
      : 0
  return { uncached: usage.inputTokens, cached, prompt: usage.inputTokens + cached }
}

function measure(file) {
  const { events, frames, badFrames } = readTranscript(file)
  const totals = {
    calls: 0,
    /** The primary metric: sum of inputTokens + cacheReadTokens over every call. */
    cumulativeInputTokens: 0,
    /** The uncached remainder alone. A different price and a different claim. */
    cumulativeUncachedInputTokens: 0,
    cumulativeCachedInputTokens: 0,
    cumulativeOutputTokens: 0,
    completions: 0,
    peakPromptTokens: 0,
    turns: 0,
    steps: 0,
    compactions: 0,
    prunes: 0,
    failedCompactions: 0,
    tokensReclaimed: 0,
    toolCalls: 0,
    delegatedCalls: 0,
  }
  const routes = {}
  let callsWithoutUsage = 0
  let firstTime = null
  let lastTime = null

  for (const event of events) {
    if (typeof event.time === 'number') {
      if (firstTime === null) firstTime = event.time
      lastTime = event.time
    }
    switch (event.type) {
      case 'assistant/message': {
        const usage = event.data && event.data.usage
        const source = (event.data && event.data.message && event.data.message.source) || {}
        const label = (source.provider || '?') + '/' + (source.model || '?')
        routes[label] = (routes[label] || 0) + 1
        const prompt = promptOf(usage)
        if (!prompt) {
          callsWithoutUsage++
          break
        }
        totals.calls++
        totals.cumulativeInputTokens += prompt.prompt
        totals.cumulativeUncachedInputTokens += prompt.uncached
        totals.cumulativeCachedInputTokens += prompt.cached
        if (prompt.prompt > totals.peakPromptTokens) totals.peakPromptTokens = prompt.prompt
        break
      }
      case 'assistant/attempt': {
        // A completion the harness recorded separately (retries, failed streams).
        const usage = event.data && event.data.usage
        if (usage && typeof usage.outputTokens === 'number') {
          totals.completions++
          totals.cumulativeOutputTokens += usage.outputTokens
        }
        const prompt = promptOf(usage)
        if (prompt) {
          totals.cumulativeInputTokens += prompt.prompt
          totals.cumulativeUncachedInputTokens += prompt.uncached
          totals.cumulativeCachedInputTokens += prompt.cached
        }
        break
      }
      case 'turn/start':
        totals.turns++
        break
      case 'step/start':
        totals.steps++
        break
      case 'compaction/summary':
        totals.compactions++
        if (typeof event.data?.shadowedTokenCount === 'number') {
          totals.tokensReclaimed += event.data.shadowedTokenCount
        }
        break
      case 'compaction/prune':
        totals.prunes++
        if (typeof event.data?.shadowedTokenCount === 'number') {
          totals.tokensReclaimed += event.data.shadowedTokenCount
        }
        break
      case 'compaction/end':
        if (typeof event.data?.error === 'string' && event.data.error) totals.failedCompactions++
        break
      case 'tool/call': {
        totals.toolCalls++
        if (event.data?.name === 'delegate_worker') totals.delegatedCalls++
        break
      }
      default:
        break
    }
  }

  return {
    session: path.basename(path.dirname(file)),
    file,
    frames,
    badFrames,
    events: events.length,
    calls: totals.calls,
    callsWithoutUsage,
    cumulativeInputTokens: totals.cumulativeInputTokens,
    cumulativeUncachedInputTokens: totals.cumulativeUncachedInputTokens,
    cumulativeCachedInputTokens: totals.cumulativeCachedInputTokens,
    avgPromptTokens:
      totals.calls > 0 ? Math.round(totals.cumulativeInputTokens / totals.calls) : 0,
    peakPromptTokens: totals.peakPromptTokens,
    turns: totals.turns,
    steps: totals.steps,
    compactions: totals.compactions,
    prunes: totals.prunes,
    failedCompactions: totals.failedCompactions,
    tokensReclaimed: totals.tokensReclaimed,
    toolCalls: totals.toolCalls,
    delegatedCalls: totals.delegatedCalls,
    routes,
    wallClockMs: firstTime !== null && lastTime !== null ? lastTime - firstTime : null,
  }
}

function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const target = resolveTargets(argv)

  if (target.list) {
    for (const session of listSessions()) {
      const when = new Date(session.mtime).toISOString()
      console.log(when + '  ' + session.id + '  ' + Math.round(session.bytes / 1024) + ' KB')
    }
    return
  }

  const rows = target.files.map((candidate) => measure(candidate.file))
  if (asJson) {
    console.log(JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2))
    return
  }
  for (const row of rows) {
    const hours = row.wallClockMs === null ? '?' : (row.wallClockMs / 3600000).toFixed(2) + ' h'
    console.log('session      ' + row.session)
    console.log(
      'calls        ' +
        row.calls +
        (row.callsWithoutUsage ? ' (+' + row.callsWithoutUsage + ' without usage)' : '')
    )
    console.log(
      'cumulative   ' +
        row.cumulativeInputTokens.toLocaleString('en-US') +
        ' input tokens  <- primary metric'
    )
    console.log('  uncached   ' + row.cumulativeUncachedInputTokens.toLocaleString('en-US'))
    console.log('  cached     ' + row.cumulativeCachedInputTokens.toLocaleString('en-US'))
    console.log('average      ' + row.avgPromptTokens.toLocaleString('en-US') + ' tokens per call')
    console.log('peak         ' + row.peakPromptTokens.toLocaleString('en-US') + ' tokens in one prompt')
    console.log(
      'shape        ' +
        row.turns +
        ' turns, ' +
        row.steps +
        ' steps, ' +
        row.toolCalls +
        ' tool calls, ' +
        row.delegatedCalls +
        ' delegated'
    )
    console.log(
      'hygiene      ' +
        row.compactions +
        ' compactions, ' +
        row.prunes +
        ' prunes, ' +
        row.tokensReclaimed.toLocaleString('en-US') +
        ' tokens reclaimed'
    )
    console.log('routes       ' + JSON.stringify(row.routes))
    console.log('elapsed      ' + hours)
    console.log('')
  }
}

main()
