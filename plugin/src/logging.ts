import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * All plugin state (debug log, savings ledger) lives under one derived directory.
 * It must never be a hard-coded absolute path: the previous build wrote its log
 * into the plugin author's own project directory on every machine, which was
 * correct on exactly one of them.
 * Precedence: explicit env override, then DSH_HOME, then ~/.dsh.
 */
export function resolveDataDir(): string {
  const explicit = process.env.DSH_LOCAL_ROUTER_DATA_DIR
  if (explicit && explicit.trim()) return explicit.trim()
  const dshHome = process.env.DSH_HOME
  if (dshHome && dshHome.trim()) return path.join(dshHome.trim(), 'local-router')
  return path.join(os.homedir(), '.dsh', 'local-router')
}

const LOG_FILE = path.join(resolveDataDir(), 'router-debug.log')

/**
 * Remove prompt text from a trace payload before it is written to disk.
 *
 * A debug log outlives the session, and call sites pass a prompt slice into it. No prompt content may
 * be persisted, so the value is replaced with its length rather than scanned for secrets: pattern
 * detection has false negatives, and a replacement is a guarantee where a pattern is a probability.
 * Every other field is preserved, because redaction that succeeds by writing nothing removes the
 * diagnostic value the log exists for.
 *
 * Pure and exported so it is testable directly. The caller's object is not mutated.
 */
export function redactTracePayload(data: any): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const copy: any = { ...data }
  if (typeof copy.prompt === 'string') {
    copy.prompt = 'prompt suppressed (' + copy.prompt.length + ' chars)'
  }
  return copy
}

export function trace(event: string, data: any) {
  const timestamp = new Date().toISOString()
  const payload = redactTracePayload(data)
  const entry =
    '\n[' + timestamp + '] === ' + event + ' ===\n' +
    (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)) +
    '\n'

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, entry, 'utf8')
  } catch (err) {}
}
