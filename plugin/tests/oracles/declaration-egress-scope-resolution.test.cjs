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
