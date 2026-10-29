/**
 * The order of the Start_Script: the seven steps of 1.1, and the exit code the start ends with.
 *
 * ## Why this is a module and not the body of `start.mjs`
 *
 * Everything the requirements state about *one* step lives in that step's module, and every one of
 * those is covered by the suite. What 1.1 states is about *all* of them, and it is not a property of
 * any single step: the fixed order, the rule that a step begins only after the preceding one is
 * confirmed ready, the switch of 1.8 that skips the first two, the configuration check that runs
 * before step 1 (1.15), the container runtime probe that runs before step 4 announces itself (1.13),
 * and the rule that a failed step means no later step runs (1.6, 1.7, 1.11, 1.14).
 *
 * As long as that lived in the top-level body of `start.mjs` next to `process.exit`, it was the one
 * part of the Start_Script no test could reach: importing the file would have run a start. So it is a
 * function here, it returns the exit code instead of ending the process, and every port it needs is a
 * parameter. `start.mjs` is what wires the real ports to it and exits.
 *
 * ## The exit code
 *
 * One `catch` and one table (`errors.mjs`): a {@link StartStepError} carries the German sentence and
 * the code that belongs to its cause, anything else is a defect of the Start_Script itself and ends
 * with {@link EXIT_CODES.UNEXPECTED}. A step that failed has therefore no say over the exit code
 * beyond the one it recorded in its error, and no step calls `process.exit`.
 *
 * Requirements: 1.1, 1.2, 1.6, 1.7, 1.8, 1.9, 1.11, 1.13, 1.14, 1.15.
 */

import { runApiServiceStep } from './api-step.mjs';
import { runBrowserBinaryStep } from './browser-step.mjs';
import { runDependencyInstallStep } from './dependency-step.mjs';
import { checkEnvironmentFile } from './env-check.mjs';
import { EXIT_CODES, StartStepError } from './errors.mjs';
import { runGitPullStep } from './git-step.mjs';
import { runPostgresContainerStep } from './postgres-step.mjs';
import { runPrismaMigrationStep } from './prisma-step.mjs';
import { stopStartedServices, superviseStartedServices } from './service-step.mjs';
import {
  offlineModeWarning,
  unexpectedFailureError,
  unknownArgumentWarning,
} from './start.messages.mjs';
import { parseStartOptions } from './start-options.mjs';
import { runWebAppStep } from './web-step.mjs';

/**
 * Runs the Start_Script from the first check to the exit code (1.1).
 *
 * @param {object} dependencies
 * @param {readonly string[]} dependencies.argv Everything after the script name (1.8).
 * @param {string} dependencies.repositoryRoot
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./service-launcher.mjs').ServiceLauncher} dependencies.launch
 * @param {import('./service-launcher.mjs').ServiceProbe} dependencies.probe
 * @param {(path: string) => boolean} dependencies.exists The browser-file check of step 3.
 * @param {(path: string) => string | null} dependencies.readText The declaration the configuration
 *   check reads the required keys out of.
 * @param {NodeJS.ProcessEnv} dependencies.env `pnpm start` runs Node with
 *   `--env-file-if-exists=.env`, so the keys of the local environment file are already in here.
 * @param {(handler: () => void) => void} dependencies.registerSignal Hooks the stop request of the
 *   terminal, for the supervision after step 7.
 * @param {() => number} [dependencies.now]
 * @param {(ms: number) => Promise<void>} [dependencies.sleep]
 * @returns {Promise<number>} The exit code of the Start_Script; one of {@link EXIT_CODES}.
 */
export async function runStart({
  argv,
  repositoryRoot,
  reporter,
  run,
  launch,
  probe,
  exists,
  readText,
  env,
  registerSignal,
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  /** Everything this start launched, so a later failure can end it again (1.11). */
  /** @type {import('./service-step.mjs').StartedService[]} */
  const startedServices = [];

  const dependencies = { run, launch, probe, reporter, startedServices, exists, env, now, sleep };
  const options = parseStartOptions(argv);

  try {
    if (options.unknownArguments.length > 0) {
      reporter.warn(unknownArgumentWarning(options.unknownArguments));
    }

    // Before step 1 on purpose (1.15): no service starts, and nothing is installed or downloaded,
    // while a required configuration value is missing.
    const { apiPort, webPort } = checkEnvironmentFile({ repositoryRoot, readText, env });

    // Sequential on purpose: 1.1 lets a step begin only after the preceding one is confirmed ready,
    // and each `await` is that confirmation.
    if (options.offline) {
      reporter.warn(offlineModeWarning());
    } else {
      await runGitPullStep(dependencies);
      await runDependencyInstallStep(dependencies);
    }

    await runBrowserBinaryStep(dependencies);
    await runPostgresContainerStep(dependencies);
    await runPrismaMigrationStep(dependencies);
    await runApiServiceStep({ ...dependencies, apiPort });
    await runWebAppStep({ ...dependencies, webPort });

    return await superviseStartedServices({ startedServices, reporter, registerSignal });
  } catch (error) {
    // 1.11 skips the remaining steps on a failed readiness gate; a service this start had already
    // launched is ended with it, so no process is left holding a port nobody can find. The step that
    // failed has usually done this already, and stopping an empty list is free.
    await stopStartedServices(startedServices);

    if (error instanceof StartStepError) {
      reporter.error(error.messageDe);

      return error.exitCode;
    }

    reporter.error(unexpectedFailureError(error instanceof Error ? error.message : String(error)));

    return EXIT_CODES.UNEXPECTED;
  }
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
