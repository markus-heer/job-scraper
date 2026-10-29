/**
 * Step 1 of the Start_Script: the dirty-tree skip of 1.3, the failure classification of 1.4 and the
 * single progress line of 1.2.
 *
 * The Git output in these cases is quoted from what Git prints, lower-cased nowhere and shortened only
 * where a hint block repeats itself, because the classifier keys on exactly those lines.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyPullFailure,
  GIT_PULL_COMMAND,
  GIT_STATUS_COMMAND,
  NO_FAST_FORWARD_MARKERS,
  NO_NETWORK_MARKERS,
  parseWorkingTreeStatus,
  runGitPullStep,
} from '../git-step.mjs';
import { GIT_PULL_OUTCOMES, PULL_FAILURE_CAUSES } from '../outcomes.mjs';
import { createReporter } from '../reporter.mjs';
import {
  commandKey,
  completeResult,
  createFakeCommandRunner,
  createRecordingReporter,
  failure,
  success,
} from './fake-command-runner.mjs';

const STATUS_KEY = commandKey(GIT_STATUS_COMMAND);
const PULL_KEY = commandKey(GIT_PULL_COMMAND);

/** A classified result built from Git output alone, without running a step. */
function classify({ stderr = '', stdout = '', timedOut = false } = {}) {
  return classifyPullFailure(
    completeResult(GIT_PULL_COMMAND, { code: 1, stderr, stdout, timedOut }),
  );
}

describe('parseWorkingTreeStatus', () => {
  it('reads an empty status as a clean tree', () => {
    const tree = parseWorkingTreeStatus('');

    expect(tree.isDirty).toBe(false);
    expect(tree.changes).toHaveLength(0);
  });

  it('reports a modified, a staged, a deleted, a renamed and a conflicted file as uncommitted', () => {
    const tree = parseWorkingTreeStatus(
      [
        ' M apps/api/src/main.ts',
        'A  packages/domain/src/new-file.ts',
        ' D packages/domain/src/old-file.ts',
        'R  scripts/old-name.mjs -> scripts/new-name.mjs',
        'UU apps/web/src/App.tsx',
        '',
      ].join('\n'),
    );

    expect(tree.isDirty).toBe(true);
    expect(tree.trackedChanges.map((change) => [change.letter, change.path])).toStrictEqual([
      ['M', 'apps/api/src/main.ts'],
      ['A', 'packages/domain/src/new-file.ts'],
      ['D', 'packages/domain/src/old-file.ts'],
      ['R', 'scripts/new-name.mjs'],
      ['U', 'apps/web/src/App.tsx'],
    ]);
  });

  it('does not treat an untracked file as an uncommitted change', () => {
    const tree = parseWorkingTreeStatus('?? notizen.txt\n?? bilder/screenshot.png\n');

    expect(tree.isDirty).toBe(false);
    expect(tree.changes).toHaveLength(2);
    expect(tree.trackedChanges).toHaveLength(0);
  });

  it('keeps a path with an umlaut as it is', () => {
    const tree = parseWorkingTreeStatus(' M docs/adapter/größe.md');

    expect(tree.trackedChanges[0].path).toBe('docs/adapter/größe.md');
  });
});

describe('classifyPullFailure', () => {
  it('names the missing network for an unresolvable host over https', () => {
    const classified = classify({
      stderr:
        "fatal: unable to access 'https://github.com/example/job-scraper.git/': Could not resolve host: github.com\n",
    });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.NO_NETWORK);
    expect(classified.detail).toContain('Could not resolve host');
  });

  it('names the missing network for an unresolvable host over ssh', () => {
    const classified = classify({
      stderr:
        'ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known\nfatal: Could not read from remote repository.\n',
    });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.NO_NETWORK);
  });

  it('names the missing network for a connection that timed out', () => {
    const classified = classify({
      stderr: 'ssh: connect to host github.com port 22: Operation timed out\n',
    });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.NO_NETWORK);
  });

  it('names the missing network when the command was killed after the timeout', () => {
    const classified = classify({ timedOut: true });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.NO_NETWORK);
    expect(classified.timedOut).toBe(true);
    expect(classified.detail).toBeNull();
  });

  it('names the impossible fast-forward when git refuses to merge', () => {
    const classified = classify({ stderr: 'fatal: Not possible to fast-forward, aborting.\n' });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.NO_FAST_FORWARD);
    expect(classified.detail).toBe('fatal: Not possible to fast-forward, aborting.');
  });

  it('names the impossible fast-forward for diverged branches', () => {
    const classified = classify({
      stderr:
        'hint: You have divergent branches and need to specify how to reconcile them.\nfatal: Need to specify how to reconcile divergent branches.\n',
    });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.NO_FAST_FORWARD);
  });

  it('does not claim a missing network for a rejected credential', () => {
    const classified = classify({
      stderr:
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n',
    });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.UNKNOWN);
    expect(classified.detail).toContain('Could not read from remote repository');
  });

  it('falls back to the unknown cause and quotes the reported line', () => {
    const classified = classify({
      stderr:
        'error: Your local changes to the following files would be overwritten by merge:\n\tapps/web/src/App.tsx\n',
    });

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.UNKNOWN);
    expect(classified.detail).toContain('would be overwritten');
  });

  it('reports no detail when git printed nothing at all', () => {
    const classified = classify({});

    expect(classified.cause).toBe(PULL_FAILURE_CAUSES.UNKNOWN);
    expect(classified.detail).toBeNull();
  });
});

describe('the marker table of 1.4', () => {
  // Driven from the exported tables rather than from a copy of them: a marker added to the classifier
  // without a case here fails this suite instead of shipping as an untested branch. The marker is
  // upper-cased in the line, which also pins that the classification does not depend on Git's casing.
  it.each([...NO_FAST_FORWARD_MARKERS])('reads "%s" as an impossible fast-forward', (marker) => {
    expect(classify({ stderr: `fatal: ${marker.toUpperCase()}, aborting.\n` }).cause).toBe(
      PULL_FAILURE_CAUSES.NO_FAST_FORWARD,
    );
  });

  it.each([...NO_NETWORK_MARKERS])('reads "%s" as a missing network', (marker) => {
    expect(classify({ stderr: `fatal: ${marker.toUpperCase()}\n` }).cause).toBe(
      PULL_FAILURE_CAUSES.NO_NETWORK,
    );
  });

  it('classifies a marker that arrives on stdout as well', () => {
    expect(classify({ stdout: 'hint: You have divergent branches.\n' }).cause).toBe(
      PULL_FAILURE_CAUSES.NO_FAST_FORWARD,
    );
  });

  it('keeps the ambiguous remote line out of both tables', () => {
    // Git prints it for a rejected key as much as for a dead network, so neither table may claim it.
    const ambiguous = 'could not read from remote repository';

    expect([...NO_NETWORK_MARKERS, ...NO_FAST_FORWARD_MARKERS]).not.toContain(ambiguous);
    expect(classify({ stderr: `fatal: ${ambiguous}.\n` }).cause).toBe(PULL_FAILURE_CAUSES.UNKNOWN);
  });

  it('names a divergence even where the output also mentions the transport', () => {
    // Git's hint block for a non-fast-forward situation talks about fetching, so the order of the two
    // tables decides this case. The divergence is what the user has to resolve.
    expect(
      classify({
        stderr: [
          'hint: Diverging branches can not be fast-forwarded, you need to either:',
          'fatal: Not possible to fast-forward, aborting.',
          'error: failed to connect to the hint above',
          '',
        ].join('\n'),
      }).cause,
    ).toBe(PULL_FAILURE_CAUSES.NO_FAST_FORWARD);
  });
});

describe('runGitPullStep', () => {
  it('pulls fast-forward only on a clean tree and prints exactly one progress line', async () => {
    const run = createFakeCommandRunner({
      [STATUS_KEY]: success(''),
      [PULL_KEY]: success('Updating 1a2b3c4..5d6e7f8\nFast-forward\n'),
    });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    const result = await runGitPullStep({ run, reporter });

    expect(result.outcome).toBe(GIT_PULL_OUTCOMES.UPDATED);
    expect(run.keys()).toStrictEqual([STATUS_KEY, PULL_KEY]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('Schritt 1 von 7: Projektstand aktualisieren, nur Fast-Forward …');
    expect(errorLines).toHaveLength(0);
  });

  it('skips the pull on a dirty tree, names the uncommitted changes and continues', async () => {
    const run = createFakeCommandRunner({
      [STATUS_KEY]: success(' M apps/api/src/main.ts\n?? notizen.txt\n'),
    });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    const result = await runGitPullStep({ run, reporter });

    expect(result.outcome).toBe(GIT_PULL_OUTCOMES.SKIPPED_DIRTY_TREE);
    expect(run.keys()).toStrictEqual([STATUS_KEY]);
    expect(out).toHaveLength(1);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('apps/api/src/main.ts (geändert)');
    expect(errorLines[0]).toContain('Nächster Schritt:');
  });

  it('skips the pull when the status cannot be read and continues', async () => {
    const run = createFakeCommandRunner({
      [STATUS_KEY]: failure({ code: 128, stderr: 'fatal: not a git repository\n' }),
    });
    const { reporter, errorLines } = createRecordingReporter(createReporter);

    const result = await runGitPullStep({ run, reporter });

    expect(result.outcome).toBe(GIT_PULL_OUTCOMES.SKIPPED_TREE_UNREADABLE);
    expect(run.keys()).toStrictEqual([STATUS_KEY]);
    expect(errorLines[0]).toContain('fatal: not a git repository');
  });

  it('warns with the detected cause when the pull fails and continues', async () => {
    const run = createFakeCommandRunner({
      [STATUS_KEY]: success(''),
      [PULL_KEY]: failure({
        code: 128,
        stderr: 'fatal: Not possible to fast-forward, aborting.\n',
      }),
    });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    const result = await runGitPullStep({ run, reporter });

    expect(result.outcome).toBe(GIT_PULL_OUTCOMES.FAILED);
    expect(result.failure.cause).toBe(PULL_FAILURE_CAUSES.NO_FAST_FORWARD);
    expect(out).toHaveLength(1);
    expect(errorLines[0]).toContain('keine Fast-Forward-Aktualisierung möglich');
    expect(errorLines[0]).toContain('Der lokale Projektstand bleibt unverändert');
  });

  it('warns and continues when git itself is not installed', async () => {
    const run = createFakeCommandRunner({
      [STATUS_KEY]: { code: null, spawnFailed: true, stderr: 'spawn git ENOENT', ok: false },
    });
    const { reporter, errorLines } = createRecordingReporter(createReporter);

    const result = await runGitPullStep({ run, reporter });

    expect(result.outcome).toBe(GIT_PULL_OUTCOMES.SKIPPED_TREE_UNREADABLE);
    expect(errorLines[0]).toContain('spawn git ENOENT');
  });

  it('never attempts a pull without reading the working tree first', async () => {
    const run = createFakeCommandRunner({
      [STATUS_KEY]: success(' M apps/api/src/main.ts\n'),
      [PULL_KEY]: success(''),
    });
    const { reporter } = createRecordingReporter(createReporter);

    await runGitPullStep({ run, reporter });

    expect(run.keys()).not.toContain(PULL_KEY);
  });
});
