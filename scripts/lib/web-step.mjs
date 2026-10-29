/**
 * Step 7: serve the Web_App and print the address the user opens (1.1, 1.2, 1.9, 1.11).
 *
 * ## The URL, and where its two parts come from
 *
 * 1.9 asks for the *complete callable* local URL, "composed of host name and configured port", within 5
 * seconds of the Web_App accepting requests. So the line carries scheme, host and port and nothing the
 * user has to complete themselves.
 *
 * Neither part is invented here:
 *
 * - the port is `WEB_PORT` of the environment file. `apps/web/vite.config.ts` reads the same key out of
 *   the same file through `loadEnv`, so the script and the server cannot disagree about it. The check
 *   before step 1 is what guarantees it is a port number by the time this step runs (1.15);
 * - the host is the loopback interface, which that same configuration pins as `server.host`, together
 *   with `strictPort: true`. Those two belong together: without `strictPort` Vite would quietly move to
 *   the next free port, and the address printed here would be wrong while an occupied port would never
 *   be detected as one (1.11). The suite reads `vite.config.ts` and pins all three.
 *
 * The 5-second bound of 1.9 is kept by *when* the line is printed rather than by a timer: the gate looks
 * every 2 seconds, and the line is written the moment a look confirms the Web_App, with nothing awaited
 * in between. The worst case is therefore one poll interval plus one probe, both well inside 5 seconds,
 * and both numbers are facts the suite states.
 *
 * ## What proves the Web_App ready
 *
 * A plain GET of the address a user would open. The Vite dev server answers it with the HTML document
 * that loads the application, and that is exactly the claim 1.9 makes ("the Web_App accepts requests").
 * Nothing about the contents is asserted: the Web_App's own behaviour is the subject of Requirement 2
 * and of the E2E suite, not of a start script.
 *
 * Requirements: 1.1, 1.2, 1.9, 1.11, 1.16.
 */

import { EXIT_CODES } from './errors.mjs';
import { runServiceStep } from './service-step.mjs';
import { webAppReadyLine } from './start.messages.mjs';
import { START_STEPS } from './steps.mjs';

/** The workspace package of the Web_App. */
export const WEB_PACKAGE = '@job-scraper/web';

/** The loopback interface the dev server binds, as `server.host` in `apps/web/vite.config.ts` (1.16). */
export const WEB_APP_HOST = '127.0.0.1';

/**
 * Serves the Web_App.
 *
 * Through the package's own `dev` script, so `apps/web/package.json` stays the one definition of how
 * the Web_App is served. No `--port`: the port belongs to `vite.config.ts`, which reads it from the
 * same environment file this step reads, and passing it twice would create a second source of truth.
 */
export const WEB_APP_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze(['--filter', WEB_PACKAGE, 'dev']),
});

/**
 * The complete callable local URL of the Web_App (1.9).
 *
 * @param {number | string} port
 * @returns {string}
 */
export function webAppUrl(port) {
  return `http://${WEB_APP_HOST}:${String(port)}/`;
}

/**
 * Whether an answer proves the Web_App is accepting requests (1.9, 1.11).
 *
 * Any answer below 500 counts. A dev server that is up answers 200 for the document; a redirect or a
 * 404 would still prove a server that accepts requests, and a 5xx would not, because that is what Vite
 * answers while a transform of the entry module is failing.
 *
 * @param {import('./service-launcher.mjs').ProbeResult} result
 * @returns {boolean}
 */
export function isWebAppReady(result) {
  return result.reached && result.status !== null && result.status < 500;
}

/**
 * The service definition of step 7.
 *
 * @param {number} port
 * @returns {import('./service-step.mjs').ServiceDefinition}
 */
export function webAppDefinition(port) {
  return {
    step: START_STEPS.WEB_APP,
    port,
    command: WEB_APP_COMMAND,
    probeRequest: { url: webAppUrl(port) },
    isReady: isWebAppReady,
    notReadyCode: 'WEB_APP_NOT_READY',
    notReadyExitCode: EXIT_CODES.WEB_APP_NOT_READY,
  };
}

/**
 * Runs step 7, and prints the URL of 1.9 as soon as the gate confirms the Web_App.
 *
 * @param {object} dependencies
 * @param {number} dependencies.webPort The configured `WEB_PORT`, checked before step 1.
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./service-launcher.mjs').ServiceLauncher} dependencies.launch
 * @param {import('./service-launcher.mjs').ServiceProbe} dependencies.probe
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {import('./service-step.mjs').StartedService[]} dependencies.startedServices
 * @param {() => number} [dependencies.now]
 * @param {(ms: number) => Promise<void>} [dependencies.sleep]
 * @returns {Promise<{ outcome: string, handle: import('./service-launcher.mjs').ServiceHandle | null,
 *   waitedMs: number, url: string }>}
 * @throws {StartStepError} When the readiness gate of 1.11 does not pass.
 */
export async function runWebAppStep({ webPort, ...dependencies }) {
  const result = await runServiceStep({ service: webAppDefinition(webPort), ...dependencies });
  const url = webAppUrl(webPort);

  // Immediately, and before anything else is awaited: this is the 5-second promise of 1.9.
  dependencies.reporter.info(webAppReadyLine(url));

  return { ...result, url };
}
