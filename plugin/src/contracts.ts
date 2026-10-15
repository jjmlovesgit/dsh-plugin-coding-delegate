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
 * The same files as `delegatedPaths`, carrying the record so the read guard can ask what happened to a
 * file rather than only whether it was delegated at all. `indexDelegated` is its only writer: two indexes
 * updated in two places drift, and a drifted index here reads as "no verdict", which is the permissive
 * answer to the question this index exists to answer.
 *
 * It arms itself on first use because the startup loop that fills `delegatedPaths` lives in `index.ts`,
 * which is too large for the worker to rewrite -- so there is no place there to arm a second index, and a
 * lazily armed one is the difference between correct and silently empty.
 */
const delegatedRecordIndex = new Map<string, DelegatedRecord>()
let indexArmed = false

/**
 * Refresh both indexes from a set of records. Only whole files the worker produced enter the read guard's
 * index -- a patched file is one the architect was already working on and must keep reading -- while the
 * registry itself remembers either kind.
 */
function indexDelegated(records: Iterable<DelegatedRecord>): void {
  indexArmed = true
  for (const entry of records) {
    if (entry.mode !== 'created') continue
    const key = canonicalisePath(entry.path)
    delegatedPaths.add(key)
    delegatedRecordIndex.set(key, entry)
  }
  while (delegatedPaths.size > DELEGATED_PATH_LIMIT) {
    const oldest = delegatedPaths.values().next().value
    if (typeof oldest !== 'string') break
    delegatedPaths.delete(oldest)
    delegatedRecordIndex.delete(oldest)
  }
}

/**
 * The record for a delegated file, by canonical path. `undefined` means no verdict covers it, and the
 * guard has to read that as unsettled rather than as a pass.
 */
export function lookupDelegatedRecord(canonicalPath: string): DelegatedRecord | undefined {
  if (!indexArmed) indexDelegated(loadDelegatedRegistry())
  return delegatedRecordIndex.get(canonicalPath)
}

/**
 * What a unit's verification said about the content it wrote.
 *
 * `UNIT_UNVERIFIED` is the honest third answer: a delegated edit whose contract was never checked is
 * neither a pass nor a failure. Only `UNIT_PASSED` has had its content checked, so every other value
 * must be read as unsettled.
 *
 * There are two routes to it, and a record does not say which was taken. The common one is that no
 * verification command was supplied at all. The other is that a command was supplied and the gate
 * stopped it -- typically approval was refused, and nothing ran. The first is an absence of evidence
 * and the second is a decision not to gather any, but both leave the content exactly as unestablished,
 * which is the only thing this field is for. Consumers must therefore word their explanations in terms
 * of the contract that went unchecked rather than of whether a command was written down.
 *
 * `UNIT_FLAKY` is the fourth answer, and it exists because the first three are unsafe for a
 * NON-DETERMINISTIC oracle. A property test or a concurrency harness can pass a broken implementation
 * on a run where the defect simply did not trigger, and `UNIT_PASSED` is what makes a file settled --
 * so the old three-state taxonomy could promote a race condition into the codebase and present it as
 * verified work. That is the most dangerous output this plugin can emit, and it is silent.
 *
 * A flaky verdict is a statement about the ORACLE, not about the code: the contract disagreed with
 * itself across repeated runs, so nothing has been established about the content either way. It is not
 * a pass, it does not settle the file, and the reason names the oracle rather than the implementation.
 *
 * `OPERATOR_ATTESTED` is the fifth answer, and it exists because the other four all describe a DELEGATION.
 * A module an engineer edited by hand has no delegation to judge it, and manufacturing one -- running a
 * synthetic worker purely to stamp a hash -- would replace human-reviewed engineering with simulated
 * machine origin in the audit trail. That is a worse record than no record.
 *
 * The two verdicts are epistemically different and this type keeps them apart on purpose:
 *
 *   UNIT_PASSED        a local model satisfied a MACHINE-CHECKED contract
 *   OPERATOR_ATTESTED  a HUMAN verified the artifact, and the evidence of that is recorded verbatim
 *
 * A consumer may treat both as promotable, and must not treat them as the same claim.
 */
export type DelegatedOutcome =
  | 'UNIT_PASSED'
  | 'UNIT_FAILED'
  | 'UNIT_UNVERIFIED'
  | 'UNIT_FLAKY'
  | 'OPERATOR_ATTESTED'

const DELEGATED_OUTCOMES = new Set<string>([
  'UNIT_PASSED',
  'UNIT_FAILED',
  'UNIT_UNVERIFIED',
  'UNIT_FLAKY',
  'OPERATOR_ATTESTED',
])

/** Who attested a hand-verified file, and what they said they checked. Auditable, not decorative. */
export interface OperatorAttestation {
  operator: string
  evidence: string
  at: number
}

/**
 * Every parameter `delegate_worker`'s tool schema may declare. The canonical list.
 *
 * WHY THIS EXISTS, and it is not tidiness. The schema is an inferred object literal, so before this there
 * was nothing coupling its parameter names to any type: adding a property compiled cleanly whether or not
 * the implementation had a matching argument, and adding an argument did not force the schema to expose it.
 * Both directions failed silently.
 *
 * The direction that actually bit: `attestTargets` was added to an inline copy of the parameters in
 * index.ts and not to the exported schema, so the host never received it, the delegated call was stripped
 * of both attesting parameters, and the tool reported success while the feature did nothing. That
 * duplication is gone -- index.ts now references the exported schema -- and this type is what stops the one
 * remaining literal from drifting from the implementation.
 *
 * `delegation.ts` asserts the schema's keys are exactly these, so a parameter that is not on this list
 * FAILS THE BUILD, rather than being visible to a model, accepted at call time, and discovered to do
 * nothing weeks later.
 */
export type DelegateWorkerParameter =
  | 'taskName'
  | 'instruction'
  | 'targetFiles'
  | 'runVerification'
  | 'verificationRepeats'
  | 'contractFiles'
  | 'contextFiles'
  | 'workspaceDir'

/**
 * `attestTargets`, `attestEvidence` and `attestOperator` were REMOVED from this union deliberately.
 *
 * They were declared as caller-settable parameters and `index.ts` honoured them by writing an
 * `OPERATOR_ATTESTED` record, which made a HUMAN-REVIEW CLAIM a model-settable value: a caller could name
 * a person, write the evidence text, and have the registry record that a human had reviewed the file. The
 * scope check that only this unit's own files could be attested narrowed the blast radius and never
 * addressed the claim, because the identity and the evidence were supplied by the same caller who
 * benefited from the record.
 *
 * Removing only the identity and the evidence would have left the TRIGGER. `attestTargets` plus an
 * `operatorIdentity` from plugin config plus the canned default evidence string produced the same
 * OPERATOR_ATTESTED record with no human involved, so all three go together.
 *
 * `OPERATOR_ATTESTED` remains a valid registry outcome and `guard.ts` still honours it, because the
 * registry is a file that an earlier version or a human tool may have written. What is gone is any
 * shipped path that PRODUCES one from a tool call. Note that `scripts/attest-unit.cjs --approve` is NOT
 * that path: it writes a signed git note, which is a different record entirely.
 *
 * The removal is compile-enforced, not merely deleted: `delegation.ts` declares
 * `DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER`, whose type requires the tool schema's keys and this
 * union to be the SAME set, so re-adding a parameter to one and not the other fails the build.
 */

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
  /**
   * Present only for `OPERATOR_ATTESTED`: who signed off on this content, what they say they checked, and
   * when. Carried so a reviewer can tell a machine-checked receipt from a human judgement without reading
   * the verdict name, because those are different claims and the difference is the point of the verdict.
   */
  attestation?: OperatorAttestation
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
    // The attestation survives the round trip, because an attestation without its operator and evidence is
    // not an audit record -- and this parser is where a field can be silently dropped, which is how a
    // written verdict becomes an absence. Both fields are required for it to be carried: a record claiming
    // OPERATOR_ATTESTED with nobody named is exactly the unattributable stamp this verdict exists to avoid.
    const attestation = entry.attestation
    if (attestation && typeof attestation === 'object') {
      const operator = String(attestation.operator ?? '').trim()
      const evidence = String(attestation.evidence ?? '').trim()
      if (operator && evidence) {
        record.attestation = {
          operator,
          evidence,
          at: Number.isFinite(Number(attestation.at)) ? Number(attestation.at) : 0,
        }
      } else {
        // An unattributable attestation is not carried, and the verdict goes with it: keeping the verdict
        // while dropping the attribution would leave a record that reads as human-verified with nobody
        // accountable for it.
        delete record.outcome
        delete record.succeeded
      }
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

/**
 * Best effort by design: failing to persist must not fail a delegation that was already paid for.
 *
 * THE TEMPORARY NAME IS UNIQUE PER WRITER. It used to be `target + '.tmp'`, which is the same string for
 * every process on the machine -- a shared file, not a scratch file. Two writers saving at the same moment
 * therefore wrote to one path, and the loser's rename either failed or put the winner's bytes in place
 * while the loser believed it had saved. The suffix removes the shared name entirely, so the rename is
 * the only step that touches the real file and it is atomic on both platforms.
 */
export function saveDelegatedRegistry(records: DelegatedRecord[]): boolean {
  const target = resolveDelegatedRegistryPath()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp =
      target + '.' + String(process.pid) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
    fs.writeFileSync(temp, JSON.stringify({ version: 1, records }, null, 2), 'utf8')
    renameWithRetry(temp, target)
    return true
  } catch (err: any) {
    console.warn('[LOCAL_GUARD] could not persist the delegated registry:', err?.message || err)
    return false
  }
}

/** A synchronous sleep, because every caller on this path is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Rename over an existing file, retrying the transient failures.
 *
 * On Windows a rename onto a file another process currently has open fails with EPERM, EBUSY or EACCES
 * and then succeeds moments later; POSIX has no such window. Retrying is the documented remedy, and
 * anything that is not one of those three codes is a real failure and is re-thrown rather than retried
 * into a timeout.
 */
function renameWithRetry(from: string, to: string, attempts = 12): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err: any) {
      const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES'
      if (!transient || attempt >= attempts) throw err
      sleepSync(5 * attempt)
    }
  }
}

/** How long a writer waits for the registry lock before giving up, and when a lock is treated as dead. */
const REGISTRY_LOCK_TIMEOUT_MS = 4000
const REGISTRY_LOCK_STALE_MS = 10000

/**
 * Take the registry lock, or throw when it cannot be taken within the budget.
 *
 * WHY A LOCK AND NOT ONLY THE ATOMIC RENAME. `saveDelegatedRegistry` alone cannot make the whole
 * operation safe, because every caller is a READ-MODIFY-WRITE: load the registry, change it in memory,
 * write the whole file back. Two writers that interleave their reads lose one update even when both
 * writes land intact -- the atomic rename guarantees the file is never half-written, not that it contains
 * both updates. MEASURED in the oracle suite, which runs many processes against one data directory: a
 * delegation registered by one file was intermittently absent from the registry the read guard consulted,
 * and the failing assertion named files that had just been delegated and were read back ungated. Two DSH
 * sessions on one host share this file exactly as two test processes do, so the loss is not a test
 * artifact.
 *
 * `wx` is O_CREAT|O_EXCL, which is atomic on both platforms, so the create is the mutual exclusion and no
 * separate check is needed. A holder that dies is handled by the staleness rule rather than by leaving the
 * registry unwritable for ever.
 */
function acquireRegistryLock(): string {
  const lockPath = resolveDelegatedRegistryPath() + '.lock'
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = fs.openSync(lockPath, 'wx')
      fs.writeSync(handle, String(process.pid))
      fs.closeSync(handle)
      return lockPath
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        // The holder released it between the open and the stat; the next attempt will take it.
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the delegated-registry lock at ' + lockPath)
      }
      sleepSync(5)
    }
  }
}

function releaseRegistryLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true })
  } catch {
    // A lock left behind is reclaimed by the staleness rule, so a failed release is not worth a warning
    // on a path that must not fail a delegation.
  }
}

/**
 * Run a read-modify-write of the registry under the lock, and run it anyway if the lock cannot be taken.
 *
 * THE UNLOCKED PATH IS THE OLD BEHAVIOUR, and it stays because the registry is best-effort by design: a
 * delegation that already succeeded must not be failed by a lock it could not acquire. The warning names
 * the risk rather than reporting a benign fallback, because that is what it is -- the update may be lost.
 */
function withRegistryLockOrWarn<T>(label: string, fn: () => T): T {
  let lockPath: string | null = null
  try {
    lockPath = acquireRegistryLock()
  } catch (err: any) {
    console.warn(
      '[LOCAL_GUARD] could not take the delegated-registry lock (' +
        label +
        '), so this update may be lost if another process writes at the same time:',
      err?.message || err
    )
    return fn()
  }
  try {
    return fn()
  } finally {
    releaseRegistryLock(lockPath)
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

  // THE READ IS INSIDE THE LOCK, which is the whole point: a merge is only correct against the registry
  // as it stands now, and reading first and locking afterwards is precisely the interleaving that loses
  // the other writer's update.
  withRegistryLockOrWarn('rememberDelegated', () => {
    const merged = mergeDelegatedRecords(loadDelegatedRegistry(), added)
    saveDelegatedRegistry(merged)
    indexDelegated(merged)
  })
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

  return withRegistryLockOrWarn('recordDelegatedOutcome', () => {
    const records = loadDelegatedRegistry()
    let stamped = 0
    for (const record of records) {
      if (!wanted.has(canonicalisePath(record.path))) continue
      record.outcome = outcome
      record.succeeded = succeeded === true
      record.verdictAt = at
      stamped += 1
    }
    if (stamped > 0) {
      saveDelegatedRegistry(records)
      // The index still holds these records as they were before the stamp, so it has to be refreshed or
      // the guard would keep reading "no verdict" for a file whose verdict has just been recorded.
      indexDelegated(records)
    }
    return stamped
  })
}

/**
 * Record that a HUMAN verified a file, with the evidence they gave.
 *
 * WHY THIS IS NOT `recordDelegatedOutcome`. That function stamps records that already exist, because a
 * verdict is always the second half of a delegation that wrote the file first. A hand-edited module has no
 * such record -- `guard.ts` in this repository is 786 lines of hand-written change with no delegation
 * behind it -- so an attestation has to CREATE a record rather than stamp one.
 *
 * It creates it with `mode: 'created'`, which is the honest description: the architect has never been
 * shown this content by a worker, and the read guard should treat reading it back the way it treats any
 * other file the context did not write. Claiming `patched` would assert a history that did not happen.
 *
 * The hash is read from disk HERE, not supplied by the caller, so an attestation always describes the
 * bytes that were present when it was made. A caller-supplied hash would let an attestation be recorded
 * for content that was never on disk, which is the one thing this verdict must not allow.
 *
 * Returns the record it wrote, or null when the file could not be read -- never a bare count, because the
 * caller needs the hash to show the operator what they just attested.
 */
export function recordOperatorAttestation(
  path: string,
  operator: string,
  evidence: string,
  at: number = Date.now()
): DelegatedRecord | null {
  const target = typeof path === 'string' ? path.trim() : ''
  const who = typeof operator === 'string' ? operator.trim() : ''
  const why = typeof evidence === 'string' ? evidence.trim() : ''
  // Attribution and evidence are both required. An attestation with neither is not a weaker attestation,
  // it is an anonymous stamp, and the registry is better off without one.
  if (!target || !who || !why) return null
  const hash = sha256File(target)
  if (!hash) return null

  const canonical = canonicalisePath(target)

  // Under the lock, like the other two: this creates or stamps a record against a registry it just read,
  // so an unlocked read-modify-write here can drop another writer's attestation. The persist result is
  // carried out of the lock rather than thrown from inside it, so the lock is released before the caller
  // unwinds.
  const record = withRegistryLockOrWarn('recordOperatorAttestation', () => {
    const records = loadDelegatedRegistry()
    const existing = records.find((r) => canonicalisePath(r.path) === canonical)
    const entry: DelegatedRecord = existing ?? { path: canonical, sha256: hash, at, mode: 'created' }
    entry.sha256 = hash
    entry.outcome = 'OPERATOR_ATTESTED'
    // Deliberately NOT `succeeded: true`. Success is a claim that a contract was met, and no contract ran
    // here. A consumer that wants to promote an attested file must check the verdict, not a boolean whose
    // meaning would otherwise quietly widen to include "a human looked at it".
    entry.succeeded = false
    entry.verdictAt = at
    entry.attestation = { operator: who, evidence: why, at }
    if (!existing) records.push(entry)
    if (!saveDelegatedRegistry(records)) return null
    indexDelegated(records)
    return entry
  })

  // A persist that did not happen must not be reported as one. `saveDelegatedRegistry` returns a boolean
  // rather than throwing so its other callers can decide, and the first version of this function ignored
  // that return -- so the very first attestation attempt printed a hash and an operator while the registry
  // was untouched, the write having failed with EPERM inside the persist path. That is the defect this
  // repository has now caught repeatedly: a green result over an operation that did not occur.
  //
  // Throwing is the right response here and not for `recordDelegatedOutcome`, because the two callers face
  // opposite risks. A delegation that fails to record a verdict leaves the file UNSETTLED, which is the
  // fail-closed direction -- an absent verdict reads as "nothing is proven". An attestation that fails to
  // record leaves the operator believing a human-verified claim is on file when nothing is, and the whole
  // point of the verdict is that somebody can be named for it.
  if (!record) {
    throw new Error(
      'Could not persist the operator attestation for ' +
        canonical +
        '. The registry at ' +
        resolveDelegatedRegistryPath() +
        ' was not written, so nothing was attested.'
    )
  }
  return record
}
