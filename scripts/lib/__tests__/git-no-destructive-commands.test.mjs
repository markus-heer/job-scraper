/**
 * Requirement 1.5 as a test: the Start_Script limits its Git operations to a fast-forward-only pull and
 * leaves the local history and the working tree alone in every other respect — no `git reset`, no forced
 * checkout, no `git clean`, and no merge commit.
 *
 * Checked from two sides, because either one alone would be easy to slip past:
 *
 * - *behaviourally*, by running step 1 through every branch it has against a fake runner and asserting
 *   that every command it issued is one of the two permitted ones;
 * - *structurally*, by scanning the source of the Start_Script for a destructive Git argument. The scan
 *   looks for the arguments as quoted tokens, which is how a command would have to pass one, so the
 *   German sentence that advises the user to merge their own work by hand does not trip it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GIT_PULL_COMMAND,
  GIT_STATUS_COMMAND,
  PERMITTED_GIT_COMMANDS,
  runGitPullStep,
} from '../git-step.mjs';
import { createReporter } from '../reporter.mjs';
import {
  commandKey,
  createFakeCommandRunner,
  createRecordingReporter,
  failure,
  success,
} from './fake-command-runner.mjs';

const SCRIPTS_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STATUS_KEY = commandKey(GIT_STATUS_COMMAND);
const PULL_KEY = commandKey(GIT_PULL_COMMAND);
const PERMITTED_KEYS = PERMITTED_GIT_COMMANDS.map(commandKey);

/**
 * Arguments that would change the local history or the working tree beyond a fast-forward, as they
 * would appear in a command definition.
 */
const FORBIDDEN_ARGUMENTS = [
  'reset',
  'clean',
  'checkout',
  'merge',
  'rebase',
  'restore',
  'stash',
  'push',
  '--force',
  '-f',
  '--hard',
  '--no-ff',
];

/** Every branch of step 1, as a prepared runner table. */
const STEP_ONE_BRANCHES = {
  'clean tree, fast-forward applied': {
    [STATUS_KEY]: success(''),
    [PULL_KEY]: success('Fast-forward\n'),
  },
  'dirty tree': { [STATUS_KEY]: success(' M apps/api/src/main.ts\n') },
  'status unreadable': {
    [STATUS_KEY]: failure({ code: 128, stderr: 'fatal: not a git repository\n' }),
  },
  'pull refused, no fast-forward': {
    [STATUS_KEY]: success(''),
    [PULL_KEY]: failure({ code: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' }),
  },
  'pull failed, no network': {
    [STATUS_KEY]: success(''),
    [PULL_KEY]: failure({ code: 128, stderr: 'fatal: unable to access: Could not resolve host\n' }),
  },
};

/**
 * Every `.mjs` source file of the Start_Script, tests excluded.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') {
        continue;
      }

      files.push(...(await collectSourceFiles(path)));

      continue;
    }

    if (entry.name.endsWith('.mjs')) {
      files.push(path);
    }
  }

  return files;
}

describe('the Git operations of the Start_Script (1.5)', () => {
  it.each(Object.entries(STEP_ONE_BRANCHES))(
    'issues only the two permitted commands: %s',
    async (_branch, results) => {
      const run = createFakeCommandRunner(results);
      const { reporter } = createRecordingReporter(createReporter);

      await runGitPullStep({ run, reporter });

      expect(run.invocations.length).toBeGreaterThan(0);

      for (const key of run.keys()) {
        expect(PERMITTED_KEYS).toContain(key);
      }
    },
  );

  it('permits exactly two Git commands, and the pull can only fast-forward', () => {
    expect(PERMITTED_KEYS).toStrictEqual([
      'git -c core.quotepath=false status --porcelain',
      'git pull --ff-only',
    ]);
    expect(GIT_PULL_COMMAND.args).toContain('--ff-only');
  });

  it('passes no destructive Git argument anywhere in the Start_Script source', async () => {
    const files = await collectSourceFiles(SCRIPTS_ROOT);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, 'utf8');

      for (const argument of FORBIDDEN_ARGUMENTS) {
        expect(source, `${file} passes the Git argument ${argument}`).not.toMatch(
          new RegExp(`['"]${argument.replace(/-/g, '\\-')}['"]`),
        );
      }
    }
  });
});
