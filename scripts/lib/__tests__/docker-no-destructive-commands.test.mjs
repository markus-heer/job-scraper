/**
 * Requirement 1.10 as a test: the Start_Script reuses a running PostgreSQL container, creates no second
 * one and leaves the stored data in the Posting_Store unchanged.
 *
 * Checked from the same two sides as the Git prohibition of 1.5, because either one alone would be easy
 * to slip past:
 *
 * - *behaviourally*, by running step 4 through every branch it has against a fake runner and asserting
 *   that every command it issued is one of the three permitted ones, and that a container which is
 *   already running and healthy is not even brought up again;
 * - *structurally*, by scanning the source of the Start_Script for an argument that would remove or
 *   replace a container or a volume. The scan looks for quoted tokens, which is how a command would
 *   have to pass one.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTAINER_READINESS_DECISIONS } from '../outcomes.mjs';
import {
  COMPOSE_STATE_COMMAND,
  COMPOSE_UP_COMMAND,
  decideContainerReadiness,
  DOCKER_RUNTIME_PROBE_COMMAND,
  PERMITTED_DOCKER_COMMANDS,
  runPostgresContainerStep,
} from '../postgres-step.mjs';
import { createReporter } from '../reporter.mjs';
import {
  commandKey,
  createFakeCommandRunner,
  createRecordingReporter,
  failure,
  success,
} from './fake-command-runner.mjs';

const SCRIPTS_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const PROBE_KEY = commandKey(DOCKER_RUNTIME_PROBE_COMMAND);
const STATE_KEY = commandKey(COMPOSE_STATE_COMMAND);
const UP_KEY = commandKey(COMPOSE_UP_COMMAND);
const PERMITTED_KEYS = PERMITTED_DOCKER_COMMANDS.map(commandKey);

/**
 * Arguments that would remove a container, replace one, or discard a volume, as they would appear in a
 * command definition.
 */
const FORBIDDEN_ARGUMENTS = [
  'down',
  'rm',
  'prune',
  'kill',
  'volume',
  '--force-recreate',
  '--renew-anon-volumes',
  '--volumes',
  '--remove-orphans',
];

/** A container state as `docker compose ps --format json` reports it. */
function psOutput(state, health) {
  return `${JSON.stringify({
    Name: 'job-tool-postgres',
    Service: 'postgres',
    State: state,
    Health: health,
    Status: `${state} (${health})`,
  })}\n`;
}

/** Every branch of step 4 that gets past the runtime probe, as a prepared runner table. */
const STEP_FOUR_BRANCHES = {
  'running and healthy, reused as it is': {
    [PROBE_KEY]: success('29.5.2\n'),
    [STATE_KEY]: success(psOutput('running', 'healthy')),
  },
  'no container yet, one is created': {
    [PROBE_KEY]: success('29.5.2\n'),
    [STATE_KEY]: success(''),
    [UP_KEY]: success('Container job-tool-postgres Started\n'),
  },
  'container exists but has exited': {
    [PROBE_KEY]: success('29.5.2\n'),
    [STATE_KEY]: success(psOutput('exited', '')),
    [UP_KEY]: success('Container job-tool-postgres Started\n'),
  },
  'container reports its check as failed': {
    [PROBE_KEY]: success('29.5.2\n'),
    [STATE_KEY]: success(psOutput('running', 'unhealthy')),
    [UP_KEY]: success('Container job-tool-postgres Started\n'),
  },
  'the container cannot be started': {
    [PROBE_KEY]: success('29.5.2\n'),
    [STATE_KEY]: success(''),
    [UP_KEY]: failure({ code: 1, stderr: 'Error response from daemon: port already allocated\n' }),
  },
  'the state cannot be read': {
    [PROBE_KEY]: success('29.5.2\n'),
    [STATE_KEY]: failure({ code: 1, stderr: 'permission denied\n' }),
    [UP_KEY]: success('Container job-tool-postgres Started\n'),
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

describe('the container operations of the Start_Script (1.10)', () => {
  it.each(Object.entries(STEP_FOUR_BRANCHES))(
    'issues only the three permitted commands: %s',
    async (_branch, results) => {
      const run = createFakeCommandRunner(results);
      const { reporter } = createRecordingReporter(createReporter);
      let current = 0;

      await runPostgresContainerStep({
        run,
        reporter,
        env: {},
        now: () => current,
        sleep: (ms) => {
          current += ms;

          return Promise.resolve();
        },
      }).catch(() => undefined);

      expect(run.invocations.length).toBeGreaterThan(0);

      for (const key of run.keys()) {
        expect(PERMITTED_KEYS).toContain(key);
      }
    },
  );

  it('permits exactly three container commands, and only one of them starts anything', () => {
    expect(PERMITTED_KEYS).toStrictEqual([
      'docker info --format {{.ServerVersion}}',
      'docker compose ps --all --format json postgres',
      'docker compose up --detach --no-recreate postgres',
    ]);
    expect(COMPOSE_UP_COMMAND.args).toContain('--no-recreate');
  });

  it('brings up nothing when a container is already running and healthy', async () => {
    const run = createFakeCommandRunner(STEP_FOUR_BRANCHES['running and healthy, reused as it is']);
    const { reporter } = createRecordingReporter(createReporter);

    await runPostgresContainerStep({ run, reporter, env: {}, now: () => 0, sleep: () => {} });

    expect(run.keys()).not.toContain(UP_KEY);
    expect(
      decideContainerReadiness({
        kind: 'PRESENT',
        name: 'job-tool-postgres',
        state: 'running',
        health: 'healthy',
        status: null,
      }),
    ).toBe(CONTAINER_READINESS_DECISIONS.READY);
  });

  it('passes no container-removing argument anywhere in the Start_Script source', async () => {
    const files = await collectSourceFiles(SCRIPTS_ROOT);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, 'utf8');

      for (const argument of FORBIDDEN_ARGUMENTS) {
        expect(source, `${file} passes the container argument ${argument}`).not.toMatch(
          new RegExp(`['"]${argument.replace(/-/g, '\\-')}['"]`),
        );
      }
    }
  });
});
