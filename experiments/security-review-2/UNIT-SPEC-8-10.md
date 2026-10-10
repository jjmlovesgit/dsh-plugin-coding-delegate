# Unit spec: finding 8/10 — declarations mode leaks source by other routes

Oracle: `plugin/tests/oracles/declaration-egress-scope.test.cjs`
Implementation: `plugin/src/declaration-egress.ts` (new), wired in `plugin/src/index.ts`

## The defect, stated against the code

`sourceReadEgress: 'declarations'` is implemented as a single `tools/post-execute` listener that begins:

    if (!READ_TOOLS.has(name)) return decision        // index.ts:1407

Everything after that line is unreachable for a search or a shell command, so under declarations mode a
`grep`, `rg`, `Select-String` or shell `Get-Content` returns raw implementation bodies to the architect.

Three separate holes, and they need different treatment:

1. **Search and shell bypass the filter entirely.** `SEARCH_TOOLS` and `SHELL_TOOLS` are not
   `READ_TOOLS`, so they return before line 1411 is ever evaluated.
2. **Consumable extensions outside the TypeScript set are served raw.** `declarationPathFor`
   (`guard.ts:571-588`) returns `null` for any extension outside `.ts/.tsx/.js/.jsx`, and the caller reads
   `null` as *"Not a source file: nothing to strip, so the read stands"* (`index.ts:1412-1413`). So a
   `.py`, `.go`, `.rs`, `.sh` or `.sql` body is served in full.
3. **The two extension sets disagree.** `declarationPathFor` recognises four extensions;
   `CODE_EXTENSIONS` (`paths.ts:38`) recognises about thirty. The gap between them is exactly hole 2.

Note what is **not** broken, because the fix must not regress it: for a `.ts` file with no emitted
declaration the control already fails closed with an explicit refusal (`index.ts:1449-1471`), and a stale
declaration is refused too.

## The decision to extract

A new module `plugin/src/declaration-egress.ts` exporting one pure function:

    export function evaluateDeclarationEgress(input: {
      toolKind: 'read' | 'search' | 'shell' | 'other'
      /** For read/search: the path argument. For shell: the command text. */
      target: string
      sourceReadEgress?: 'source' | 'declarations'
      declarationRoot?: string
      /** Injected so this module does not depend on guard.ts internals. */
      isCodeExtension: (p: string) => boolean
      declarationPathFor: (sourcePath: string, declarationRoot: string) => string | null
      /** Injected: does this shell command read file CONTENT? Reuse guard.ts's commandReadsContent. */
      commandReadsContent?: (command: string) => boolean
      /** Injected: does this shell command name a source-extension path? Reuse guard.ts's helper. */
      commandNamesSource?: (command: string) => boolean
    }): { action: 'allow' } | { action: 'serve-declaration'; skeleton: string } | { action: 'block'; reason: string }

Requirements:

- **`'source'` mode is a no-op.** When `sourceReadEgress` is not `'declarations'`, return `allow`
  immediately. This control must not change behaviour for anyone who has not opted in.
- **`'other'` tool kinds always allow.** A tool that neither reads, searches nor shells is not an egress
  route.
- **Reads:** if the target is a declaration file already (`.d.ts`), allow it — a skeleton is the thing this
  mode exists to serve. If `declarationPathFor` returns a path, return `serve-declaration` with it. If the
  target is not a code extension, allow it. If it **is** a code extension but `declarationPathFor` returns
  null, that is hole 2: **block** with a reason naming the extension and saying no skeleton can be
  produced for it.
- **Search:** a search returns matching lines, not a whole file, so there is nothing to substitute — the
  matched bytes are implementation bodies wherever they land. If the stated scope names a consumable
  source path, **block** and say why. If no scope is stated the search's reach is unknown, so it must
  **block** as well, unless a future change gives this function a workspace to judge against. A search
  whose stated scope is not a code extension is allowed.
- **Shell:** if the command reads file content and names a source path, **block**. A command that does not
  read content (a listing, a test path) is allowed, because there are no bytes to leak. Reuse the injected
  helpers rather than re-deriving them: `commandReadsContent` for the first and `commandNamesSource` for
  the second. If either injected helper is absent, **block** — an egress filter that cannot evaluate must
  not wave the read through, which is the rule `index.ts:1496` already states.
- **Every block carries a reason.** The reason must name what was refused and point at the remedy (read the
  declaration path directly, or turn the setting off in the profile patch).

## Why it is pure and injectable

`declarationPathFor` and `commandReadsContent` live in `guard.ts`, and `SHELL_TOOLS` is module-private
there (`guard.ts:17`). Taking them as injected parameters keeps this module free of a `guard.ts` import
cycle and lets the oracle drive every branch without a host, which is how `attestation.ts` and
`containment.ts` are already shaped. Callers pass the real implementations.

## Hard constraints

- **No backtick character anywhere in the emitted file.** The plugin's emission scanner truncates a fenced
  body at the first backtick run, so a file containing one is refused. Use ordinary quoted strings and
  `String.fromCharCode(96)` if a backtick is genuinely needed in a test value.
- Do not modify any existing file. This unit adds the new module and the oracle only; wiring into
  `index.ts` is a separate unit.
- Exercise the plugin's real exports from `dist/`. Never reimplement `declarationPathFor` in the oracle —
  pass the real one in.

## The oracle

`plugin/tests/oracles/declaration-egress-scope.test.cjs`, importing the new module from `dist/` and the
real `declarationPathFor` and `commandReadsContent` from `dist/guard.js`. Suggested cases:

| # | case | expected |
| --- | --- | --- |
| 1 | `'source'` mode, a `.ts` read | `allow` |
| 2 | declarations mode, a `.ts` read with a declaration | `serve-declaration` |
| 3 | declarations mode, a `.d.ts` read | `allow` |
| 4 | declarations mode, a `.py` read | `block`, reason names the extension |
| 5 | declarations mode, a `.go` read | `block` |
| 6 | declarations mode, a `.md` read | `allow` |
| 7 | declarations mode, a search scoped to a `.ts` file | `block` |
| 8 | declarations mode, a scope-free search | `block` |
| 9 | declarations mode, a search scoped to a `.md` file | `allow` |
| 10 | declarations mode, a shell command that reads a `.ts` file | `block` |
| 11 | declarations mode, a shell listing command over a source dir | `allow` |
| 12 | declarations mode, shell with the content helper absent | `block` |
| 13 | `'other'` tool kind | `allow` |
| 14 | every block returns a non-empty reason | structure |

Cases 1, 3, 6, 11 and 13 are **green on delivery** and are controls: they exist so the fix cannot pass by
blocking everything. Cases 2, 4, 5, 7, 8, 10 and 12 are **red on delivery** because the module does not
exist yet. A run in which every case passes means the controls were dropped, which is a failure of the
unit, not a success.

## Acceptance

    cd plugin && node --test tests/oracles/declaration-egress-scope.test.cjs

Report the observed pass/fail per case. The red cases flip green only when the module is implemented, in a
separate unit.

## Out of scope

- **Wiring into `index.ts`.** Required to actually close finding 8/10 in production, and deliberately a
  separate unit so the pure logic is verified before it can gate anything.
- **Findings 13/15**, which need a host seam this plugin does not have.
- **Whether blocking a `.py` read is a behaviour regression for polyglot repositories.** It is, and it is
  intended: declarations mode cannot produce a skeleton for Python, so under this setting the honest
  choices are refuse or leak. The reason string must say so, and the operator may turn the setting off.
