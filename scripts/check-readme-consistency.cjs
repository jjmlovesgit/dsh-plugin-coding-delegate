#!/usr/bin/env node
// check-readme-consistency.cjs
//
// Two drifts motivated this script:
//   1. The plugin README's policy table had 7 rules while the root's had 8.
//   2. The root README declared "Four things" above a list of five.
//
// This script fails when the two READMEs disagree on mechanically checkable facts.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rootReadme = path.join(root, 'README.md');
const pluginReadme = path.join(root, 'plugin', 'README.md');

let failed = false;

function fail(msg) {
  failed = true;
  console.log('FAIL ' + msg);
}

function ok(msg) {
  console.log('ok ' + msg);
}

// --- Check 1: policy tables must agree ---
function extractPolicyNumbers(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const numbers = [];
  let inPolicy = false;
  for (const line of lines) {
    if (/^##\s+The policy\b/.test(line)) {
      inPolicy = true;
      continue;
    }
    if (inPolicy) {
      if (/^##\s/.test(line)) {
        inPolicy = false;
        continue;
      }
      const m = line.match(/^\|\s*(\d+)\s*\|/);
      if (m) numbers.push(parseInt(m[1], 10));
    }
  }
  return numbers;
}

const rootNums = extractPolicyNumbers(rootReadme);
const pluginNums = extractPolicyNumbers(pluginReadme);

const rootSet = [...new Set(rootNums)].sort((a, b) => a - b);
const pluginSet = [...new Set(pluginNums)].sort((a, b) => a - b);

if (rootSet.length === pluginSet.length && rootSet.every((n, i) => n === pluginSet[i])) {
  ok(`policy tables agree (${rootSet.length} rules: ${rootSet.join(', ')})`);
} else {
  fail(`policy tables differ: root has ${rootSet.length} rules [${rootSet.join(', ')}], plugin has ${pluginSet.length} rules [${pluginSet.join(', ')}]`);
}

// --- Check 2: declared count must match the list under it ---
const numberWords = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function checkDeclaredCount(file, label) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:\*\*)?([a-z]+) things, in the order they act:/i);
    if (!m) continue;
    const word = m[1].toLowerCase();
    const declared = numberWords[word];
    if (declared === undefined) {
      fail(`${label}: unrecognized number word "${word}"`);
      return;
    }
    let count = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^## /.test(lines[j])) {
        break;
      }
      if (/^\d+\. /.test(lines[j])) {
        count++;
      }
    }
    if (count === declared) {
      ok(`${label}: "${word} things" matches ${count} list items`);
    } else {
      fail(`${label}: declared "${word} things" (${declared}) but found ${count} list items`);
    }
    return;
  }
  // No such line found — skip
  ok(`${label}: no declared-count line found, skipping`);
}

checkDeclaredCount(rootReadme, 'root README');
checkDeclaredCount(pluginReadme, 'plugin README');

process.exit(failed ? 1 : 0);
