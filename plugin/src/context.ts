import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { evaluateEmissionPath } from './emission'

/** One file the architect wants the worker to see. Names and ranges only, never contents. */
export interface ContextRequest {
  path: string
  startLine?: number
  endLine?: number
}

/**
 * What the architect is told about an injection. Deliberately has no `content` field — the whole
 * point is that the code travels to the worker and does not travel back.
 */
export interface ContextInjection {
  path: string
  relativeName: string
  lineRange: { start: number; end: number } | null
  lines: number
  bytes: number
  sha256: string
}

export interface ContextResolution {
  injected: ContextInjection[]
  text: string
  errors: string[]
}

/**
 * Injected context competes with the instruction for the worker's input window, so the budget is a
 * safety bound rather than a caller preference. Over budget refuses; it never truncates quietly,
 * because a worker given half a file answers confidently about a file it only half saw.
 */
export const DEFAULT_CONTEXT_MAX_BYTES = 32768

/**
 * Read the files the architect named and render them for the worker's prompt. Containment matches
 * emission exactly: the same resolution, and the same refusal of escapes and absolute paths outside
 * the root, because reading a file in order to transmit it is an egress route and deserves the same
 * scepticism as writing one.
 */
export function resolveContextFiles(
  requests: ContextRequest[] | undefined,
  baseDir: string,
  allowedRoots: string[] = [],
  maxBytes: number = DEFAULT_CONTEXT_MAX_BYTES
): ContextResolution {
  const injected: ContextInjection[] = []
  const errors: string[] = []
  const sections: string[] = []
  let totalBytes = 0

  for (const request of requests ?? []) {
    const declared = String(request?.path || '').trim()
    if (!declared) {
      errors.push('a contextFiles entry had no path')
      continue
    }
    const resolvedPath = path.isAbsolute(declared) ? declared : path.resolve(baseDir, declared)

    const containment = evaluateEmissionPath(resolvedPath, baseDir, allowedRoots)
    if (!containment.allowed) {
      errors.push(`context file '${declared}' was refused: ${containment.reason}`)
      continue
    }

    let raw: string
    try {
      raw = fs.readFileSync(resolvedPath, 'utf8')
    } catch (err: any) {
      errors.push(`context file '${declared}' could not be read: ${err?.message || String(err)}`)
      continue
    }

    const allLines = raw.split('\n')
    let lineRange: { start: number; end: number } | null = null
    let body = raw

    if (request.startLine !== undefined || request.endLine !== undefined) {
      const start = Number(request.startLine ?? 1)
      const end = Number(request.endLine ?? allLines.length)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        errors.push(
          `context file '${declared}' had an invalid line range (${request.startLine}-${request.endLine})`
        )
        continue
      }
      if (start > allLines.length) {
        errors.push(
          `context file '${declared}' has ${allLines.length} line(s), so a range starting at ${start} does not exist`
        )
        continue
      }
      // An over-long end is clamped rather than refused, and the clamp is reported in the record.
      const clampedEnd = Math.min(end, allLines.length)
      lineRange = { start, end: clampedEnd }
      body = allLines.slice(start - 1, clampedEnd).join('\n')
    }

    const bytes = Buffer.byteLength(body, 'utf8')
    if (totalBytes + bytes > maxBytes) {
      errors.push(
        `context injection would exceed its ${maxBytes}-byte budget (${totalBytes + bytes} bytes declared). ` +
          `Narrow the line ranges or declare fewer files.`
      )
      continue
    }

    totalBytes += bytes
    const relativeName = path.relative(baseDir, resolvedPath) || declared
    injected.push({
      path: resolvedPath,
      relativeName,
      lineRange,
      lines: body.split('\n').length,
      bytes,
      sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    })
    sections.push(
      `--- ${relativeName}${lineRange ? ` (lines ${lineRange.start}-${lineRange.end})` : ''} ---\n${body}`
    )
  }

  // Any error refuses the whole injection, and the caller refuses the delegation. A partial view is
  // worse than none: the worker would be asked to edit a file it had only partly been shown.
  if (errors.length > 0) return { injected: [], text: '', errors }
  const text = sections.length > 0 ? `Declared Context:\n${sections.join('\n\n')}` : ''
  return { injected, text, errors }
}
