import * as fs from 'fs'
import * as path from 'path'
import { SavingsTracker } from './savings-tracker'
import { PROFILES } from './profiles'
import { resolveDataDir } from './logging'
import { extractAndEmitFiles } from './emission'
import { ContextRequest, resolveContextFiles } from './context'
import {
  DEFAULT_VERIFICATION_POLICY,
  TestResults,
  VerificationPolicy,
  evaluateVerificationPolicy,
  runSandboxVerification,
} from './verification'
import {
  contractFileHashes,
  contractViolations,
  rememberDelegated,
  resolveContractFiles,
} from './contracts'

export const DELEGATE_WORKER_OPENAI_SCHEMA = {
  type: 'function',
  function: {
    name: 'delegate_worker',
    description:
      'Dispatches a discrete implementation, testing, or code-generation task to the configured local execution worker -- any OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp) -- with an isolated context window. The worker has no repository read: declare contextFiles for the code it must see, since it cannot discover anything itself.',
    parameters: {
      type: 'object',
      properties: {
        taskName: {
          type: 'string',
          description: 'A short descriptive identifier for the subtask',
        },
        instruction: {
          type: 'string',
          description: 'The complete technical prompt and specifications for the local worker',
        },
        targetFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to target or modify',
        },
        runVerification: {
          type: 'string',
          description:
            'Optional shell command to verify the output. It executes with the authority of the DSH process and requires operator approval unless verificationApproval is set to allow.',
        },
        contractFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Paths to the tests that constitute this unit contract. They are hashed before the worker runs, the worker is forbidden to write them, and they are re-hashed afterwards: any change voids the verdict. The architect owns these files.',
        },
        contextFiles: {
          type: 'array',
          description:
            'Existing files the worker needs to see, as { path, startLine?, endLine? }. The plugin reads them into the worker prompt; you receive a record of what was injected and never the contents. Paths outside the workspace are refused, and context carrying a credential is refused rather than transmitted.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
            },
            required: ['path'],
          },
        },
        workspaceDir: {
          type: 'string',
          description:
            'Absolute path of the directory the worker may write into. Defaults to the session workspace; destinations outside it are refused.',
        },
      },
      required: ['taskName', 'instruction'],
    },
  },
}

export const DELEGATE_WORKER_SCHEMA = DELEGATE_WORKER_OPENAI_SCHEMA

export interface DelegateWorkerParams {
  instruction?: string
  taskPrompt?: string
  prompt?: string
  taskName?: string
  targetFiles?: string[] | string
  fileContext?: string
  systemPrompt?: string
  runVerification?: string
  endpoint?: string
  model?: string
  turnId?: number
  timeoutMs?: number
  workspaceDir?: string
  workspaceSource?: string
  /**
   * Paths to the tests that constitute this unit's contract. They are hashed before the worker
   * runs, refused as worker emission targets, and re-hashed afterwards: any change voids the
   * verdict. The architect owns these files and the executor never may, which is what stops a
   * unit from certifying itself.
   */
  contractFiles?: string[]
  /**
   * Existing files the worker needs to see, named by path with optional 1-based line ranges. The
   * plugin reads them and puts them in the worker's prompt; the architect never receives contents,
   * only a record of what was injected. This is the transport that lets a unit close on existing
   * code without the code entering the architect's context.
   */
  contextFiles?: ContextRequest[]
  /** Set false to return raw verification output. Raw output can carry source. */
  redactVerification?: boolean
  /** Policy for the model-supplied `runVerification` command. */
  verificationPolicy?: VerificationPolicy
  /**
   * Approval callback used when the policy resolves to `ask`. Absent means no approver is
   * reachable, which refuses the command rather than running it unattended.
   */
  verificationApproval?: (command: string) => Promise<boolean>
  /** Extra roots the worker may write into beyond `workspaceDir`. */
  emitAllowlist?: string[]
}

/** Where the local worker is assumed to live when nothing else is configured. */
export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:1234/v1'

/**
 * Accept either a base URL or a full chat-completions URL and return the full one, so
 * `localEndpoint: 'http://127.0.0.1:11434/v1'` (Ollama, vLLM, llama.cpp, …) works exactly as
 * written without the operator having to know this plugin appends the path.
 */
export function resolveChatCompletionsUrl(base: string): string {
  const trimmed = String(base || '').trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_LOCAL_ENDPOINT + '/chat/completions'
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : trimmed + '/chat/completions'
}

/** A delta block: the bytes to find, and what to put there instead. */
export interface SearchReplaceBlock {
  search: string
  replace: string
}

export interface PatchResult {
  ok: boolean
  content?: string
  reason?: string
}

/**
 * A one- or two-character search is unique by accident rather than by intent, so it is refused even
 * when the exactly-once rule would allow it. The property that matters is exactness, not cleverness.
 */
export const MIN_SEARCH_CHARS = 8

const SEARCH_MARKER = '<<<<<<< SEARCH'
const REPLACE_MARKER = '>>>>>>> REPLACE'
const DIVIDER_MARKER = '======='

/**
 * Recognise a search/replace body. The fenced header is shared with whole-file emission, so the body
 * decides the mode and the worker does not have to know which of the two it is producing.
 *
 * Returns null when there is no delta here, which tells the caller to treat the body as a whole file.
 * A body that *starts* a search/replace block but never finishes it returns an empty list instead --
 * never null -- so a malformed patch cannot fall through and be written over a real file.
 */
export function parseSearchReplaceBlocks(body: string): SearchReplaceBlock[] | null {
  if (typeof body !== 'string' || !body.includes(SEARCH_MARKER)) return null

  const blocks: SearchReplaceBlock[] = []
  let search: string[] | null = null
  let replace: string[] | null = null
  let state: 'idle' | 'search' | 'replace' = 'idle'

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === SEARCH_MARKER) {
      search = []
      replace = []
      state = 'search'
      continue
    }
    if (state === 'search' && trimmed === DIVIDER_MARKER) {
      state = 'replace'
      continue
    }
    if (trimmed === REPLACE_MARKER) {
      if (search && replace) blocks.push({ search: search.join('\n'), replace: replace.join('\n') })
      search = null
      replace = null
      state = 'idle'
      continue
    }
    if (state === 'search' && search) search.push(line)
    else if (state === 'replace' && replace) replace.push(line)
  }

  return blocks
}

/**
 * Apply every block, or none. A partially applied change is worse than no change: it leaves the tree
 * in a state that no contract was written against.
 *
 * Everything is normalised to LF for matching and the file's own ending is restored at the end.
 * Nothing else is normalised -- indentation is bytes -- because a near miss must fail loudly rather
 * than be massaged into a match. Fuzzy patching is not a tuning choice here; it is the mechanism by
 * which a wrong edit lands silently.
 */
export function applySearchReplaceBlocks(content: string, blocks: SearchReplaceBlock[]): PatchResult {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, reason: 'the patch contained no complete search/replace block' }
  }

  const usesCrlf = content.includes('\r\n')
  let work = content.split('\r\n').join('\n')

  for (const block of blocks) {
    const search = String(block?.search ?? '').split('\r\n').join('\n')
    const replace = String(block?.replace ?? '').split('\r\n').join('\n')

    if (!search.trim()) {
      return { ok: false, reason: 'a search block was empty' }
    }
    if (search.trim().length < MIN_SEARCH_CHARS) {
      return {
        ok: false,
        reason:
          'a search block was too short to be unambiguous (' +
          search.trim().length +
          ' characters, minimum ' +
          MIN_SEARCH_CHARS +
          ')',
      }
    }

    const occurrences = work.split(search).length - 1
    if (occurrences === 0) {
      return {
        ok: false,
        reason: 'no exact match for a search block (' + search.trim().slice(0, 60) + ')',
      }
    }
    if (occurrences > 1) {
      return {
        ok: false,
        reason:
          'a search block matched more than once (' +
          occurrences +
          ' times), so the edit is ambiguous',
      }
    }
    work = work.replace(search, () => replace)
  }

  return { ok: true, content: usesCrlf ? work.split('\n').join('\r\n') : work }
}

/**
 * Status precedence, as a pure function so the ordering is testable without a server. Tampering
 * outranks everything: a modified contract voids the run even when verification passed, because
 * what passed was no longer the contract.
 */
export function resolveDelegateStatus(input: {
  verificationGate?: string | null
  unverified: boolean
  contractViolations: string[]
  isSuccess: boolean
}): string {
  if (input.contractViolations.length > 0) return 'CONTRACT_MODIFIED'
  if (input.verificationGate) return 'VERIFICATION_NOT_APPROVED'
  if (input.unverified) return 'UNVERIFIED'
  return input.isSuccess ? 'SUCCESS' : 'VERIFICATION_FAILED'
}

// DELEGATION-CONTINUE-4
