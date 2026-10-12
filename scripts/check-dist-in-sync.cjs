// Gate: the built artifact is part of the change.
//
// `plugin/dist` is versioned, so a commit that changes `plugin/src` without the rebuilt `plugin/dist`
// leaves the repository shipping an artifact that does not match its source. That is not hypothetical:
// guard.ts was fixed and committed while dist/guard.js sat dirty in the working tree, and the gate that
// ran in the same command -- build, unit, oracles -- was green throughout, because all three read the
// working tree and not one of them asked whether the artifact was in the change.
//
// THIS SCRIPT NOW RUNS THE BUILD ITSELF. It used to document "run this after `npm run build`" and then
// check only that the output was staged, which delegated the one question it exists to answer to the
// operator's memory. Measured failure: a source doc comment was corrected and committed with no rebuild
// at all, so dist was byte-identical to HEAD and to the index, `git diff --quiet -- plugin/dist` exited
// 0, and this gate reported that every rebuilt artifact was staged while the artifact did not match its
// source. It reached a release candidate. A green that depends on a build having been run somewhere else
// is the same defect as the one this gate was written to catch.
//
// Building here makes the check self-sufficient: after a build, an unstaged difference under plugin/dist
// is either a rebuild nobody staged or a source change nobody rebuilt, and those are the same failure
// with the same remedy, so they report identically.
//
// It compares the working tree against the INDEX, so it answers "is every rebuilt artifact staged?" --
// which is the question a pre-commit gate can act on. The first version compared against HEAD instead,
// and failed the first time it was used in the order documented here: before the commit, a correctly
// rebuilt dist always differs from HEAD, so the check was unsatisfiable and would have been switched off
// rather than fixed. Against the index it is 0 when the artifact is staged and 1 when it is not.
//
// It reads git's exit status and never its output, deliberately: capturing a child process's stdout needs
// a pipe, and this is run in environments where opening one is denied. The build's output is inherited
// rather than captured, for the same reason.
//
// The repository root is NAMED rather than assumed. A pathspec resolves against the process cwd, so run
// from `plugin/` this used to resolve `plugin/dist` to `plugin/plugin/dist`, match nothing, and report
// success for a tree it had never looked at -- measured: the same dirty dist gave exit 1 from the root and
// exit 0 from `plugin/`. A gate that passes by looking at nothing is worse than no gate.
//
// Not covered, and stated rather than implied: a brand-new dist file that was built but never added to git
// is untracked, and `git diff` does not report untracked files. Run `git status -- plugin/dist` whenever a
// module is added.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugin');

// A shell is used only for the build. `npm` is a `.cmd` shim on Windows, and Node refuses to spawn a
// `.cmd` or `.bat` without one (EINVAL, from the 2024 hardening), so naming the platform's binary instead
// would still fail there. The property that matters survives: stdio is inherited, never piped.
const build = spawnSync('npm', ['run', 'build'], {
  cwd: PLUGIN_DIR,
  stdio: 'inherit',
  shell: true,
});

if (build.error) {
  console.error('[DIST_SYNC] could not run the build: ' + build.error.message);
  process.exit(2);
}

if (build.status !== 0) {
  console.error(
    '[DIST_SYNC] `npm run build` exited with status ' +
      build.status +
      ', so dist is not known to match source. Fix the build before asking this gate anything.'
  );
  process.exit(2);
}

const result = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--quiet', '--', 'plugin/dist'], {
  stdio: 'inherit',
});

if (result.error) {
  console.error('[DIST_SYNC] could not run git: ' + result.error.message);
  process.exit(2);
}

if (result.status === 0) {
  console.log(
    '[DIST_SYNC] plugin/dist matches what source builds, and every rebuilt artifact is staged, in ' +
      REPO_ROOT +
      '.'
  );
  process.exit(0);
}

if (result.status === 1) {
  console.error(
    '[DIST_SYNC] plugin/dist has changes that are not staged, in ' + REPO_ROOT + ': the build output is ' +
      'not part of this change. Either a rebuild was not staged, or source changed and was never ' +
      'rebuilt -- the build above has now made the difference visible either way. `git add` the tracked ' +
      'files under plugin/dist before committing.'
  );
  console.error('[DIST_SYNC] inspect with: git status -- plugin/dist');
  process.exit(1);
}

console.error('[DIST_SYNC] git exited with status ' + result.status);
process.exit(2);
