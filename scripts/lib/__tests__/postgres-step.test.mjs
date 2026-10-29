/**
 * Step 4 of the Start_Script: the runtime probe of 1.13, the reuse rule of 1.10 and the readiness gate
 * of 1.1.
 *
 * {@link REAL_PS_OUTPUT} is the verbatim output of
 * `docker compose ps --all --format json postgres` for the running `job-tool-postgres` container of
 * this repository, taken with `String.raw` so the JSON escapes inside it survive. The parser keys on
 * those field names, so a recorded output is the only fixture that proves it reads them.
 *
 * Nothing here starts, stops or inspects a real container: every command goes through the injected fake
 * runner, and the waiting of the readiness gate goes through an injected clock, so the 60-second window
 * of 1.1 is asserted without the suite waiting a minute.
 */

import { describe, expect, it } from 'vitest';

import { EXIT_CODES, StartStepError } from '../errors.mjs';
import { CONTAINER_READINESS_DECISIONS, POSTGRES_CONTAINER_OUTCOMES } from '../outcomes.mjs';
import {
  COMPOSE_STATE_COMMAND,
  COMPOSE_UP_COMMAND,
  CONTAINER_READINESS_INTERVAL_MS,
  CONTAINER_READINESS_TIMEOUT_MS,
  decideContainerReadiness,
  DEFAULT_POSTGRES_PORT,
  derivePostgresEnvironment,
  DOCKER_RUNTIME_PROBE_COMMAND,
  isRuntimeReachable,
  parseComposeServiceState,
  runPostgresContainerStep,
  shouldKeepPolling,
} from '../postgres-step.mjs';
import { createReporter } from '../reporter.mjs';
import {
  commandKey,
  completeResult,
  createFakeCommandRunner,
  createRecordingReporter,
  failure,
  success,
} from './fake-command-runner.mjs';

const PROBE_KEY = commandKey(DOCKER_RUNTIME_PROBE_COMMAND);
const STATE_KEY = commandKey(COMPOSE_STATE_COMMAND);
const UP_KEY = commandKey(COMPOSE_UP_COMMAND);

/** The `DATABASE_URL` of `.env.example`, the single source of truth for the connection. */
const DATABASE_URL = 'postgresql://jobtool:change-me@127.0.0.1:55432/jobtool?schema=public';

/** Recorded from this repository's running container. */
const REAL_PS_OUTPUT =
  String.raw`{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-10-27 18:29:37 +0100 CET","ExitCode":0,"Health":"healthy","ID":"be7e6c672aff","Image":"postgres:16-alpine","LocalVolumes":"1","Mounts":"job-tool-postg…","Name":"job-tool-postgres","Names":"job-tool-postgres","Networks":"job-tool_default","Ports":"127.0.0.1:55432-\u003e5432/tcp","Project":"job-tool","Publishers":[{"URL":"127.0.0.1","TargetPort":5432,"PublishedPort":55432,"Protocol":"tcp"}],"RunningFor":"39 hours ago","Service":"postgres","Size":"0B","State":"running","Status":"Up 39 hours (healthy)"}` +
  '\n';

/**
 * A `docker compose ps` output with the given lifecycle and health state.
 *
 * @param {{ state?: string, health?: string, status?: string }} overrides
 * @returns {string}
 */
function psOutput({ state = 'running', health = 'healthy', status } = {}) {
  return `${JSON.stringify({
    Name: 'job-tool-postgres',
    Service: 'postgres',
    State: state,
    Health: health,
    Status: status ?? `Up 3 seconds (${health === '' ? 'no healthcheck' : health})`,
  })}\n`;
}

/** A clock whose only movement is the step's own waiting. */
function createFakeClock() {
  let current = 0;
  /** @type {number[]} */
  const sleeps = [];

  return {
    now: () => current,
    sleep: (ms) => {
      sleeps.push(ms);
      current += ms;

      return Promise.resolve();
    },
    sleeps,
  };
}

/** A state value as {@link parseComposeServiceState} produces it. */
function state(overrides) {
  return { kind: 'PRESENT', name: 'job-tool-postgres', state: 'running', health: '', ...overrides };
}

describe('derivePostgresEnvironment (1.10)', () => {
  it('derives port, user, password and database from DATABASE_URL', () => {
    expect(derivePostgresEnvironment(DATABASE_URL)).toStrictEqual({
      POSTGRES_PORT: '55432',
      POSTGRES_USER: 'jobtool',
      POSTGRES_PASSWORD: 'change-me',
      POSTGRES_DB: 'jobtool',
    });
  });

  it('falls back to the PostgreSQL default port when the connection string names none', () => {
    expect(
      derivePostgresEnvironment('postgresql://jobtool:change-me@127.0.0.1/jobtool').POSTGRES_PORT,
    ).toBe(String(DEFAULT_POSTGRES_PORT));
  });

  it('decodes a percent-encoded password', () => {
    expect(
      derivePostgresEnvironment('postgresql://jobtool:p%40ss%3Aword@127.0.0.1:55432/jobtool')
        .POSTGRES_PASSWORD,
    ).toBe('p@ss:word');
  });

  it('omits what the connection string does not carry, so the environment file keeps deciding', () => {
    expect(derivePostgresEnvironment('postgresql://127.0.0.1:55432/jobtool')).toStrictEqual({
      POSTGRES_PORT: '55432',
      POSTGRES_DB: 'jobtool',
    });
  });

  it('derives nothing from an absent, empty or unusable value', () => {
    expect(derivePostgresEnvironment(undefined)).toBeNull();
    expect(derivePostgresEnvironment('   ')).toBeNull();
    expect(derivePostgresEnvironment('bitte-hier-eintragen')).toBeNull();
    expect(derivePostgresEnvironment('mysql://jobtool@127.0.0.1:3306/jobtool')).toBeNull();
  });
});

describe('parseComposeServiceState', () => {
  it('reads the recorded output of the running container', () => {
    expect(parseComposeServiceState(REAL_PS_OUTPUT)).toStrictEqual({
      kind: 'PRESENT',
      name: 'job-tool-postgres',
      state: 'running',
      health: 'healthy',
      status: 'Up 39 hours (healthy)',
    });
  });

  it('reads the array form that other Compose versions print', () => {
    const asArray = `[${REAL_PS_OUTPUT.trim()}]`;

    expect(parseComposeServiceState(asArray).health).toBe('healthy');
  });

  it('reports no container when the output is empty', () => {
    expect(parseComposeServiceState('').kind).toBe('ABSENT');
    expect(parseComposeServiceState('[]').kind).toBe('ABSENT');
  });

  it('reports output it cannot read as unreadable rather than as an absent container', () => {
    const parsed = parseComposeServiceState('permission denied while trying to connect\n');

    expect(parsed.kind).toBe('UNREADABLE');
    expect(parsed.status).toBe('permission denied while trying to connect');
  });

  it('ignores an entry of another service', () => {
    const other = `${JSON.stringify({ Service: 'pgadmin', State: 'running', Health: 'healthy' })}\n`;

    expect(parseComposeServiceState(other).kind).toBe('ABSENT');
  });
});

describe('decideContainerReadiness (1.1)', () => {
  it('confirms a running container whose health check passes', () => {
    expect(decideContainerReadiness(state({ health: 'healthy' }))).toBe(
      CONTAINER_READINESS_DECISIONS.READY,
    );
  });

  it('confirms a running container that declares no health check', () => {
    expect(decideContainerReadiness(state({ health: '' }))).toBe(
      CONTAINER_READINESS_DECISIONS.READY,
    );
  });

  it('waits while the health check is still starting', () => {
    expect(decideContainerReadiness(state({ health: 'starting' }))).toBe(
      CONTAINER_READINESS_DECISIONS.WAIT,
    );
  });

  it('waits for a container that exists but has not started yet', () => {
    expect(decideContainerReadiness(state({ state: 'created' }))).toBe(
      CONTAINER_READINESS_DECISIONS.WAIT,
    );
    expect(decideContainerReadiness(state({ state: 'restarting' }))).toBe(
      CONTAINER_READINESS_DECISIONS.WAIT,
    );
  });

  it('does not wait out a container that reports its own check as failed', () => {
    expect(decideContainerReadiness(state({ health: 'unhealthy' }))).toBe(
      CONTAINER_READINESS_DECISIONS.UNHEALTHY,
    );
  });

  it('does not wait for a container that has ended', () => {
    expect(decideContainerReadiness(state({ state: 'exited' }))).toBe(
      CONTAINER_READINESS_DECISIONS.STOPPED,
    );
    expect(decideContainerReadiness(state({ state: 'dead' }))).toBe(
      CONTAINER_READINESS_DECISIONS.STOPPED,
    );
  });

  it('waits when there is nothing to read yet', () => {
    expect(decideContainerReadiness({ kind: 'ABSENT', state: '', health: '', status: null })).toBe(
      CONTAINER_READINESS_DECISIONS.WAIT,
    );
    expect(
      decideContainerReadiness({ kind: 'UNREADABLE', state: '', health: '', status: null }),
    ).toBe(CONTAINER_READINESS_DECISIONS.WAIT);
  });
});

describe('shouldKeepPolling (1.1)', () => {
  it('fits a look every 2 seconds into a window of 60 seconds', () => {
    expect(CONTAINER_READINESS_INTERVAL_MS).toBe(2_000);
    expect(CONTAINER_READINESS_TIMEOUT_MS).toBe(60_000);
    expect(shouldKeepPolling(0)).toBe(true);
    expect(
      shouldKeepPolling(CONTAINER_READINESS_TIMEOUT_MS - CONTAINER_READINESS_INTERVAL_MS),
    ).toBe(true);
    expect(shouldKeepPolling(CONTAINER_READINESS_TIMEOUT_MS)).toBe(false);
  });

  it('bounds the waiting at 31 looks, the last one exactly 60 seconds in', () => {
    let waited = 0;
    let looks = 1;

    while (shouldKeepPolling(waited)) {
      waited += CONTAINER_READINESS_INTERVAL_MS;
      looks += 1;
    }

    expect(looks).toBe(31);
    expect(waited).toBe(CONTAINER_READINESS_TIMEOUT_MS);
  });
});

describe('isRuntimeReachable (1.13)', () => {
  it('accepts a runtime that answers with a server version', () => {
    expect(
      isRuntimeReachable(completeResult(DOCKER_RUNTIME_PROBE_COMMAND, success('29.5.2\n'))),
    ).toBe(true);
  });

  it('rejects an answer without a server version, whatever the exit code says', () => {
    expect(isRuntimeReachable(completeResult(DOCKER_RUNTIME_PROBE_COMMAND, success('\n')))).toBe(
      false,
    );
  });

  it('rejects a runtime that could not be reached or is not installed', () => {
    expect(
      isRuntimeReachable(
        completeResult(
          DOCKER_RUNTIME_PROBE_COMMAND,
          failure({ code: 1, stderr: 'Cannot connect to the Docker daemon\n' }),
        ),
      ),
    ).toBe(false);
  });
});

describe('runPostgresContainerStep', () => {
  it('reuses a running container without creating or recreating one (1.10)', async () => {
    const run = createFakeCommandRunner({
      [PROBE_KEY]: success('29.5.2\n'),
      [STATE_KEY]: success(REAL_PS_OUTPUT),
    });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    const result = await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL },
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.outcome).toBe(POSTGRES_CONTAINER_OUTCOMES.REUSED);
    expect(run.keys()).toStrictEqual([PROBE_KEY, STATE_KEY]);
    expect(run.keys()).not.toContain(UP_KEY);
    expect(out).toStrictEqual([
      'Schritt 4 von 7: Datenbank starten oder eine laufende weiterverwenden …',
    ]);
    expect(errorLines).toHaveLength(0);
  });

  it('starts the container when none exists and waits for its health check (1.1)', async () => {
    const states = ['', psOutput({ health: 'starting' }), psOutput({ health: 'healthy' })];
    let stateRead = 0;
    const run = createFakeCommandRunner((spec) => {
      if (commandKey(spec) === STATE_KEY) {
        const output = states[Math.min(stateRead, states.length - 1)];
        stateRead += 1;

        return success(output);
      }

      return success(commandKey(spec) === PROBE_KEY ? '29.5.2\n' : 'Container Started\n');
    });
    const { reporter, out } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    const result = await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL },
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.outcome).toBe(POSTGRES_CONTAINER_OUTCOMES.STARTED);
    expect(run.keys()).toStrictEqual([PROBE_KEY, STATE_KEY, UP_KEY, STATE_KEY, STATE_KEY]);
    expect(clock.sleeps).toStrictEqual([CONTAINER_READINESS_INTERVAL_MS]);
    expect(result.waitedMs).toBe(CONTAINER_READINESS_INTERVAL_MS);
    expect(out).toHaveLength(1);
  });

  it('hands the port derived from DATABASE_URL to Compose through the child environment', async () => {
    const run = createFakeCommandRunner({
      [PROBE_KEY]: success('29.5.2\n'),
      [STATE_KEY]: success(REAL_PS_OUTPUT),
    });
    const { reporter } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL },
      now: clock.now,
      sleep: clock.sleep,
    });

    const stateCall = run.invocations.find((spec) => commandKey(spec) === STATE_KEY);

    expect(stateCall.env).toStrictEqual({
      POSTGRES_PORT: '55432',
      POSTGRES_USER: 'jobtool',
      POSTGRES_PASSWORD: 'change-me',
      POSTGRES_DB: 'jobtool',
    });
    // The program is always the first thing in a command: no `VAR=value docker …` anywhere.
    for (const spec of run.invocations) {
      expect(spec.command).toBe('docker');
      expect(spec.args.every((argument) => !/^[A-Z_]+=/.test(argument))).toBe(true);
    }
  });

  it('warns and passes no override when DATABASE_URL carries no usable port', async () => {
    const run = createFakeCommandRunner({
      [PROBE_KEY]: success('29.5.2\n'),
      [STATE_KEY]: success(REAL_PS_OUTPUT),
    });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL: 'bitte-hier-eintragen' },
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(out).toHaveLength(1);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('DATABASE_URL');
    expect(run.invocations.every((spec) => spec.env === undefined)).toBe(true);
  });

  it('stops before step 4 with a German instruction when the runtime is unreachable (1.13)', async () => {
    const run = createFakeCommandRunner({
      [PROBE_KEY]: failure({
        code: 1,
        stderr:
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      }),
    });
    const { reporter, out } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    const error = await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL },
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.exitCode).toBe(EXIT_CODES.CONTAINER_RUNTIME_UNREACHABLE);
    expect(error.exitCode).not.toBe(EXIT_CODES.SUCCESS);
    expect(error.messageDe).toContain('Container-Laufzeit ist nicht erreichbar');
    expect(error.messageDe).toContain('Docker starten');
    expect(error.messageDe).toContain('Cannot connect to the Docker daemon');
    // Step 4 never began: no progress line, and no container command was issued.
    expect(out).toHaveLength(0);
    expect(run.keys()).toStrictEqual([PROBE_KEY]);
  });

  it('treats a runtime that answers without a server version as unreachable (1.13)', async () => {
    const run = createFakeCommandRunner({ [PROBE_KEY]: success('\n') });
    const { reporter, out } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    const error = await runPostgresContainerStep({
      run,
      reporter,
      env: {},
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error.code).toBe('CONTAINER_RUNTIME_UNREACHABLE');
    expect(out).toHaveLength(0);
  });

  it('ends the start when the container can neither be started nor reused', async () => {
    const run = createFakeCommandRunner({
      [PROBE_KEY]: success('29.5.2\n'),
      [STATE_KEY]: success(''),
      [UP_KEY]: failure({
        code: 1,
        stderr:
          'Error response from daemon: Ports are not available: exposing port TCP 127.0.0.1:55432 -> 127.0.0.1:0: listen tcp 127.0.0.1:55432: bind: address already in use\n',
      }),
    });
    const { reporter } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    const error = await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL },
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error.exitCode).toBe(EXIT_CODES.POSTGRES_CONTAINER_FAILED);
    expect(error.messageDe).toContain('address already in use');
    expect(error.messageDe).toContain('Nächster Schritt:');
    expect(run.keys()).toStrictEqual([PROBE_KEY, STATE_KEY, UP_KEY]);
  });

  it('ends the start after 60 seconds when the container never reports itself ready (1.1)', async () => {
    const run = createFakeCommandRunner((spec) =>
      commandKey(spec) === STATE_KEY
        ? success(psOutput({ health: 'starting', status: 'Up 1 second (health: starting)' }))
        : success(commandKey(spec) === PROBE_KEY ? '29.5.2\n' : 'Container Started\n'),
    );
    const { reporter } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    const error = await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL },
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error.exitCode).toBe(EXIT_CODES.POSTGRES_CONTAINER_NOT_READY);
    expect(error.messageDe).toContain('nach 60 Sekunden nicht bereit');
    expect(error.messageDe).toContain('health: starting');
    expect(clock.sleeps).toHaveLength(30);
    expect(clock.now()).toBe(CONTAINER_READINESS_TIMEOUT_MS);
  });

  it('ends the start at once when the container reports its own check as failed (1.1)', async () => {
    const run = createFakeCommandRunner((spec) =>
      commandKey(spec) === STATE_KEY
        ? success(psOutput({ health: 'unhealthy' }))
        : success(commandKey(spec) === PROBE_KEY ? '29.5.2\n' : 'Container Started\n'),
    );
    const { reporter } = createRecordingReporter(createReporter);
    const clock = createFakeClock();

    const error = await runPostgresContainerStep({
      run,
      reporter,
      env: { DATABASE_URL },
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error.exitCode).toBe(EXIT_CODES.POSTGRES_CONTAINER_NOT_READY);
    expect(error.messageDe).toContain('dauerhaft als fehlgeschlagen');
    expect(clock.sleeps).toHaveLength(0);
  });
});
