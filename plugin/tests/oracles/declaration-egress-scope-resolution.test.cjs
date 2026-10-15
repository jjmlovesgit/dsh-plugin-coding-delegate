// Oracle: a search scope is resolved against the SESSION WORKSPACE, not against the process cwd, and an
// unresolvable path-shaped scope is refused rather than waved through.
//
// WHY THIS FILE EXISTS AS ITS OWN ORACLE. The directory-scope fix in `declaration-egress-directory-scope`
// proves that a directory scope is resolved into declarations. It passes while the host happens to be
// launched from the workspace, because then a relative scope resolves by accident. MEASURED with the cwd
// moved elsewhere: `statSync('src')` throws ENOENT, the directory test answers false, and the evaluator
// returned `{"action":"allow"}` for a directory full of implementation -- the original leak, back again,
// with the suite green. A control whose answer depends on the launching directory is not a control, and
// only a test that moves the cwd can tell the two apart.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..');
const { evaluateDeclarationEgress, resolveScopePath } = require(PLUGIN + '/dist/declaration-egress.js');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scope-res-'));
const WS = path.join(BASE, 'workspace');
fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
fs.mkdirSync(path.join(WS, 'prose'), { recursive: true });
fs.writeFileSync(path.join(WS, 'src', 'impl.ts'), 'export function f(): number {\n  return 1;\n}\n');
fs.writeFileSync(path.join(WS, 'src', 'impl.d.ts'), 'export declare function f(): number;\n');
fs.writeFileSync(path.join(WS, 'README.md'), '# a non-source file\n');

const ORIGINAL_CWD = process.cwd();
// A directory that is NOT the workspace and does not contain `src`, which is the whole point.
process.chdir(os.tmpdir());
after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(BASE, { recursive: true, force: true });
});

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile() && ['.ts', '.js'].includes(path.extname(full).toLowerCase())) found.push(full);
  }
  return found;
}

/** The same wiring index.ts supplies, so the oracle exercises the shipped decision and not a mock of it. */
const wire = (extra) =>
  Object.assign(
    {
      toolKind: 'search',
      sourceReadEgress: 'declarations',
      declarationRoot: WS,
      workspaceRoot: WS,
      // WS is a workspace this oracle named AND created, so it is a verified base -- the same thing
      // index.ts passes when the host named a workspace. An unverified base is the process-cwd fallback,
      // which is a separate case at the end of this file because it is the one that must fail closed.
      workspaceVerified: true,
      isCodeExtension: (p) => ['.ts', '.js'].includes(path.extname(String(p)).toLowerCase()),
      declarationPathFor: (src) => String(src).replace(/\.ts$/, '.d.ts'),
      // The hook resolves the STATED scope against the workspace with this same exported resolver, so the
      // oracle does too. That is the contract: the evaluator hands the callbacks the scope as stated.
      directoryScope: (p) => {
        try {
          return fs.statSync(resolveScopePath(p, WS) || p).isDirectory();
        } catch {
          return false;
        }
      },
      pathExists: (p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      },
      listSourceFiles: (scope) => {
        try {
          return walk(resolveScopePath(scope, WS) || scope);
        } catch {
          return [];
        }
      },
      readDeclaration: (src) => {
        try {
          return { exists: true, text: fs.readFileSync(String(src).replace(/\.ts$/, '.d.ts'), 'utf8') };
        } catch {
          return { exists: false };
        }
      },
    },
    extra || {}
  );

test('cwd independence: a workspace-relative directory scope is served as declarations from ANY cwd', () => {
  assert.notEqual(process.cwd(), WS, 'the test is only meaningful from a cwd that is not the workspace');
  const verdict = evaluateDeclarationEgress(wire({ target: 'src' }));
  assert.equal(
    verdict.action,
    'serve-declaration',
    'src names a directory of implementation and must be served as declarations whatever the cwd is'
  );
  assert.match(String(verdict.declarationText), /declare function f/);
});

test('cwd independence: the same scope as a FILE is still refused from any cwd', () => {
  const verdict = evaluateDeclarationEgress(wire({ target: 'src/impl.ts' }));
  assert.equal(verdict.action, 'block');
});

test('a path-shaped scope that does not resolve is refused, not allowed', () => {
  // `src/missing/deep` has no code extension, so it is the case that reaches the resolution rule under
  // test. The other two are code-shaped and are refused earlier by the extension rule -- kept here
  // because a scope must not become clearable by being unfindable under either rule.
  for (const target of ['src/missing/deep', 'src/nope.ts', 'nope.js']) {
    const verdict = evaluateDeclarationEgress(wire({ target }));
    assert.equal(verdict.action, 'block', target + ' must be refused');
  }
});

test('a directory holding its own declaration file is served, not refused', () => {
  // MEASURED DEFECT: the walk returned `impl.d.ts` as source, no skeleton can exist for a declaration
  // file (the mapping produced `impl.d.d.ts`), and the whole scope was refused. A directory of ordinary
  // TypeScript containing one hand-written `.d.ts` is not unusual, and the mode blocked all of it.
  const verdict = evaluateDeclarationEgress(wire({ target: 'src' }));
  assert.equal(verdict.action, 'serve-declaration', String(verdict.reason));
  assert.match(String(verdict.declarationText), /declare function f/);
  assert.doesNotMatch(String(verdict.declarationText), /impl\.d\.d\.ts/);
});

test('controls: prose, an existing non-source file, and an empty directory all still stand', () => {
  // Without these, a rule that refused everything would pass the tests above. `README.md` is a REAL file
  // in the workspace: an unresolvable path-shaped scope is now refused, so a control that named a path
  // which does not exist would be asserting the old allow-by-default rather than the property it means.
  assert.equal(evaluateDeclarationEgress(wire({ target: 'payment retry logic' })).action, 'allow');
  assert.equal(evaluateDeclarationEgress(wire({ target: 'README.md' })).action, 'allow');
  assert.equal(evaluateDeclarationEgress(wire({ target: 'prose' })).action, 'allow');
});

test('without a workspace, no scope is refused for being unresolvable', () => {
  // The weaker answer is kept for a caller that names no workspace, because without one "could not
  // resolve" has no base to be measured against. Chosen with NO code extension so the extension rule
  // cannot fire first: this isolates the resolution rule.
  const verdict = evaluateDeclarationEgress(wire({ target: 'src/missing/deep', workspaceRoot: undefined }));
  assert.equal(verdict.action, 'allow');
});

test('resolveScopePath resolves relative scopes against the workspace and leaves absolutes alone', () => {
  assert.equal(resolveScopePath('src', WS), path.resolve(WS, 'src'));
  assert.equal(resolveScopePath('src/deep/thing.ts', WS), path.resolve(WS, 'src', 'deep', 'thing.ts'));
  assert.equal(resolveScopePath(path.join(WS, 'src'), WS), path.normalize(path.join(WS, 'src')));
  assert.equal(resolveScopePath('   ', WS), '');
});

test('an UNVERIFIED workspace base refuses a scope it cannot resolve, instead of reading it as prose', () => {
  // MEASURED (SECURITY-REVIEW-4 [2]): with the base set to the process cwd -- what resolveWorkspaceDir
  // returns when the host names no workspace, which is the ordinary case on a host that sets no workspace
  // environment variable and exposes no workspace service -- `grep { path: 'src' }` reached the prose
  // allow, because the cwd had no `src` while the session's own search root did. The scope was never
  // unresolvable; it was resolved against a directory nobody chose, and the raw matches then passed.
  const os = require('node:os')
  const hook = require(path.join(__dirname, '..', '..', 'dist', 'declaration-egress-hook.js'))
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unverified-'))
  try {
    const unverified = hook.handleDeclarationPostExecute(
      { name: 'grep', arguments: { path: 'src' } },
      { sourceReadEgress: 'declarations', declarationRoot: WS, workspaceRoot: other, workspaceVerified: false }
    )
    assert.ok(unverified, 'an unverified base must not clear a directory scope the search could reach')
    assert.equal(unverified.kind, 'accept')
    assert.match(unverified.content[0].text, /could not be established/)

    // CONTROL: the same scope under the real workspace is served, not refused. The fix must refuse the
    // GUESS, not the scope -- otherwise it is a ban on searching rather than a rule about provenance.
    const verified = hook.handleDeclarationPostExecute(
      { name: 'grep', arguments: { path: 'src' } },
      { sourceReadEgress: 'declarations', declarationRoot: WS, workspaceRoot: WS, workspaceVerified: true }
    )
    assert.doesNotMatch(
      JSON.stringify(verified || null),
      /could not be established/,
      'the true workspace must still resolve the scope'
    )
  } finally {
    fs.rmSync(other, { recursive: true, force: true })
  }
});

test('a directory-scoped shell read is refused, and a listing is not (finding 7)', () => {
  // MEASURED: commandReadsContent('rg SECRET src') is true but the command names no code FILE, so the
  // reads && names rule never fired and the raw results passed -- while the dedicated search route served
  // the same directory as declarations. This drives the SHIPPED predicate through the shipped hook.
  const hook = require(path.join(__dirname, '..', '..', 'dist', 'declaration-egress-hook.js'))
  const options = {
    sourceReadEgress: 'declarations',
    declarationRoot: WS,
    workspaceRoot: WS,
    workspaceVerified: true,
  }
  for (const command of ['rg SECRET src', 'rg SECRET .']) {
    const refused = hook.handleDeclarationPostExecute({ name: 'pwsh', arguments: { command } }, options)
    assert.ok(refused, command + ' reads file contents and must not pass raw output through')
    assert.equal(refused.kind, 'accept')
    assert.match(refused.content[0].text, /searches a directory/)
  }

  // CONTROL: listing a directory reads no contents, so it is untouched. Without this the rule would be a
  // ban on the shell tool rather than a rule about source.
  const listed = hook.handleDeclarationPostExecute(
    { name: 'pwsh', arguments: { command: 'Get-ChildItem src' } },
    options
  )
  assert.equal(listed, null, 'a listing is not a content read and must remain allowed')
});

test('a QUOTED directory scope is refused, and quoting that cannot be parsed is refused too (finding 2)', () => {
  // MEASURED (SECURITY-REVIEW-5 [2]): the hook split the command on whitespace, so `rg SECRET "code
  // space"` produced the tokens `"code` and `space"`. Neither matches a directory on disk, so the
  // directory predicate answered false and the raw matches were passed through -- the same leak finding 7
  // closed, reachable again through a path with a space in it. Both halves are driven through the shipped
  // hook, because the evaluator holds no filesystem view and cannot tokenise for itself.
  const os = require('node:os')
  const hook = require(path.join(__dirname, '..', '..', 'dist', 'declaration-egress-hook.js'))
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quoted-scope-'))
  const spaced = path.join(base, 'code space')
  fs.mkdirSync(spaced, { recursive: true })
  fs.writeFileSync(path.join(spaced, 'impl.ts'), 'export const secret = 1\n', 'utf8')
  try {
    // Precondition: the scope really is a directory with source in it, so the assertions below cannot pass
    // by describing an empty fixture.
    assert.ok(fs.statSync(spaced).isDirectory(), 'the fixture must be the directory the command names')
    assert.match(fs.readFileSync(path.join(spaced, 'impl.ts'), 'utf8'), /export const secret/)

    const options = {
      sourceReadEgress: 'declarations',
      declarationRoot: WS,
      workspaceRoot: base,
      workspaceVerified: true,
    }

    const quoted = hook.handleDeclarationPostExecute(
      { name: 'pwsh', arguments: { command: 'rg SECRET "code space"' } },
      options
    )
    assert.ok(quoted, 'a quoted directory scope still reads the files beneath it')
    assert.equal(quoted.kind, 'accept')
    assert.match(quoted.content[0].text, /searches a directory/)

    // An unclosed quote has no deterministic tokenisation, so it is refused rather than guessed at: the
    // guess is which of the tokens the shell would actually pass, and guessing it wrong is the leak above.
    const unclosed = hook.handleDeclarationPostExecute(
      { name: 'pwsh', arguments: { command: 'rg SECRET "code space' } },
      options
    )
    assert.ok(unclosed, 'an unparseable command must not fall through to the raw allow')
    assert.equal(unclosed.kind, 'accept')
    assert.match(unclosed.content[0].text, /quoting could not be parsed deterministically/)

    // CONTROL: tokenising correctly is not the same as refusing. A command whose scope resolves to nothing
    // is left alone, or the fix would be a ban on shell searches rather than a rule about source.
    const absent = hook.handleDeclarationPostExecute(
      { name: 'pwsh', arguments: { command: 'rg SECRET missing-directory' } },
      options
    )
    assert.equal(absent, null, 'a scope that names no directory is not an egress route')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
});
