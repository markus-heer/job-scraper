/**
 * Step 6: start the API_Service and wait until it answers (1.1, 1.2, 1.11).
 *
 * ## What proves the API_Service ready
 *
 * Its own `health` query. `apps/api/src/health/health.resolver.ts` exists for this and says so: it
 * answers the constant `ok`, and a constant is something a script can compare against. The probe is a
 * GraphQL POST rather than a plain GET of the port, because what step 7 needs is not a bound socket but
 * a mounted GraphQL layer with a built schema — a process that has bound the port and failed to build
 * its schema would pass a socket check and fail the Web_App's first query.
 *
 * `apps/api/src/main.ts` binds `127.0.0.1` only (1.16) and exports that host; the path is `GRAPHQL_PATH`
 * of `apps/api/src/graphql/schema-options.ts`. Both are restated here as constants because this file is
 * the plain ESM the Start_Script runs as and those are TypeScript, and the suite pins all three against
 * their source so a change there cannot pass unnoticed.
 *
 * ## Why step 6 compiles before it starts
 *
 * The API_Service runs as `node dist/main.js`: it is a Nest application compiled by `tsc`, and the
 * repository carries no TypeScript runtime to start it from source with. `dist/` is excluded from
 * version control, so on a fresh checkout there is nothing to start, and after a pull in step 1 there
 * is something *stale* to start, which is worse — the user would get yesterday's code with today's
 * database. So the build belongs to step 6, as a precondition of starting the service and not as an
 * eighth step (1.1 fixes seven). It runs through Turborepo, so a build that is already current is a
 * cache hit and costs about a second.
 *
 * The build is announced by no line of its own: 1.2 gives step 6 exactly one progress line, and this is
 * part of starting the service, the way the install of step 3 is part of checking the browser files.
 *
 * Requirements: 1.1, 1.2, 1.11, 1.16.
 */

import { extractFailureDetail } from './command-runner.mjs';
import { EXIT_CODES, StartStepError } from './errors.mjs';
import { runServiceStep } from './service-step.mjs';
import { apiServiceBuildFailedError } from './start.messages.mjs';
import { START_STEPS } from './steps.mjs';

/** The workspace package of the API_Service. */
export const API_PACKAGE = '@job-scraper/api';

/** The loopback interface the API_Service binds, as `API_HOST` in `apps/api/src/main.ts` (1.16). */
export const API_HOST = '127.0.0.1';

/** Where the GraphQL layer is mounted, as `GRAPHQL_PATH` in `apps/api/src/graphql/schema-options.ts`. */
export const GRAPHQL_PATH = '/graphql';

/** The value the `health` query answers with, as `HEALTH_OK` in `apps/api/src/health/health.resolver.ts`. */
export const HEALTH_OK = 'ok';

/** The readiness query. Smallest possible document: it proves the schema was built, nothing more. */
export const HEALTH_QUERY_BODY = JSON.stringify({ query: '{ health }' });

/**
 * Compiles the API_Service and everything it imports.
 *
 * Through Turborepo rather than `tsc` directly, so the workspace packages the API_Service depends on
 * are built first and an unchanged build is answered from the cache.
 */
export const API_BUILD_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze(['turbo', 'run', 'build', '--filter', API_PACKAGE]),
});

/**
 * Starts the API_Service.
 *
 * Through the package's own `start` script, so the one definition of how the API_Service runs stays in
 * `apps/api/package.json`. The process is stopped by signalling its process group, which is what
 * reaches the Node process behind the package manager (see `service-launcher.mjs`).
 */
export const API_SERVICE_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze(['--filter', API_PACKAGE, 'start']),
});

/**
 * The complete local URL of the GraphQL endpoint.
 *
 * @param {number | string} port
 * @returns {string}
 */
export function apiServiceUrl(port) {
  return `http://${API_HOST}:${String(port)}${GRAPHQL_PATH}`;
}

/**
 * Whether an answer to the readiness query proves the API_Service ready (1.11).
 *
 * Both halves are needed: another program on that port could answer 200 with anything, and the
 * API_Service itself answers 200 with a GraphQL error body while its schema is unusable. The value of
 * the `health` field is the only thing that rules both out.
 *
 * @param {import('./service-launcher.mjs').ProbeResult} result
 * @returns {boolean}
 */
export function isApiServiceReady(result) {
  if (!result.reached || result.status !== 200) {
    return false;
  }

  try {
    return JSON.parse(result.body)?.data?.health === HEALTH_OK;
  } catch {
    return false;
  }
}

/**
 * The service definition of step 6.
 *
 * @param {number} port
 * @returns {import('./service-step.mjs').ServiceDefinition}
 */
export function apiServiceDefinition(port) {
  return {
    step: START_STEPS.API_SERVICE,
    port,
    command: API_SERVICE_COMMAND,
    probeRequest: {
      url: apiServiceUrl(port),
      method: 'POST',
      body: HEALTH_QUERY_BODY,
      headers: { 'content-type': 'application/json' },
    },
    isReady: isApiServiceReady,
    notReadyCode: 'API_SERVICE_NOT_READY',
    notReadyExitCode: EXIT_CODES.API_SERVICE_NOT_READY,
    prepare: buildApiService,
  };
}

/**
 * Compiles the API_Service before it is started.
 *
 * @param {{ run: import('./command-runner.mjs').CommandRunner }} dependencies
 * @returns {Promise<void>}
 * @throws {StartStepError} When the compilation fails (1.1: step 7 may not begin).
 */
export async function buildApiService({ run }) {
  const result = await run(API_BUILD_COMMAND);

  if (result.ok) {
    return;
  }

  throw new StartStepError({
    message: 'The API_Service could not be compiled, so step 6 had nothing to start (1.1).',
    messageDe: apiServiceBuildFailedError({
      detail: extractFailureDetail(result),
      exitCode: result.code,
    }),
    code: 'API_SERVICE_BUILD_FAILED',
    exitCode: EXIT_CODES.API_SERVICE_BUILD_FAILED,
  });
}

/**
 * Runs step 6.
 *
 * @param {object} dependencies
 * @param {number} dependencies.apiPort The configured `API_PORT`, checked before step 1.
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./service-launcher.mjs').ServiceLauncher} dependencies.launch
 * @param {import('./service-launcher.mjs').ServiceProbe} dependencies.probe
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {import('./service-step.mjs').StartedService[]} dependencies.startedServices
 * @param {() => number} [dependencies.now]
 * @param {(ms: number) => Promise<void>} [dependencies.sleep]
 * @returns {Promise<{ outcome: string, handle: import('./service-launcher.mjs').ServiceHandle | null,
 *   waitedMs: number }>}
 * @throws {StartStepError} When the build fails or the readiness gate of 1.11 does not pass.
 */
export function runApiServiceStep({ apiPort, ...dependencies }) {
  return runServiceStep({ service: apiServiceDefinition(apiPort), ...dependencies });
}
