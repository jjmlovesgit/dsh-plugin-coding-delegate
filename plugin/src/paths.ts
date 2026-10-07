import * as fs from 'fs'
import * as path from 'path'

/**
 * Resolve `p` to a canonical path, following symlinks for the part of it that exists.
 * A destination that does not exist yet has no realpath of its own, so the deepest
 * existing ancestor is resolved and the remaining segments are re-appended.
 */
export function canonicalisePath(p: string): string {
  let current = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    if (fs.existsSync(current)) break
    const parent = path.dirname(current)
    if (parent === current) break
    tail.unshift(path.basename(current))
    current = parent
  }
  try {
    current = fs.realpathSync(current)
  } catch {
    // An unresolvable ancestor is not a reason to trust the path; keep it as written.
  }
  return tail.length > 0 ? path.join(current, ...tail) : current
}

/** True when `candidate` is `root` itself or lives beneath it. Case-insensitive on Windows. */
export function isPathWithin(root: string, candidate: string): boolean {
  const flatten = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const from = flatten(path.resolve(root))
  const to = flatten(path.resolve(candidate))
  if (from === to) return true
  const rel = path.relative(from, to)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/** Extensions treated as source code: writes must come from the local worker. */
export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.fs', '.vb',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.php', '.scala', '.lua', '.dart',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.sql',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
])
