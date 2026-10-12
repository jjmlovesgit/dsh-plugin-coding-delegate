import { describe, expect, it } from 'vitest'
import { buildNotesCommand, validateNotesRef } from '../src/attestation-notes'

/**
 * The command builder, tested on its own.
 *
 * These arguments are assembled from operator configuration and handed to `execFileSync` WITHOUT a
 * shell, so shell injection is not the risk. The risk is a malformed ref or object name being a
 * request to write somewhere unintended, and that is what the rejections below are for. Every one of
 * them returns a reason instead of a command, so the caller reports rather than guesses.
 */

const COMMIT = '166ff33dfb601b0a60cc40c798c42b9c986285dc'
const REF = 'refs/notes/delegations'

function argsFor(overrides: Partial<Parameters<typeof buildNotesCommand>[0]> = {}) {
  const result = buildNotesCommand({ commit: COMMIT, notesRef: REF, body: '{"a":1}', ...overrides })
  if (!result.ok) throw new Error('expected a command, got: ' + result.reason)
  return result.args
}

describe('buildNotesCommand: the command it produces', () => {
  it('produces the documented argument vector, with the record as one argv element', () => {
    expect(argsFor()).toEqual(['notes', '--ref=' + REF, 'add', '-f', '-m', '{"a":1}', COMMIT])
  })

  it('passes the body as a single argument, so no character in it is re-interpreted', () => {
    // Quotes, backticks, a semicolon and a newline: all inert, because there is no shell and the
    // record arrives as one element rather than being spliced into a command line.
    const body = '{"x":"a; rm -rf / `whoami` $(id) \\"q\\"","y":"line1\\nline2"}'
    const args = argsFor({ body })
    expect(args[args.length - 2]).toBe(body)
    expect(args).toHaveLength(7)
  })

  it('puts the commit last, so a body beginning with a dash is not read as an option', () => {
    const args = argsFor({ body: '--force' })
    expect(args[args.length - 1]).toBe(COMMIT)
    expect(args[args.length - 2]).toBe('--force')
  })

  it('overwrites rather than appending, which is why this is not called append-only', () => {
    expect(argsFor()).toContain('-f')
  })
})

describe('buildNotesCommand: object names it refuses', () => {
  const bad = [
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['HEAD', 'a symbolic name rather than an object id'],
    ['166ff33', 'abbreviated'],
    ['166ff33dfb601b0a60cc40c798c42b9c986285d', '39 hex characters'],
    ['166ff33DFB601B0A60CC40C798C42B9C986285DC', 'uppercase hex'],
    ['zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'not hex'],
    ['166ff33dfb601b0a60cc40c798c42b9c986285dc; rm -rf /', 'a trailing command'],
    ['--help', 'an option'],
  ]

  for (const [commit, why] of bad) {
    it(`refuses ${JSON.stringify(commit)} (${why})`, () => {
      const result = buildNotesCommand({ commit, notesRef: REF, body: 'x' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toMatch(/not a full git object name/i)
    })
  }

  it('accepts a 64-hex SHA-256 object name as well as a 40-hex SHA-1 one', () => {
    const sha256 = 'a'.repeat(64)
    const result = buildNotesCommand({ commit: sha256, notesRef: REF, body: 'x' })
    expect(result.ok).toBe(true)
  })
})

describe('validateNotesRef: refs it refuses', () => {
  it('accepts a full path under refs/notes/', () => {
    expect(validateNotesRef(REF)).toEqual({ ok: true, value: REF })
    expect(validateNotesRef('refs/notes/team/delegations')).toEqual({
      ok: true,
      value: 'refs/notes/team/delegations',
    })
  })

  const bad = [
    ['delegations', 'a shorthand, which resolves against repository configuration'],
    ['notes/delegations', 'missing the refs/ prefix'],
    ['refs/heads/main', 'not a notes ref'],
    ['refs/notes/', 'names no ref'],
    ['refs/notes', 'names no ref below the prefix'],
    ['refs/notes/../heads/main', 'traversal'],
    ['refs/notes/a..b', 'a double dot'],
    ['refs/notes/a b', 'whitespace'],
    ['refs/notes/a\tb', 'a tab'],
    ['refs/notes/a~1', 'a tilde'],
    ['refs/notes/a^', 'a caret'],
    ['refs/notes/a:b', 'a colon'],
    ['refs/notes/a?b', 'a question mark'],
    ['refs/notes/a*b', 'a glob'],
    ['refs/notes/a[b', 'a bracket'],
    ['refs/notes/a\\b', 'a backslash'],
    ['refs/notes/a@{1}', 'an at-brace'],
    ['refs/notes/a//b', 'an empty component'],
    ['refs/notes/a/', 'a trailing slash'],
    ['refs/notes/a.', 'a trailing dot'],
    ['refs/notes/a.lock', 'a lock suffix'],
    ['refs/notes/.hidden', 'a component starting with a dot'],
    ['--ref=refs/notes/x', 'an option that merely looks like a ref'],
  ]

  for (const [ref, why] of bad) {
    it(`refuses ${JSON.stringify(ref)} (${why})`, () => {
      const result = validateNotesRef(ref)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason.length).toBeGreaterThan(10)
    })
  }

  it('refuses an empty or missing ref rather than defaulting to one', () => {
    for (const ref of ['', '   ']) {
      expect(validateNotesRef(ref).ok).toBe(false)
    }
  })
})

describe('buildNotesCommand: bodies it refuses', () => {
  it('refuses an empty or whitespace-only record', () => {
    for (const body of ['', '   ', '\n']) {
      const result = buildNotesCommand({ commit: COMMIT, notesRef: REF, body })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toMatch(/empty/i)
    }
  })

  it('refuses a non-string body rather than storing a coercion of it', () => {
    const result = buildNotesCommand({
      commit: COMMIT,
      notesRef: REF,
      body: undefined as unknown as string,
    })
    expect(result.ok).toBe(false)
  })
})
