// Gate: the built artifact is part of the change.
//
// `plugin/dist` is versioned, so a commit that changes `plugin/src` without the rebuilt `plugin/dist`
// leaves the repository shipping an artifact that does not match its source. That is not hypothetical:
// guard.ts was fixed and committed while dist/guard.js sat dirty in the working tree, and the gate that
// ran in the same command -- build, unit, oracles -- was green throughout, because all three read the
// working tree and not one of them asked whether the artifact was in the change.
//
// Run this after `npm run build`, from the repository root.
//
// `git diff --quiet HEAD` compares the working tree against the last commit, so it catches a rebuilt
// artifact that was never staged and a staged one that was never committed. It reads git's exit status
// and never its output, deliberately: capturing a child process's stdout needs a pipe, and this is run
// in environments where opening one is denied.
//
// Not covered, and stated rather than implied: a brand-new dist file that was built but never added to
// git is untracked, and `git diff` does not report untracked files. Run `git status -- plugin/dist`
// whenever a module is added.
const { spawnSync } = require('node:child_process');

const result = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'plugin/dist'], {
  stdio: 'inherit',
});

if (result.error) {
  console.error('[DIST_SYNC] could not run git: ' + result.error.message);
  process.exit(2);
}

if (result.status === 0) {
  console.log('[DIST_SYNC] plugin/dist matches HEAD.');
  process.exit(0);
}

if (result.status === 1) {
  console.error(
    '[DIST_SYNC] plugin/dist does not match HEAD: the build output is not part of the change. ' +
      'Rebuild with `npm run build`, then include the tracked files under plugin/dist in the commit.'
  );
  console.error('[DIST_SYNC] inspect with: git status -- plugin/dist');
  process.exit(1);
}

console.error('[DIST_SYNC] git exited with status ' + result.status);
process.exit(2);
