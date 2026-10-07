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

export function trace(event: string, data: any) {
  const timestamp = new Date().toISOString()
  const entry = `\n[${timestamp}] === ${event} ===\n${
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  }\n`

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, entry, 'utf8')
  } catch (err) {}
}
