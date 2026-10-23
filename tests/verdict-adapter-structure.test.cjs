// Structural oracle: `resolveDelegateStatus` must stay a pass-through adapter.
//
// The behavioural parity test proves the plugin's verdicts still match the specification across 64
// combinations. It cannot prove WHY: someone could reintroduce the lattice inside
// `resolveDelegateStatus` and, as long as the outputs agreed today, every behavioural test would stay
// green until the two implementations drifted. This checks the shape of the function instead — no
// branching is allowed in it at all — so a reimplementation fails immediately rather than eventually.
//
// The parser is the TypeScript compiler from `plugin/node_modules`, because that is the one the plugin
// actually builds with; a different parser would be testing a different language.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SOURCE = path.join(REPO, 'plugin', 'src', 'delegation.ts');
const ts = require(path.join(REPO, 'plugin', 'node_modules', 'typescript'));

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function findFunction(sourceFile, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** Every construct that would let a decision live inside the adapter again. */
function countDecisionNodes(node) {
  let count = 0;
  const visit = (current) => {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      count += 1;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return count;
}

function calledNames(node) {
  const names = [];
  const visit = (current) => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      names.push(current.expression.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

test('resolveDelegateStatus is a pass-through adapter, structurally', async (t) => {
  const sourceFile = parse(SOURCE);
  const fn = findFunction(sourceFile, 'resolveDelegateStatus');

  await t.test('the function exists and has a body', () => {
    assert.ok(fn, 'resolveDelegateStatus must exist in plugin/src/delegation.ts');
    assert.ok(fn.body, 'resolveDelegateStatus must have a body (not a declaration-only signature)');
  });

  await t.test('it contains no decision of its own', () => {
    const decisions = countDecisionNodes(fn.body);
    assert.equal(
      decisions,
      0,
      'resolveDelegateStatus contains ' +
        decisions +
        ' decision node(s). The lattice lives in the vendored specification; a branch here is the ' +
        'lattice being reimplemented, and the behavioural oracle would not notice until the two drifted.'
    );
  });

  await t.test('it delegates to the vendored resolveVerdict', () => {
    const calls = calledNames(fn.body);
    assert.ok(
      calls.includes('resolveVerdict'),
      'resolveDelegateStatus must call resolveVerdict; without that call the adapter is returning something else'
    );
  });

  await t.test('the vendored lattice is the only implementation it can reach', () => {
    // A guard against the subtlest version of the drift: delegating to a DIFFERENT function that happens
    // to agree today. The imports at the top of the file must come from the vendored module.
    const text = fs.readFileSync(SOURCE, 'utf8');
    assert.match(
      text,
      /import \{[^}]*resolveVerdict[^}]*\} from '\.\/vendor\/protocol\/task-lifecycle'/,
      'resolveVerdict must be imported from the vendored specification'
    );
  });
});
