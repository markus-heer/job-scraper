/**
 * The order of the Start_Script (1.1), and what the start ends with.
 *
 * Every other suite drives one step. This one drives the real sequence of all of them through
 * {@link runStart}, with the fakes of `fake-command-runner.mjs` behind every port, so the claims that
 * belong to no single step become assertable:
 *
 * - the seven steps run in the order 1.1 fixes, and each one begins only after the preceding one;
 * - the configuration check runs *before* step 1 (1.15), so an unfilled environment file costs no pull,
 *   no install and no download;
 * - the container runtime probe runs before step 4 *announces itself* (1.13);
 * - `--offline` skips steps 1 and 2 and begins with step 3 (1.8);
 * - a fatal step means no later step runs (1.6, 1.7, 1.11, 1.13, 1.14), while a failed step 1 is a
 *   warning the start continues past (1.3, 1.4);
 * - the exit code is the one the failure carried, and an unclassified failure ends with `UNEXPECTED`.
 *
 * Nothing here contacts a Git remote, installs anything, downloads a browser, starts a container,
 * applies a migration or brings up a server: the commands go through the fake runner, the services
 * through fake handles, the readiness requests through a fake probe, the waiting through a fake clock,
 * and the required-key declaration through injected text.
 */

import { describe, expect, it } from 'vitest';

import { API_BUILD_COMMAND, GRAPHQL_PATH } from '../api-step.mjs';
import { PLAYWRIGHT_PLAN_COMMAND } from '../browser-step.mjs';
import { PNPM_INSTALL_COMMAND } from '../dependency-step.mjs';
import { REQUIRED_ENV_KEY_SOURCE } from '../env-check.mjs';
import { EXIT_CODES } from '../errors.mjs';
import { GIT_PULL_COMMAND, GIT_STATUS_COMMAND } from '../git-step.mjs';
import {
  COMPOSE_STATE_COMMAND,
  COMPOSE_UP_COMMAND,
  DOCKER_RUNTIME_PROBE_COMMAND,
} from '../postgres-step.mjs';
import { PRISMA_MIGRATE_COMMAND } from '../prisma-step.mjs';
import { createReporter } from '../reporter.mjs';
import { runStart } from '../run-start.mjs';
import {
  answering,
  commandKey,
  createFakeClock,
  createFakeCommandRunner,
  createFakeProbe,
  createFakeServiceHandle,
  createFakeServiceLauncher,
  createRecordingReporter,
  failure,
  refused,
  success,
} from './fake-command-runner.mjs';
import {
  CHROMIUM_PLAN_LOCATIONS,
  CHROMIUM_PLAN_OUTPUT,
  createInstalledBrowserFiles,
} from './playwright-plan.fixture.mjs';
import { HEALTH_OK_BODY, VITE_PORT_OCCUPIED_OUTPUT } from './service-output.fixture.mjs';

const REPOSITORY_ROOT = '/repo';

/** The seven steps of 1.1, by the ids the Reporter records. */
const STEP_ORDER = [
  'GIT_PULL',
  'DEPENDENCY_INSTALL',
  'BROWSER_BINARIES',
  'POSTGRES_CONTAINER',
  'PRISMA_MIGRATIONS',
  'API_SERVICE',
  'WEB_APP',
];

/** The commands of a start in which every step succeeds, keyed by {@link commandKey}. */
const SUCCESSFUL_COMMANDS = {
  [commandKey(GIT_STATUS_COMMAND)]: success(''),
  [commandKey(GIT_PULL_COMMAND)]: success('Already up to date.\n'),
  [commandKey(PNPM_INSTALL_COMMAND)]: success('Done in 2.1s\n'),
  [commandKey(PLAYWRIGHT_PLAN_COMMAND)]: success(CHROMIUM_PLAN_OUTPUT),
  [commandKey(DOCKER_RUNTIME_PROBE_COMMAND)]: success('29.5.2\n'),
  [commandKey(COMPOSE_STATE_COMMAND)]: success(
    `${JSON.stringify({
      Name: 'job-tool-postgres',
      Service: 'postgres',
      State: 'running',
      Health: 'healthy',
      Status: 'running (healthy)',
    })}\n`,
  ),
  [commandKey(PRISMA_MIGRATE_COMMAND)]: success('No pending migrations to apply\n'),
  [commandKey(API_BUILD_COMMAND)]: success('api:build: cache hit, replaying logs\n'),
};

/** The order those commands are issued in when nothing fails and nothing has to be installed. */
const SUCCESSFUL_COMMAND_ORDER = [
  commandKey(GIT_STATUS_COMMAND),
  commandKey(GIT_PULL_COMMAND),
  commandKey(PNPM_INSTALL_COMMAND),
  commandKey(PLAYWRIGHT_PLAN_COMMAND),
  commandKey(DOCKER_RUNTIME_PROBE_COMMAND),
  commandKey(COMPOSE_STATE_COMMAND),
  commandKey(PRISMA_MIGRATE_COMMAND),
  commandKey(API_BUILD_COMMAND),
];

/** The declaration the configuration check reads the required keys out of (1.15). */
const ENV_SCHEMA_SOURCE = [
  'export const REQUIRED_ENV_KEYS = [',
  "  'DATABASE_URL',",
  "  'ANTHROPIC_API_KEY',",
  "  'API_PORT',",
  "  'WEB_PORT',",
  '] as const;',
].join('\n');

/** A complete environment file, as the keys arrive in `process.env`. */
const COMPLETE_ENV = Object.freeze({
  DATABASE_URL: 'postgresql://job:secret@127.0.0.1:55432/job_tool',
  ANTHROPIC_API_KEY: 'sk-ant-platzhalter',
  API_PORT: '4000',
  WEB_PORT: '5173',
});

/**
 * A probe that answers for each service as a service that comes up does: the look before launching is
 * refused, the first look of the readiness gate answers.
 *
 * @param {{ webAnswers?: boolean }} [behaviour]
 * @returns {ReturnType<typeof createFakeProbe>}
 */
function createOrchestrationProbe({ webAnswers = true } = {}) {
  const looks = { api: 0, web: 0 };

  return createFakeProbe((request) => {
    const kind = request.url.includes(GRAPHQL_PATH) ? 'api' : 'web';

    looks[kind] += 1;

    if (looks[kind] === 1) {
      return refused();
    }

    if (kind === 'api') {
      return answering(HEALTH_OK_BODY);
    }

    return webAnswers ? answering('<!doctype html>') : refused();
  });
}

/**
 * One start, wired to fakes.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function createStart(overrides = {}) {
  const { reporter, out, errorLines } = createRecordingReporter(createReporter);
  const run = createFakeCommandRunner({ ...SUCCESSFUL_COMMANDS, ...overrides.commands });
  const handles = overrides.handles ?? [createFakeServiceHandle(), createFakeServiceHandle()];
  const launch = createFakeServiceLauncher(handles);
  const probe = overrides.probe ?? createOrchestrationProbe();
  const clock = createFakeClock();
  /** @type {(() => void)[]} */
  const signalHandlers = [];

  const started = runStart({
    argv: overrides.argv ?? [],
    repositoryRoot: REPOSITORY_ROOT,
    reporter,
    run,
    launch,
    probe,
    exists: overrides.exists ?? createInstalledBrowserFiles(CHROMIUM_PLAN_LOCATIONS),
    readText:
      overrides.readText ??
      ((path) => (path.endsWith(REQUIRED_ENV_KEY_SOURCE) ? ENV_SCHEMA_SOURCE : null)),
    env: overrides.env ?? COMPLETE_ENV,
    registerSignal: (handler) => signalHandlers.push(handler),
    now: clock.now,
    sleep: clock.sleep,
  });

  return { started, reporter, out, errorLines, run, launch, handles, probe, clock, signalHandlers };
}

/**
 * Waits for a condition of the start that is still running, bounded and without real waiting of its
 * own: every fake answers immediately, so this only yields the event loop.
 *
 * @param {() => boolean} condition
 * @param {string} description
 * @returns {Promise<void>}
 */
async function waitFor(condition, description) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  throw new Error(`The start never reached this state: ${description}`);
}

describe('the order of the Start_Script (1.1)', () => {
  it('runs the seven steps in the fixed order and announces each exactly once', async () => {
    const start = createStart();

    await waitFor(() => start.signalHandlers.length === 1, 'the supervision after step 7');

    expect(start.reporter.announcedSteps()).toStrictEqual(STEP_ORDER);
    expect(start.run.keys()).toStrictEqual(SUCCESSFUL_COMMAND_ORDER);
    expect(start.out).toHaveLength(STEP_ORDER.length + 1);
    expect(start.out[start.out.length - 1]).toContain('http://127.0.0.1:5173/');
    expect(start.errorLines).toHaveLength(0);

    // Ctrl+C: both services end with the start, and the start ends successfully.
    start.signalHandlers[0]();

    expect(await start.started).toBe(EXIT_CODES.SUCCESS);
    expect(start.handles.map((handle) => handle.stopped())).toStrictEqual([1, 1]);
  });

  it('starts the API_Service before the Web_App and neither before the migrations', async () => {
    const start = createStart();

    await waitFor(() => start.signalHandlers.length === 1, 'the supervision after step 7');
    start.signalHandlers[0]();
    await start.started;

    const announced = start.reporter.announcedSteps();

    expect(announced.indexOf('PRISMA_MIGRATIONS')).toBeLessThan(announced.indexOf('API_SERVICE'));
    expect(announced.indexOf('API_SERVICE')).toBeLessThan(announced.indexOf('WEB_APP'));
    expect(start.launch.keys()).toStrictEqual([
      'pnpm --filter @job-scraper/api start',
      'pnpm --filter @job-scraper/web dev',
    ]);
  });

  it('checks the configuration before step 1 and runs no command at all when a key is missing', async () => {
    const start = createStart({ env: { ...COMPLETE_ENV, ANTHROPIC_API_KEY: '  ' } });

    expect(await start.started).toBe(EXIT_CODES.ENVIRONMENT_INCOMPLETE);
    expect(start.reporter.announcedSteps()).toStrictEqual([]);
    expect(start.run.invocations).toHaveLength(0);
    expect(start.launch.invocations).toHaveLength(0);
    expect(start.errorLines[0]).toContain('ANTHROPIC_API_KEY');
    expect(start.out).toHaveLength(0);
  });

  it('probes the container runtime before step 4 announces itself (1.13)', async () => {
    const start = createStart({
      commands: {
        [commandKey(DOCKER_RUNTIME_PROBE_COMMAND)]: failure({
          code: 1,
          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n',
        }),
      },
    });

    expect(await start.started).toBe(EXIT_CODES.CONTAINER_RUNTIME_UNREACHABLE);
    expect(start.reporter.announcedSteps()).toStrictEqual([
      'GIT_PULL',
      'DEPENDENCY_INSTALL',
      'BROWSER_BINARIES',
    ]);
    expect(start.run.keys()).not.toContain(commandKey(COMPOSE_STATE_COMMAND));
    expect(start.run.keys()).not.toContain(commandKey(COMPOSE_UP_COMMAND));
    expect(start.errorLines[0]).toContain('Container-Laufzeit');
  });

  it('runs none of the remaining steps after a failed install (1.6)', async () => {
    const start = createStart({
      commands: {
        [commandKey(PNPM_INSTALL_COMMAND)]: failure({
          code: 1,
          stderr: 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@job-scraper%2Fnope\n',
        }),
      },
    });

    expect(await start.started).toBe(EXIT_CODES.DEPENDENCY_INSTALL_FAILED);
    expect(start.reporter.announcedSteps()).toStrictEqual(['GIT_PULL', 'DEPENDENCY_INSTALL']);
    expect(start.run.keys()).toStrictEqual([
      commandKey(GIT_STATUS_COMMAND),
      commandKey(GIT_PULL_COMMAND),
      commandKey(PNPM_INSTALL_COMMAND),
    ]);
    expect(start.launch.invocations).toHaveLength(0);
    expect(start.errorLines[0]).toContain('ERR_PNPM_FETCH_404');
  });

  it('continues past a step 1 that did not update (1.3)', async () => {
    const start = createStart({
      commands: { [commandKey(GIT_STATUS_COMMAND)]: success(' M apps/api/src/main.ts\n') },
    });

    await waitFor(() => start.signalHandlers.length === 1, 'the supervision after step 7');
    start.signalHandlers[0]();

    expect(await start.started).toBe(EXIT_CODES.SUCCESS);
    expect(start.reporter.announcedSteps()).toStrictEqual(STEP_ORDER);
    expect(start.run.keys()).not.toContain(commandKey(GIT_PULL_COMMAND));
    expect(start.errorLines[0]).toContain('apps/api/src/main.ts (geändert)');
  });

  it('stops the API_Service it started when step 7 fails (1.11)', async () => {
    const apiHandle = createFakeServiceHandle();
    const webHandle = createFakeServiceHandle({
      output: VITE_PORT_OCCUPIED_OUTPUT,
      exitsWith: { code: 1, signal: null },
    });
    const start = createStart({
      handles: [apiHandle, webHandle],
      probe: createOrchestrationProbe({ webAnswers: false }),
    });

    expect(await start.started).toBe(EXIT_CODES.WEB_APP_NOT_READY);
    expect(start.reporter.announcedSteps()).toStrictEqual(STEP_ORDER);
    expect(apiHandle.stopped()).toBe(1);
    expect(webHandle.stopped()).toBe(1);
    expect(start.errorLines[start.errorLines.length - 1]).toContain('Port 5173 ist belegt');
  });

  it('ends with the unexpected code when a failure no step classified arrives', async () => {
    const start = createStart({
      readText: () => {
        throw new TypeError('readText received a path it cannot handle');
      },
    });

    expect(await start.started).toBe(EXIT_CODES.UNEXPECTED);
    expect(start.reporter.announcedSteps()).toStrictEqual([]);
    expect(start.errorLines[0]).toContain('unerwarteten Fehler');
    expect(start.errorLines[0]).toContain('readText received a path it cannot handle');
  });
});

describe('the offline switch (1.8)', () => {
  it('skips steps 1 and 2 and begins with step 3', async () => {
    const start = createStart({ argv: ['--offline'] });

    await waitFor(() => start.signalHandlers.length === 1, 'the supervision after step 7');

    expect(start.reporter.announcedSteps()).toStrictEqual(STEP_ORDER.slice(2));
    expect(start.run.keys()).toStrictEqual(SUCCESSFUL_COMMAND_ORDER.slice(3));
    expect(start.out[0]).toContain('Schritt 3 von 7');
    expect(start.errorLines[0]).toContain('--offline');

    start.signalHandlers[0]();

    expect(await start.started).toBe(EXIT_CODES.SUCCESS);
  });

  it('skips nothing for an argument it does not understand, and says so', async () => {
    const start = createStart({ argv: ['--ofline'] });

    await waitFor(() => start.signalHandlers.length === 1, 'the supervision after step 7');

    expect(start.errorLines[0]).toContain('--ofline');
    expect(start.reporter.announcedSteps()).toStrictEqual(STEP_ORDER);

    start.signalHandlers[0]();

    expect(await start.started).toBe(EXIT_CODES.SUCCESS);
  });
});
