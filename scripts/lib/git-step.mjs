/**
 * Step 1: update the project with a fast-forward-only `git pull` (1.1 – 1.5).
 *
 * ## What this step is allowed to do
 *
 * 1.5 is a prohibition, and it is kept structurally: this module contains exactly two Git commands,
 * {@link GIT_STATUS_COMMAND} and {@link GIT_PULL_COMMAND}, both exported frozen, and nothing else
 * builds a Git argument list. There is no `reset`, no forced checkout, no `clean` and no merge, so a
 * merge commit cannot be created — `--ff-only` makes Git refuse a non-fast-forward instead of merging
 * it. `scripts/lib/__tests__/git-no-destructive-commands.test.mjs` asserts both halves of that: every
 * command the step issues in every branch is one of the two, and no source file of the Start_Script
 * passes a destructive Git argument anywhere.
 *
 * ## Why nothing here is fatal
 *
 * Step 1 has three ways not to update — a dirty working tree (1.3), a failed pull (1.4), and a working
 * tree whose state could not be read — and all three print a German warning and continue with step 2.
 * The user's work is never at risk from this step, because in all three cases it does not run `git pull`
 * at all, or Git itself refused it and left the local state alone.
 *
 * ## Why the classifier is separate
 *
 * {@link classifyPullFailure} and {@link parseWorkingTreeStatus} are pure functions over tool output,
 * so the Vitest suite drives them with recorded Git output instead of a remote, and task 20.4 can
 * extend the table of cases without a fixture.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5.
 */

import { extractFailureDetail } from './command-runner.mjs';
import { GIT_PULL_OUTCOMES, PULL_FAILURE_CAUSES } from './outcomes.mjs';
import {
  pullFailedWarning,
  workingTreeDirtyWarning,
  workingTreeUnreadableWarning,
} from './start.messages.mjs';
import { START_STEPS } from './steps.mjs';

/**
 * How long a Git command may take before it is killed.
 *
 * A pull without a reachable remote can sit in a connect for minutes, and the start must not hang on
 * step 1 of 7. A killed pull is classified as a network cause, which is what a stalled connect is.
 */
export const GIT_TIMEOUT_MS = 60_000;

/**
 * Reads the state of the working tree.
 *
 * `--porcelain` because the format is stable across Git versions, and `-c core.quotepath=false` so a
 * path with an umlaut arrives as itself instead of as escape sequences — the warning of 1.3 has to name
 * the changed files to a German-speaking user.
 */
export const GIT_STATUS_COMMAND = Object.freeze({
  command: 'git',
  args: Object.freeze(['-c', 'core.quotepath=false', 'status', '--porcelain']),
  timeoutMs: GIT_TIMEOUT_MS,
});

/** The only Git command that changes anything, and it can only fast-forward (1.5). */
export const GIT_PULL_COMMAND = Object.freeze({
  command: 'git',
  args: Object.freeze(['pull', '--ff-only']),
  timeoutMs: GIT_TIMEOUT_MS,
});

/** The complete Git vocabulary of the Start_Script. Asserted on by the prohibition test of 1.5. */
export const PERMITTED_GIT_COMMANDS = Object.freeze([GIT_STATUS_COMMAND, GIT_PULL_COMMAND]);

/**
 * Git output that means the local and the remote history have diverged (1.4).
 *
 * Exported so the suite can drive the table itself rather than a sample of it: every marker listed
 * here is asserted to classify as {@link PULL_FAILURE_CAUSES.NO_FAST_FORWARD}, so a marker added
 * without a case is a failing test instead of an untested branch.
 */
export const NO_FAST_FORWARD_MARKERS = Object.freeze([
  'not possible to fast-forward',
  'cannot fast-forward',
  'fast-forward is not possible',
  'diverging branches',
  'divergent branches',
  'non-fast-forward',
  'need to specify how to reconcile',
]);

/**
 * Git output that means the remote was not reachable (1.4).
 *
 * "could not read from remote repository" is deliberately absent: Git prints it for a rejected key as
 * well as for a dead network, so it would let an authentication problem be reported as a missing
 * network connection. Such a failure falls through to `UNKNOWN`, whose warning quotes the Git line.
 *
 * Exported for the same reason as {@link NO_FAST_FORWARD_MARKERS}: the suite asserts the whole table,
 * and asserts that the absent line stays absent.
 */
export const NO_NETWORK_MARKERS = Object.freeze([
  'could not resolve host',
  'could not resolve hostname',
  'name or service not known',
  'temporary failure in name resolution',
  'network is unreachable',
  'no route to host',
  'connection timed out',
  'connection refused',
  'operation timed out',
  'failed to connect to',
  'unable to access',
  'network is down',
]);

/**
 * One uncommitted change of the working tree.
 *
 * @typedef {object} WorkingTreeChange
 * @property {string} code The two-character porcelain status, for example ` M` or `A `.
 * @property {string} letter The status letter the German label is keyed on; see below.
 * @property {string} path The path as Git reports it; for a rename, the new path.
 * @property {boolean} untracked Whether the entry is an untracked file (`??`).
 */

/**
 * The classified result of a failed `git pull`.
 *
 * @typedef {object} PullFailure
 * @property {string} cause One of {@link PULL_FAILURE_CAUSES}.
 * @property {string | null} detail The Git line the German warning quotes, or `null` for no output.
 * @property {boolean} timedOut Whether the command was killed after {@link GIT_TIMEOUT_MS}.
 */

/**
 * Parses `git status --porcelain` into the changes of 1.3.
 *
 * Untracked files are recorded but do not make the tree dirty. A fast-forward cannot silently overwrite
 * a file Git does not track: if an incoming commit would write over one, Git aborts the pull by itself
 * and names the file, which arrives here as a pull failure whose warning quotes that line. Treating
 * untracked files as dirty would instead mean that one stray download in the project folder stops the
 * user from ever receiving an update.
 *
 * @param {string} stdout
 * @returns {{ changes: readonly WorkingTreeChange[], trackedChanges: readonly WorkingTreeChange[], isDirty: boolean }}
 */
export function parseWorkingTreeStatus(stdout) {
  /** @type {WorkingTreeChange[]} */
  const changes = [];

  for (const rawLine of stdout.split('\n')) {
    if (rawLine.trim() === '') {
      continue;
    }

    const code = rawLine.slice(0, 2);
    const untracked = code === '??';

    changes.push({
      code,
      // The worktree letter if the file differs from the index, otherwise the index letter: the label
      // should say what happened to the file, and a staged-only change is reported in the first column.
      letter: untracked ? '?' : pickStatusLetter(code),
      path: extractPath(rawLine.slice(2).trim()),
      untracked,
    });
  }

  const trackedChanges = changes.filter((change) => !change.untracked);

  return { changes, trackedChanges, isDirty: trackedChanges.length > 0 };
}

/**
 * Classifies why `git pull` failed (1.4).
 *
 * Keys on what Git actually prints, lower-cased, across stderr and stdout. The order matters: the
 * divergence markers are tested first, because Git's own hint block for a non-fast-forward situation
 * mentions fetching and can contain wording that looks transport-related, while no unreachable remote
 * produces a divergence marker.
 *
 * A killed command is classified as a network cause without looking at the output, because
 * {@link GIT_TIMEOUT_MS} only elapses while Git waits for a remote that is not answering.
 *
 * @param {import('./command-runner.mjs').CommandResult} result
 * @returns {PullFailure}
 */
export function classifyPullFailure(result) {
  const detail = extractFailureDetail(result);

  if (result.timedOut) {
    return { cause: PULL_FAILURE_CAUSES.NO_NETWORK, detail, timedOut: true };
  }

  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();

  if (NO_FAST_FORWARD_MARKERS.some((marker) => output.includes(marker))) {
    return { cause: PULL_FAILURE_CAUSES.NO_FAST_FORWARD, detail, timedOut: false };
  }

  if (NO_NETWORK_MARKERS.some((marker) => output.includes(marker))) {
    return { cause: PULL_FAILURE_CAUSES.NO_NETWORK, detail, timedOut: false };
  }

  return { cause: PULL_FAILURE_CAUSES.UNKNOWN, detail, timedOut: false };
}

/**
 * Runs step 1: one progress line, then at most one status read and at most one fast-forward pull.
 *
 * Never throws for a Git failure. Every branch returns, so the orchestrator continues with step 2 as
 * 1.3 and 1.4 require.
 *
 * @param {object} dependencies
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @returns {Promise<{ outcome: string, changes?: readonly WorkingTreeChange[], failure?: PullFailure }>}
 */
export async function runGitPullStep({ run, reporter }) {
  reporter.progress(START_STEPS.GIT_PULL);

  const status = await run(GIT_STATUS_COMMAND);

  if (!status.ok) {
    reporter.warn(workingTreeUnreadableWarning(extractFailureDetail(status) ?? ''));

    return { outcome: GIT_PULL_OUTCOMES.SKIPPED_TREE_UNREADABLE };
  }

  const tree = parseWorkingTreeStatus(status.stdout);

  if (tree.isDirty) {
    reporter.warn(workingTreeDirtyWarning(tree.trackedChanges));

    return { outcome: GIT_PULL_OUTCOMES.SKIPPED_DIRTY_TREE, changes: tree.trackedChanges };
  }

  const pull = await run(GIT_PULL_COMMAND);

  if (pull.ok) {
    return { outcome: GIT_PULL_OUTCOMES.UPDATED };
  }

  const failure = classifyPullFailure(pull);

  reporter.warn(pullFailedWarning(failure));

  return { outcome: GIT_PULL_OUTCOMES.FAILED, failure };
}

/**
 * The status letter the German label is keyed on.
 *
 * @param {string} code
 * @returns {string}
 */
function pickStatusLetter(code) {
  const [index, worktree] = [code.charAt(0), code.charAt(1)];

  return worktree !== ' ' && worktree !== '' ? worktree : index;
}

/**
 * The path of a porcelain entry. A rename arrives as `old -> new`; the new path is the one the user
 * finds on disk, so that is the one the warning names.
 *
 * @param {string} entry
 * @returns {string}
 */
function extractPath(entry) {
  const arrow = entry.lastIndexOf(' -> ');

  return arrow === -1 ? entry : entry.slice(arrow + 4).trim();
}
