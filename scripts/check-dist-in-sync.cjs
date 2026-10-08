// Gate: the built artifact is part of the change.
//
// `plugin/dist` is versioned, so a commit that changes `plugin/src` without the rebuilt `plugin/dist`
// leaves the repository shipping an artifact that does not match its source. That is not hypothetical:
// guard.ts was fixed and committed while dist/guard.js sat dirty in the working tree, and the gate that
// ran in the same command -- build, unit, oracles -- was green throughout, because all three read the
// working tree and not one of them asked whether the artifact was in the change.
//
// Run this after `npm run build`. It works from any directory inside the repository.
//
// `git diff --quiet HEAD` compares the working tree against the last commit, so it catches a rebuilt
// artifact that was never staged and a staged one that was never committed. It reads git's exit status
// and never its output, deliberately: capturing a child process's stdout needs a pipe, and this is run in
// environments where opening one is denied.
//
// The repository root is NAMED rather than assumed, and that is a fix rather than a style choice. The
// pathspec is relative to the repository root, so with the process cwd as the base, running this from
// `plugin/` resolved `plugin/dist` to `plugin/plugin/dist`, which matches nothing -- and the check then
// reported "matches HEAD", exit 0, for a tree it had never looked at. Measured: the same dirty dist gave
// exit 1 from the root and exit 0 from `plugin/`. A gate that passes by looking at nothing is worse than
// no gate, because it is read as evidence.
//
// Not covered, and stated rather than implied: a brand-new dist file that was built but never added to git
// is untracked, and `git diff` does not report untracked files. Run `git status -- plugin/dist` whenever a
// module is added.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const result = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--quiet', 'HEAD', '--', 'plugin/dist'], {
  stdio: 'inherit',
});

if (result.error) {
  console.error('[DIST_SYNC] could not run git: ' + result.error.message);
  process.exit(2);
}

if (result.status === 0) {
  console.log('[DIST_SYNC] plugin/dist matches HEAD in ' + REPO_ROOT + '.');
  process.exit(0);
}

if (result.status === 1) {
  console.error(
    '[DIST_SYNC] plugin/dist does not match HEAD in ' + REPO_ROOT + ': the build output is not part of ' +
      'the change. Rebuild with `npm run build`, then include the tracked files under plugin/dist in the ' +
      'commit.'
  );
  console.error('[DIST_SYNC] inspect with: git status -- plugin/dist');
  process.exit(1);
}

console.error('[DIST_SYNC] git exited with status ' + result.status);
process.exit(2);
