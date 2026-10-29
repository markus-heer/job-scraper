/**
 * What steps 6 and 7 have in common: the readiness gate of 1.11.
 *
 * 1.11 states one rule for the PostgreSQL container, the API_Service and the Web_App — ready within 60
 * seconds, checked at least every 2 seconds, otherwise skip the remaining steps and name the service
 * and the cause. The container differs in everything but the numbers, because it is asked through
 * Compose; the two services differ from each other in almost nothing. So the gate lives here once and
 * `api-step.mjs` and `web-step.mjs` only say what their service *is*: which command starts it, which
 * address proves it ready, which answer counts as ready.
 *
 * ## Telling an occupied port from an unreachable service
 *
 * 1.11 closes the list of causes to two, and the difference between them is not visible in an exit
 * code — both services exit with 1. It is visible in what they printed, so
 * {@link classifyServiceReadiness} is a pure function over one observation: did the address answer, is
 * the process still running, and what has it written. `isPortOccupiedOutput` in `service-launcher.mjs`
 * holds the two spellings Nest and Vite use for the same condition, tested against both.
 *
 * The order of that classification matters in one case: a service that *answers* is ready even if its
 * own child has exited with an occupied port. That is a start running while an earlier one still
 * serves, and the honest reading is that the service is up — which is why the pre-launch look exists
 * and why a found service is reused rather than reported as a conflict (1.10 by analogy).
 *
 * ## What happens to a service that is already running when a later step fails
 *
 * It is stopped. 1.11 says the remaining steps are skipped, and it says nothing about what to do with
 * the ones that already ran, so this is a decision: an API_Service left listening after a failed start
 * would (a) contradict the German message, which tells the user that nothing is running, (b) make the
 * *next* start report an occupied port for a problem the user never caused, and (c) leave a process the
 * user has no way to find. The exception is a service this start did not launch: a reused service keeps
 * running, because stopping something that was there first would be worse than leaving it.
 *
 * Requirements: 1.1, 1.2, 1.9, 1.11.
 */

import { extractOutputDetail } from './command-runner.mjs';
import { EXIT_CODES, StartStepError } from './errors.mjs';
import { SERVICE_OUTCOMES, SERVICE_READINESS_DECISIONS } from './outcomes.mjs';
import { pollUntilSettled, READINESS_INTERVAL_MS, READINESS_TIMEOUT_MS } from './readiness.mjs';
import { isPortOccupiedOutput } from './service-launcher.mjs';
import {
  serviceAlreadyRunningWarning,
  serviceNotReadyError,
  serviceStoppedError,
  shutdownRequestedWarning,
} from './start.messages.mjs';

/**
 * One of the two services the Start_Script serves.
 *
 * @typedef {object} ServiceDefinition
 * @property {import('./steps.mjs').StartStep} step
 * @property {number} port The configured port, read from the environment file (1.9, 1.11).
 * @property {import('./command-runner.mjs').CommandSpec} command What starts the service.
 * @property {{ url: string, method?: string, body?: string, headers?: Record<string, string> }}
 *   probeRequest The request that asks the service whether it accepts requests.
 * @property {(result: import('./service-launcher.mjs').ProbeResult) => boolean} isReady What counts as
 *   ready. Pure.
 * @property {number} notReadyExitCode The exit code of a failed gate (1.11).
 * @property {string} notReadyCode Stable English key of that failure.
 * @property {(dependencies: { run: import('./command-runner.mjs').CommandRunner }) => Promise<void>}
 *   [prepare] Anything the service needs before it can be started at all. Throws a
 *   {@link StartStepError} of its own. Runs after the progress line, like the install of step 2, and
 *   only when the service is actually going to be launched.
 */

/**
 * A service this start is responsible for.
 *
 * @typedef {object} StartedService
 * @property {ServiceDefinition} service
 * @property {import('./service-launcher.mjs').ServiceHandle} handle
 */

/**
 * What one look at a service says (1.11).
 *
 * @typedef {object} ServiceObservation
 * @property {boolean} ready Whether the address answered the way the service defines as ready.
 * @property {string} output Everything the process has printed so far.
 * @property {{ code: number | null, signal: string | null } | null} exited `null` while it runs.
 * @property {boolean} spawnFailed Whether the program could not be started at all.
 */

/**
 * What one observation of a service means (1.11).
 *
 * @param {ServiceObservation} observation
 * @returns {string} One of {@link SERVICE_READINESS_DECISIONS}, never `TIMED_OUT`.
 */
export function classifyServiceReadiness(observation) {
  if (observation.ready) {
    // Answering beats everything else: a process that exited while the address answers is a second
    // attempt next to a service that is already serving.
    return SERVICE_READINESS_DECISIONS.READY;
  }

  if (observation.spawnFailed) {
    return SERVICE_READINESS_DECISIONS.UNREACHABLE;
  }

  if (isPortOccupiedOutput(observation.output)) {
    return SERVICE_READINESS_DECISIONS.PORT_OCCUPIED;
  }

  if (observation.exited !== null) {
    return SERVICE_READINESS_DECISIONS.UNREACHABLE;
  }

  return SERVICE_READINESS_DECISIONS.WAIT;
}

/**
 * Asks a service once whether it accepts requests.
 *
 * @param {object} dependencies
 * @param {ServiceDefinition} dependencies.service
 * @param {import('./service-launcher.mjs').ServiceProbe} dependencies.probe
 * @returns {Promise<boolean>}
 */
export async function isServiceAnswering({ service, probe }) {
  return service.isReady(await probe(service.probeRequest));
}

/**
 * Runs one of the two service steps: one progress line, then the readiness gate of 1.11.
 *
 * @param {object} dependencies
 * @param {ServiceDefinition} dependencies.service
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./service-launcher.mjs').ServiceLauncher} dependencies.launch
 * @param {import('./service-launcher.mjs').ServiceProbe} dependencies.probe
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {StartedService[]} dependencies.startedServices Everything this start has launched, in the
 *   order it launched it. Appended to here and read by {@link stopStartedServices}.
 * @param {() => number} [dependencies.now]
 * @param {(ms: number) => Promise<void>} [dependencies.sleep]
 * @param {number} [dependencies.intervalMs]
 * @param {number} [dependencies.timeoutMs]
 * @returns {Promise<{ outcome: string, handle: import('./service-launcher.mjs').ServiceHandle | null,
 *   waitedMs: number }>}
 * @throws {StartStepError} When the service does not become ready (1.11).
 */
export async function runServiceStep({
  service,
  run,
  launch,
  probe,
  reporter,
  startedServices,
  now = () => Date.now(),
  sleep = defaultSleep,
  intervalMs = READINESS_INTERVAL_MS,
  timeoutMs = READINESS_TIMEOUT_MS,
}) {
  reporter.progress(service.step);

  // Before anything is prepared or launched: a service from an earlier start is already ready, and
  // compiling for a process that will not be started would only cost the user time.
  if (await isServiceAnswering({ service, probe })) {
    reporter.warn(serviceAlreadyRunningWarning(service));

    return { outcome: SERVICE_OUTCOMES.ALREADY_RUNNING, handle: null, waitedMs: 0 };
  }

  if (service.prepare !== undefined) {
    await service.prepare({ run });
  }

  const handle = launch(service.command);

  startedServices.push({ service, handle });

  const readiness = await pollUntilSettled({
    observe: async () => ({
      ready: await isServiceAnswering({ service, probe }),
      output: handle.output(),
      exited: handle.exit(),
      spawnFailed: handle.spawnFailed(),
    }),
    decide: classifyServiceReadiness,
    pendingDecision: SERVICE_READINESS_DECISIONS.WAIT,
    timedOutDecision: SERVICE_READINESS_DECISIONS.TIMED_OUT,
    now,
    sleep,
    intervalMs,
    timeoutMs,
  });

  if (readiness.decision !== SERVICE_READINESS_DECISIONS.READY) {
    const stopped = await stopStartedServices(startedServices);

    throw new StartStepError({
      message: `${service.step.id} did not become ready: ${readiness.decision} (1.11).`,
      messageDe: serviceNotReadyError({
        step: service.step,
        decision: readiness.decision,
        port: service.port,
        detail: extractOutputDetail(handle.output()),
        waitedMs: readiness.waitedMs,
        stoppedServices: stopped.length,
      }),
      code: service.notReadyCode,
      exitCode: service.notReadyExitCode,
    });
  }

  return { outcome: SERVICE_OUTCOMES.STARTED, handle, waitedMs: readiness.waitedMs };
}

/**
 * Stops everything this start launched, in the reverse order of launching.
 *
 * Reverse, because the Web_App proxies `/graphql` to the API_Service: ending the one that depends on
 * the other first is what keeps a shutdown free of failed requests. Services this start only *found*
 * are not in the list and are therefore left running.
 *
 * @param {StartedService[]} startedServices Emptied, so a second call stops nothing twice.
 * @returns {Promise<readonly StartedService[]>} What was stopped.
 */
export async function stopStartedServices(startedServices) {
  const stopping = startedServices.splice(0, startedServices.length).reverse();

  for (const started of stopping) {
    await started.handle.stop();
  }

  return stopping;
}

/**
 * Keeps the start alive for as long as the services it launched are running.
 *
 * Why the Start_Script does not simply end after step 7: the two services are its children. If it
 * returned, they would keep running without a parent, and the user — who is told only a URL — would
 * have no way to stop them and would hit an occupied port on the next start. So the start stays, and it
 * is the one thing that can end them: on a signal it stops them and ends with 0, and if one of them
 * ends on its own it stops the other and ends non-zero.
 *
 * @param {object} dependencies
 * @param {StartedService[]} dependencies.startedServices
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {(handler: () => void) => void} dependencies.registerSignal Hooks the stop request of the
 *   terminal. Injected, so the suite drives it without signalling its own process.
 * @returns {Promise<number>} The exit code of the Start_Script.
 */
export function superviseStartedServices({ startedServices, reporter, registerSignal }) {
  if (startedServices.length === 0) {
    // Everything was reused, so this start owns no process and has nothing to supervise.
    return Promise.resolve(EXIT_CODES.SUCCESS);
  }

  const supervised = [...startedServices];

  return new Promise((resolve) => {
    // Set before the first `await` of either path, because stopping one service makes the other one
    // exit: without it, a requested shutdown would report the services it just stopped as crashed.
    let endingAlready = false;

    const end = async (exitCode) => {
      if (endingAlready) {
        return;
      }

      endingAlready = true;
      await stopStartedServices(startedServices);
      resolve(exitCode);
    };

    registerSignal(() => {
      if (endingAlready) {
        return;
      }

      reporter.warn(shutdownRequestedWarning());
      void end(EXIT_CODES.SUCCESS);
    });

    for (const started of supervised) {
      void started.handle.whenExited().then((exit) => {
        if (endingAlready) {
          return;
        }

        reporter.error(
          serviceStoppedError({
            step: started.service.step,
            detail: extractOutputDetail(started.handle.output()),
            exitCode: exit.code,
          }),
        );

        void end(EXIT_CODES.SERVICE_STOPPED);
      });
    }
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
