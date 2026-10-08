import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { resolveDataDir } from './logging'
import { canonicalisePath } from './paths'

/**
 * sha256 of a file, or null when it cannot be read. Callers treat null as a failure rather than as
 * absence: a contract file that vanished is a violation, not an empty string.
 */
export function sha256File(filePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch (err) {
    return null
  }
}

/**
 * Resolve the architect's declared contract paths against the workspace. Names only: the architect
 * never supplies contents, and the resolved list is what the worker is forbidden to write.
 */
export function resolveContractFiles(files: string[] | undefined, baseDir: string): string[] {
  const resolved: string[] = []
  for (const file of files ?? []) {
    const name = String(file || '').trim()
    if (!name) continue
    const full = path.isAbsolute(name) ? name : path.resolve(baseDir, name)
    if (!resolved.some((seen) => canonicalisePath(seen) === canonicalisePath(full))) {
      resolved.push(full)
    }
  }
  return resolved
}

/** Keyed by canonical path so two spellings of one file cannot pass as two files. */
export function contractFileHashes(paths: Iterable<string>): Record<string, string | null> {
  const hashes: Record<string, string | null> = {}
  for (const p of paths) hashes[canonicalisePath(p)] = sha256File(p)
  return hashes
}

/**
 * Anything that changed a declared file during a unit invalidates the verdict, whatever the tests
 * then reported. A missing declaration is reported too, because failing closed is the only safe
 * reading of "the architect declared a contract file that is not there".
 */
export function contractViolations(
  before: Record<string, string | null>,
  after: Record<string, string | null>
): string[] {
  const violations: string[] = []
  for (const [key, beforeHash] of Object.entries(before)) {
    const afterHash = Object.prototype.hasOwnProperty.call(after, key) ? after[key] : null
    if (beforeHash === null) {
      violations.push("'" + key + "' was declared as a contract file but does not exist")
    } else if (afterHash === null) {
      violations.push("'" + key + "' was deleted while the unit ran")
    } else if (afterHash !== beforeHash) {
      violations.push("'" + key + "' was modified while the unit ran")
    }
  }
  return violations
}

/**
 * The read guard's memory of what a delegated worker wrote, and its bound.
 *
 * It is exported because the guard and the plugin's startup both add to it: a module that owns the
 * registry cannot own the set as well without an accessor for each caller, and the set is the
 * registry's state, not the guard's.
 */
export const delegatedPaths = new Set<string>()
export const DELEGATED_PATH_LIMIT = 500

/**
 * What a unit's verification said about the content it wrote.
 *
 * `UNIT_UNVERIFIED` is the honest third answer: a delegated edit with no verification command is the
 * common case, and it is neither a pass nor a failure. Only `UNIT_PASSED` has had its content checked,
 * so every other value must be read as unsettled.
 */
export type DelegatedOutcome = 'UNIT_PASSED' | 'UNIT_FAILED' | 'UNIT_UNVERIFIED'

const DELEGATED_OUTCOMES = new Set<string>(['UNIT_PASSED', 'UNIT_FAILED', 'UNIT_UNVERIFIED'])

/** One delegated file as it is persisted: where it is, and what was written there. */
export interface DelegatedRecord {
  path: string
  sha256: string | null
  at: number
  /**
   * How the worker touched this file. `created` means it produced the whole thing and the architect has
   * never seen it, so reading it back is the thing rule 3 forbids. `patched` means it changed part of a
   * file the architect already had -- the architect must stay able to read that, or iterating on an
   * existing file becomes impossible the moment a patch to it has been delegated once.
   */
  mode: 'created' | 'patched'
  /**
   * The verdict of the delegation that last wrote this file, and when it was reached. Absent means no
   * verdict covers the content in the record: nothing has verified it yet, or the file was rewritten
   * since and the content the verdict described is gone.
   */
  outcome?: DelegatedOutcome
  succeeded?: boolean
  verdictAt?: number
}

export function resolveDelegatedRegistryPath(): string {
  return path.join(resolveDataDir(), 'delegated-registry.json')
}

/**
 * Parse a registry file. Anything unreadable, malformed, or entry-shaped-but-wrong yields no records
 * rather than an exception: a corrupt registry must never be able to stop the plugin loading.
 */
export function parseDelegatedRegistry(text: string): DelegatedRecord[] {
  if (typeof text !== 'string' || !text.trim()) return []

  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return []
  }

  const raw = parsed && Array.isArray(parsed.records) ? parsed.records : []
  const records: DelegatedRecord[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const entryPath = String(entry.path ?? '').trim()
    if (!entryPath) continue
    const record: DelegatedRecord = {
      path: entryPath,
      sha256: typeof entry.sha256 === 'string' && entry.sha256 ? entry.sha256 : null,
      at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
      // Records written before this field existed predate the distinction, and the conservative reading
      // of an old record is the one that protects more: treat it as created.
      mode: entry.mode === 'patched' ? 'patched' : 'created',
    }
    // An unrecognised verdict is dropped rather than carried: the absence of the field means "no verdict",
    // and a value this code cannot read must never be able to relax a guard by passing for a success.
    if (DELEGATED_OUTCOMES.has(String(entry.outcome))) {
      record.outcome = entry.outcome as DelegatedOutcome
      record.succeeded = entry.succeeded === true
      if (Number.isFinite(Number(entry.verdictAt))) record.verdictAt = Number(entry.verdictAt)
    }
    records.push(record)
  }
  return records
}

/**
 * Newest wins per path, and the oldest fall off the end once the limit is reached. The hash is not
 * used to relax anything — a delegated file stays protected however it later changes — it makes the
 * record answerable, and gives the prune below something to reason about.
 */
export function mergeDelegatedRecords(
  existing: DelegatedRecord[],
  incoming: DelegatedRecord[],
  limit: number = DELEGATED_PATH_LIMIT
): DelegatedRecord[] {
  // Dedup on the canonical form, so two spellings of one file cannot become two records, while the
  // record itself keeps the path as it was written.
  const byPath = new Map<string, DelegatedRecord>()
  for (const entry of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!entry || !entry.path) continue
    const key = canonicalisePath(entry.path)
    const prior = byPath.get(key)
    if (!prior || entry.at >= prior.at) byPath.set(key, entry)
  }
  return [...byPath.values()].sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit))
}

/** A path whose file is gone protects nothing, so it is dropped. */
export function pruneDelegatedRecords(
  records: DelegatedRecord[],
  exists: (p: string) => boolean = (p) => fs.existsSync(p)
): DelegatedRecord[] {
  return (records ?? []).filter((r) => r && r.path && exists(r.path))
}

/** Best effort by design: failing to persist must not fail a delegation that was already paid for. */
export function saveDelegatedRegistry(records: DelegatedRecord[]): boolean {
  const target = resolveDelegatedRegistryPath()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = target + '.tmp'
    fs.writeFileSync(temp, JSON.stringify({ version: 1, records }, null, 2), 'utf8')
    fs.renameSync(temp, target)
    return true
  } catch (err: any) {
    console.warn('[LOCAL_GUARD] could not persist the delegated registry:', err?.message || err)
    return false
  }
}

/** Load, validate and prune. Called at startup so a restart does not forget what was delegated. */
export function loadDelegatedRegistry(): DelegatedRecord[] {
  let text = ''
  try {
    text = fs.readFileSync(resolveDelegatedRegistryPath(), 'utf8')
  } catch (err) {
    return []
  }
  return pruneDelegatedRecords(parseDelegatedRegistry(text))
}

export function rememberDelegated(paths: string[], mode: 'created' | 'patched' = 'created'): void {
  const added: DelegatedRecord[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    // The record keeps the path as it was written, so it stays an honest answer to "where did this
    // go?". Canonicalisation resolves symlinks — `os.tmpdir()` on Windows is a junction — so it
    // belongs in the index and the comparisons, not in the record.
    const resolved = path.resolve(p)
    added.push({ path: resolved, sha256: sha256File(resolved), at: Date.now(), mode })
  }
  if (added.length === 0) return

  const merged = mergeDelegatedRecords(loadDelegatedRegistry(), added)
  saveDelegatedRegistry(merged)

  // Only whole files the worker produced enter the read guard's index. A patched file is one the
  // architect was working on and must keep reading; the record still remembers it either way.
  for (const entry of merged) {
    if (entry.mode === 'created') delegatedPaths.add(canonicalisePath(entry.path))
  }
  while (delegatedPaths.size > DELEGATED_PATH_LIMIT) {
    const oldest = delegatedPaths.values().next().value
    if (typeof oldest === 'string') delegatedPaths.delete(oldest)
  }
}

/**
 * Stamp a unit's verdict onto the registry records for the files that unit wrote.
 *
 * A delegation writes the registry before its verification has run, so the record it creates cannot
 * carry the verdict. This is the second half of that write, and the only thing that joins a per-file
 * sha256 to a per-unit verdict -- without it "is this file settled?" has no answer, and the read guard
 * has to ask about every delegated file for ever.
 *
 * Best effort, for the same reason the first half is: failing to persist must not fail a delegation that
 * was already paid for, and an absent stamp reads as "no verdict", which is the conservative answer
 * rather than a permissive one. Returns how many records were stamped, so a caller can tell a no-op
 * from a write.
 */
export function recordDelegatedOutcome(
  paths: string[],
  outcome: DelegatedOutcome,
  succeeded: boolean,
  at: number = Date.now()
): number {
  if (!Array.isArray(paths) || paths.length === 0) return 0
  if (!DELEGATED_OUTCOMES.has(String(outcome))) return 0

  // Canonical on both sides. The registry holds absolute paths, so unlike the read guard -- which has to
  // infer a workspace before a relative target means anything -- there is no base here to get wrong.
  const wanted = new Set<string>()
  for (const p of paths) {
    if (typeof p === 'string' && p) wanted.add(canonicalisePath(p))
  }
  if (wanted.size === 0) return 0

  const records = loadDelegatedRegistry()
  let stamped = 0
  for (const record of records) {
    if (!wanted.has(canonicalisePath(record.path))) continue
    record.outcome = outcome
    record.succeeded = succeeded === true
    record.verdictAt = at
    stamped += 1
  }
  if (stamped > 0) saveDelegatedRegistry(records)
  return stamped
}
