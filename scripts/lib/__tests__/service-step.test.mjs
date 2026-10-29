/**
 * Steps 6 and 7 of the Start_Script: the readiness gates of 1.11, the address of 1.9 and what happens to
 * a started service when a later step fails.
 *
 * Nothing here starts an API_Service, a Vite server, a socket or a container: the commands go through
 * the fake runner, the services through fake handles, the readiness requests through a fake probe and
 * the waiting through an injected clock. The port-occupied branch is driven with the real output of both
 * services (`service-output.fixture.mjs`), because that is the only thing that tells it apart from an
 * unreachable one.
 */

import { describe, expect, it } from 'vitest';

import {
  API_BUILD_COMMAND,
  API_SERVICE_COMMAND,
  apiServiceUrl,
  GRAPHQL_PATH,
  HEALTH_OK,
  isApiServiceReady,
  runApiServiceStep,
} from '../api-step.mjs';
import { EXIT_CODES, StartStepError } from '../errors.mjs';
import { SERVICE_OUTCOMES, SERVICE_READINESS_DECISIONS } from '../outcomes.mjs';
import { READINESS_INTERVAL_MS, READINESS_TIMEOUT_MS } from '../readiness.mjs';
import { createReporter } from '../reporter.mjs';
import { SERVICE_PROBE_TIMEOUT_MS } from '../service-launcher.mjs';
import {
  classifyServiceReadiness,
  stopStartedServices,
  superviseStartedServices,
} from '../service-step.mjs';
import { START_STEPS } from '../steps.mjs';
import { isWebAppReady, runWebAppStep, WEB_APP_COMMAND, webAppUrl } from '../web-step.mjs';
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
  HEALTH_OK_BODY,
  MISSING_BUILD_OUTPUT,
  NEST_PORT_OCCUPIED_OUTPUT,
  VITE_PORT_OCCUPIED_OUTPUT,
} from './service-output.fixture.mjs';

const BUILD_KEY = commandKey(API_BUILD_COMMAND);
const API_PORT = 4000;
const WEB_PORT = 5173;

/** The 5 seconds 1.9 allows between the Web_App accepting requests and the printed address. */
const URL_DEADLINE_MS = 5_000;

/** The commands step 6 issues before it launches anything. */
const buildSucceeds = { [BUILD_KEY]: success('api:build: cache hit, replaying logs\n') };

/** One observation as the readiness gate assembles it. */
function observation(overrides) {
  return { ready: false, output: '', exited: null, spawnFailed: false, ...overrides };
}

describe('classifyServiceReadiness (1.11)', () => {
  it('confirms a service that answers its own address', () => {
    expect(classifyServiceReadiness(observation({ ready: true }))).toBe(
      SERVICE_READINESS_DECISIONS.READY,
    );
  });

  it('waits while a service is still starting and has printed nothing alarming', () => {
    expect(
      classifyServiceReadiness(observation({ output: 'Nest application successfully started' })),
    ).toBe(SERVICE_READINESS_DECISIONS.WAIT);
  });

  it('reads the occupied port out of what Nest printed', () => {
    expect(
      classifyServiceReadiness(
        observation({ output: NEST_PORT_OCCUPIED_OUTPUT, exited: { code: 1, signal: null } }),
      ),
    ).toBe(SERVICE_READINESS_DECISIONS.PORT_OCCUPIED);
  });

  it('reads the occupied port out of what Vite printed, which names no error code', () => {
    expect(
      classifyServiceReadiness(
        observation({ output: VITE_PORT_OCCUPIED_OUTPUT, exited: { code: 1, signal: null } }),
      ),
    ).toBe(SERVICE_READINESS_DECISIONS.PORT_OCCUPIED);
  });

  it('calls a service that ended for another reason unreachable', () => {
    expect(
      classifyServiceReadiness(
        observation({ output: MISSING_BUILD_OUTPUT, exited: { code: 1, signal: null } }),
      ),
    ).toBe(SERVICE_READINESS_DECISIONS.UNREACHABLE);
  });

  it('calls a program that could not be started at all unreachable', () => {
    expect(classifyServiceReadiness(observation({ spawnFailed: true }))).toBe(
      SERVICE_READINESS_DECISIONS.UNREACHABLE,
    );
  });

  it('prefers an answering address over its own exited child', () => {
    // A second start next to one that is already serving: the child cannot have the port, and the
    // service is nevertheless up.
    expect(
      classifyServiceReadiness(
        observation({
          ready: true,
          output: NEST_PORT_OCCUPIED_OUTPUT,
          exited: { code: 1, signal: null },
        }),
      ),
    ).toBe(SERVICE_READINESS_DECISIONS.READY);
  });
});

describe('isApiServiceReady (1.11)', () => {
  it('accepts the answer of the health query', () => {
    expect(isApiServiceReady(answering(HEALTH_OK_BODY))).toBe(true);
    expect(HEALTH_OK_BODY).toContain(HEALTH_OK);
  });

  it('refuses an answer from something else on that port', () => {
    expect(isApiServiceReady(answering('<html>nginx</html>'))).toBe(false);
    expect(isApiServiceReady(answering('{"errors":[{"message":"Cannot query health"}]}'))).toBe(
      false,
    );
    expect(isApiServiceReady(answering(HEALTH_OK_BODY, 503))).toBe(false);
    expect(isApiServiceReady(refused())).toBe(false);
  });
});

describe('isWebAppReady (1.9, 1.11)', () => {
  it('accepts any answer that proves a server is taking requests', () => {
    expect(isWebAppReady(answering('<!doctype html>'))).toBe(true);
    expect(isWebAppReady(answering('', 404))).toBe(true);
  });

  it('refuses a refused connection and a server that is failing', () => {
    expect(isWebAppReady(refused())).toBe(false);
    expect(isWebAppReady(answering('transform failed', 500))).toBe(false);
  });
});

describe('runApiServiceStep (1.1, 1.2, 1.11)', () => {
  it('builds, starts and confirms the API_Service with one progress line', async () => {
    const handle = createFakeServiceHandle();
    const launch = createFakeServiceLauncher([handle]);
    const probe = createFakeProbe([refused(), answering(HEALTH_OK_BODY)]);
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);
    const clock = createFakeClock();
    const startedServices = [];

    const result = await runApiServiceStep({
      apiPort: API_PORT,
      run: createFakeCommandRunner(buildSucceeds),
      launch,
      probe,
      reporter,
      startedServices,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.outcome).toBe(SERVICE_OUTCOMES.STARTED);
    expect(launch.keys()).toStrictEqual([commandKey(API_SERVICE_COMMAND)]);
    expect(out).toStrictEqual(['Schritt 6 von 7: Dienst für Suche und Daten starten …']);
    expect(errorLines).toHaveLength(0);
    expect(startedServices).toHaveLength(1);
    expect(probe.requests[0]).toMatchObject({
      url: `http://127.0.0.1:${String(API_PORT)}${GRAPHQL_PATH}`,
      method: 'POST',
    });
  });

  it('ends the start when the API_Service cannot be built, without launching anything', async () => {
    const launch = createFakeServiceLauncher([]);
    const { reporter } = createRecordingReporter(createReporter);
    const startedServices = [];

    const error = await runApiServiceStep({
      apiPort: API_PORT,
      run: createFakeCommandRunner({
        [BUILD_KEY]: failure({ code: 1, stderr: 'error TS2554: Expected 1 argument\n' }),
      }),
      launch,
      probe: createFakeProbe([refused()]),
      reporter,
      startedServices,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.exitCode).toBe(EXIT_CODES.API_SERVICE_BUILD_FAILED);
    expect(error.messageDe).toContain('error TS2554: Expected 1 argument');
    expect(launch.invocations).toHaveLength(0);
    expect(startedServices).toHaveLength(0);
  });

  it('names the occupied port and stops what it launched (1.11)', async () => {
    const handle = createFakeServiceHandle({
      output: NEST_PORT_OCCUPIED_OUTPUT,
      exitsWith: { code: 1, signal: null },
    });
    const clock = createFakeClock();
    const { reporter } = createRecordingReporter(createReporter);
    const startedServices = [];

    const error = await runApiServiceStep({
      apiPort: API_PORT,
      run: createFakeCommandRunner(buildSucceeds),
      launch: createFakeServiceLauncher([handle]),
      probe: createFakeProbe([refused()]),
      reporter,
      startedServices,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.code).toBe('API_SERVICE_NOT_READY');
    expect(error.exitCode).toBe(EXIT_CODES.API_SERVICE_NOT_READY);
    expect(error.messageDe).toContain('Port 4000 ist belegt');
    expect(error.messageDe).toContain('Der Dienst für Suche und Daten (API_Service)');
    expect(error.messageDe).toContain('EADDRINUSE');
    expect(handle.stopped()).toBe(1);
    expect(startedServices).toHaveLength(0);
    // Not waited out: an occupied port will not free itself inside the window.
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('gives a slow service the full window of 1.11 and then gives up', async () => {
    const handle = createFakeServiceHandle();
    const clock = createFakeClock();
    const { reporter } = createRecordingReporter(createReporter);
    const startedServices = [];

    const error = await runApiServiceStep({
      apiPort: API_PORT,
      run: createFakeCommandRunner(buildSucceeds),
      launch: createFakeServiceLauncher([handle]),
      probe: createFakeProbe([refused('connect ECONNREFUSED 127.0.0.1:4000')]),
      reporter,
      startedServices,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error.messageDe).toContain('nach 60 Sekunden nicht bereit');
    expect(error.messageDe).toContain('nicht erreichbar');
    expect(clock.sleeps).toHaveLength(30);
    expect(clock.sleeps.every((ms) => ms === READINESS_INTERVAL_MS)).toBe(true);
    expect(clock.now()).toBe(READINESS_TIMEOUT_MS);
    expect(handle.stopped()).toBe(1);
  });

  it('reuses an API_Service from an earlier start instead of starting a second one', async () => {
    const launch = createFakeServiceLauncher([]);
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);
    const startedServices = [];

    const result = await runApiServiceStep({
      apiPort: API_PORT,
      run: createFakeCommandRunner(buildSucceeds),
      launch,
      probe: createFakeProbe([answering(HEALTH_OK_BODY)]),
      reporter,
      startedServices,
    });

    expect(result.outcome).toBe(SERVICE_OUTCOMES.ALREADY_RUNNING);
    expect(result.handle).toBeNull();
    expect(launch.invocations).toHaveLength(0);
    expect(startedServices).toHaveLength(0);
    expect(out).toHaveLength(1);
    expect(errorLines[0]).toContain('antwortet bereits auf Port 4000');
  });
});

describe('runWebAppStep (1.1, 1.9, 1.11)', () => {
  it('prints the complete callable address as soon as the Web_App answers (1.9)', async () => {
    const handle = createFakeServiceHandle();
    const clock = createFakeClock();
    /** @type {{ line: string, at: number }[]} */
    const out = [];
    const reporter = createReporter({
      writeOut: (line) => out.push({ line, at: clock.now() }),
      writeError: () => undefined,
    });
    const startedServices = [];

    const result = await runWebAppStep({
      webPort: WEB_PORT,
      run: createFakeCommandRunner({}),
      launch: createFakeServiceLauncher([handle]),
      // The first refusal is the look before launching, the second is the first look of the gate.
      probe: createFakeProbe([refused(), refused(), answering('<!doctype html>')]),
      reporter,
      startedServices,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.url).toBe('http://127.0.0.1:5173/');
    expect(out.map(({ line }) => line)).toStrictEqual([
      'Schritt 7 von 7: Oberfläche bereitstellen …',
      'Fertig: Die Oberfläche ist unter http://127.0.0.1:5173/ erreichbar. Diese Adresse im Browser öffnen.',
    ]);
    // The two halves of the 5-second promise of 1.9: the line is written at the clock time of the
    // look that confirmed the Web_App (nothing is awaited in between), and the longest a confirming
    // look can arrive after the Web_App started answering is one interval plus one probe.
    expect(out[1].at).toBe(result.waitedMs);
    expect(result.waitedMs).toBe(READINESS_INTERVAL_MS);
    expect(READINESS_INTERVAL_MS + SERVICE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(URL_DEADLINE_MS);
  });

  it('serves the Web_App through its own package script, with no port of its own', () => {
    expect(commandKey(WEB_APP_COMMAND)).toBe('pnpm --filter @job-scraper/web dev');
    expect(WEB_APP_COMMAND.args).not.toContain('--port');
  });

  it('names the Web_App and its occupied port, and stops the API_Service with it (1.11)', async () => {
    const apiHandle = createFakeServiceHandle();
    const webHandle = createFakeServiceHandle({
      output: VITE_PORT_OCCUPIED_OUTPUT,
      exitsWith: { code: 1, signal: null },
    });
    const clock = createFakeClock();
    const { reporter } = createRecordingReporter(createReporter);
    const startedServices = [{ service: { step: START_STEPS.API_SERVICE }, handle: apiHandle }];

    const error = await runWebAppStep({
      webPort: WEB_PORT,
      run: createFakeCommandRunner({}),
      launch: createFakeServiceLauncher([webHandle]),
      probe: createFakeProbe([refused()]),
      reporter,
      startedServices,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((caught) => caught);

    expect(error.exitCode).toBe(EXIT_CODES.WEB_APP_NOT_READY);
    expect(error.messageDe).toContain('Die Oberfläche (Web_App)');
    expect(error.messageDe).toContain('Port 5173 ist belegt');
    expect(error.messageDe).toContain('bereits gestartete Programme wurden wieder beendet');
    // Both are stopped, and the Web_App before the API_Service it talks to.
    expect(webHandle.stopped()).toBe(1);
    expect(apiHandle.stopped()).toBe(1);
    expect(startedServices).toHaveLength(0);
  });
});

describe('stopStartedServices', () => {
  it('stops in the reverse order of starting and empties the list', async () => {
    /** @type {string[]} */
    const order = [];
    const startedServices = [START_STEPS.API_SERVICE, START_STEPS.WEB_APP].map((step) => {
      const handle = createFakeServiceHandle();
      const stop = handle.stop;

      return {
        service: { step },
        handle: {
          ...handle,
          stop: () => {
            order.push(step.id);

            return stop();
          },
        },
      };
    });

    const stopped = await stopStartedServices(startedServices);

    expect(order).toStrictEqual(['WEB_APP', 'API_SERVICE']);
    expect(stopped).toHaveLength(2);
    expect(startedServices).toHaveLength(0);
    expect(await stopStartedServices(startedServices)).toHaveLength(0);
  });
});

describe('superviseStartedServices', () => {
  it('stops both services on a stop request and ends successfully', async () => {
    const apiHandle = createFakeServiceHandle();
    const webHandle = createFakeServiceHandle();
    const { reporter, errorLines } = createRecordingReporter(createReporter);
    const startedServices = [
      { service: { step: START_STEPS.API_SERVICE }, handle: apiHandle },
      { service: { step: START_STEPS.WEB_APP }, handle: webHandle },
    ];
    /** @type {(() => void)[]} */
    const handlers = [];

    const supervising = superviseStartedServices({
      startedServices,
      reporter,
      registerSignal: (handler) => handlers.push(handler),
    });

    handlers[0]();

    expect(await supervising).toBe(EXIT_CODES.SUCCESS);
    expect(apiHandle.stopped()).toBe(1);
    expect(webHandle.stopped()).toBe(1);
    // The requested shutdown is a hint, and the services it stopped are not reported as crashed.
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('Der Start wird beendet');
  });

  it('ends non-zero and stops the other service when one dies on its own', async () => {
    const apiHandle = createFakeServiceHandle();
    const webHandle = createFakeServiceHandle();
    const { reporter, errorLines } = createRecordingReporter(createReporter);

    const supervising = superviseStartedServices({
      startedServices: [
        { service: { step: START_STEPS.API_SERVICE }, handle: apiHandle },
        { service: { step: START_STEPS.WEB_APP }, handle: webHandle },
      ],
      reporter,
      registerSignal: () => undefined,
    });

    apiHandle.simulate({
      output: 'Error: connect ECONNREFUSED 127.0.0.1:55432',
      exitsWith: { code: 1, signal: null },
    });

    expect(await supervising).toBe(EXIT_CODES.SERVICE_STOPPED);
    expect(webHandle.stopped()).toBe(1);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('hat sich nach dem Start beendet');
    expect(errorLines[0]).toContain('ECONNREFUSED');
  });

  it('has nothing to supervise when both services were reused', async () => {
    const { reporter } = createRecordingReporter(createReporter);

    expect(
      await superviseStartedServices({
        startedServices: [],
        reporter,
        registerSignal: () => undefined,
      }),
    ).toBe(EXIT_CODES.SUCCESS);
  });
});

describe('the addresses of the two services', () => {
  it('composes both from the loopback host and the configured port (1.9)', () => {
    expect(apiServiceUrl(API_PORT)).toBe('http://127.0.0.1:4000/graphql');
    expect(webAppUrl(WEB_PORT)).toBe('http://127.0.0.1:5173/');
  });
});
