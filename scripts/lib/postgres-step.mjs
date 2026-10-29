/**
 * Step 4: start the PostgreSQL container or reuse a running one (1.1, 1.10, 1.13).
 *
 * ## Why the runtime probe is not a step of its own
 *
 * 1.13 asks for a probe of the container runtime *before* step 4, and 1.1 fixes exactly seven steps.
 * So the probe is the precondition of step 4 and not an eighth step: it runs inside this module, before
 * {@link Reporter.progress} announces step 4. That ordering is the whole point. A step that has printed
 * "Schritt 4 von 7 …" has begun, and 1.13 wants the start to stop *before* it begins, so the probe must
 * not be preceded by a progress line — and it must not print one of its own either, because 1.2 allows
 * exactly one line per step and the step table in `steps.mjs` has no entry a probe could claim.
 *
 * The probe is `docker info`, and its result is read through {@link isRuntimeReachable} rather than
 * through the exit code alone: with `--format` the Docker CLI can answer an unreachable daemon with an
 * empty rendering, so an empty output counts as unreachable just like a non-zero exit.
 *
 * ## Reuse without a second container (1.10)
 *
 * Three independent things guarantee this, and none of them is this module being careful:
 *
 * - `docker-compose.yml` fixes `container_name: job-tool-postgres` inside the Compose project
 *   `job-tool`. A second container of that name cannot exist;
 * - the state of the service is read *first* (`docker compose ps --all`). A container that is already
 *   running and healthy is used as it is, and no `up` runs at all;
 * - where an `up` does run, it runs with `--no-recreate`, so Compose starts an existing container
 *   instead of replacing it even when the Compose file has changed since it was created.
 *
 * Stored data is untouched in every branch: there is no `down`, no `--force-recreate`, no `--volumes`
 * and no `rm` in this module, and the data lives in the named volume `job-tool-postgres-data` which
 * outlives the container anyway.
 *
 * ## The port, and where it comes from
 *
 * `DATABASE_URL` is the single source of truth for the connection (see `.env.example`), so the host
 * port Compose binds is *derived* from it by {@link derivePostgresEnvironment} and handed to the child
 * through the runner's `env` option — never as a `VAR=value docker …` prefix, which the project rule
 * forbids and which no shell would parse here anyway, since the runner spawns without one. The same
 * derivation covers user, password and database name, because those three decide what PostgreSQL
 * initialises on a *fresh* volume: taking them from anywhere other than `DATABASE_URL` would create a
 * Posting_Store the API_Service cannot log into.
 *
 * ## The readiness gate
 *
 * 1.1 lets step 5 begin only after step 4 is confirmed ready, and the only thing that confirms a
 * database is ready is its own health check. {@link decideContainerReadiness} turns one look at the
 * container state into one decision, and the waiting around it belongs to `readiness.mjs`, which steps
 * 6 and 7 use as well: 1.11 gives all three the same interval and the same window, so there is one
 * loop and one place where the off-by-one of "how many looks fit into 60 seconds" is decided. The
 * clock is injected, so the Vitest suite drives every branch without a container and without waiting.
 *
 * Requirements: 1.1, 1.2, 1.10, 1.13.
 */

import { extractFailureDetail } from './command-runner.mjs';
import { EXIT_CODES, StartStepError } from './errors.mjs';
import { CONTAINER_READINESS_DECISIONS, POSTGRES_CONTAINER_OUTCOMES } from './outcomes.mjs';
import { pollUntilSettled, READINESS_INTERVAL_MS, READINESS_TIMEOUT_MS } from './readiness.mjs';
import {
  containerRuntimeUnreachableError,
  databaseUrlUnusableWarning,
  postgresContainerFailedError,
  postgresContainerNotReadyError,
} from './start.messages.mjs';
import { START_STEPS } from './steps.mjs';

export { shouldKeepPolling } from './readiness.mjs';

/** The service of `docker-compose.yml` this step brings up. */
export const COMPOSE_SERVICE_NAME = 'postgres';

/** Host port of the Posting_Store when `DATABASE_URL` names none. The PostgreSQL default. */
export const DEFAULT_POSTGRES_PORT = 5432;

/**
 * How long the runtime probe and a state read may take.
 *
 * A Docker CLI whose daemon socket exists but answers nothing can sit in a read for minutes, and the
 * start must not hang before step 4 of 7. A killed probe counts as unreachable, which is what a daemon
 * that does not answer is.
 */
export const DOCKER_PROBE_TIMEOUT_MS = 20_000;

/** Probes the container runtime (1.13). Reads state only; starts and changes nothing. */
export const DOCKER_RUNTIME_PROBE_COMMAND = Object.freeze({
  command: 'docker',
  args: Object.freeze(['info', '--format', '{{.ServerVersion}}']),
  timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
});

/**
 * Reads the state of the one service. `--all` so a container that exists but has exited is seen as
 * existing — that is the difference between reusing one and creating one (1.10).
 */
export const COMPOSE_STATE_COMMAND = Object.freeze({
  command: 'docker',
  args: Object.freeze(['compose', 'ps', '--all', '--format', 'json', COMPOSE_SERVICE_NAME]),
  timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
});

/**
 * Starts the service, or starts the existing container of that name.
 *
 * `--no-recreate` is the guarantee of 1.10 that no second container appears and that the existing one
 * is not replaced. No timeout: the first start on a machine without the `postgres:16-alpine` image has
 * to pull it, and a killed pull would leave half an image behind — the same reasoning as for the
 * install of step 2.
 */
export const COMPOSE_UP_COMMAND = Object.freeze({
  command: 'docker',
  args: Object.freeze(['compose', 'up', '--detach', '--no-recreate', COMPOSE_SERVICE_NAME]),
});

/** The complete Docker vocabulary of the Start_Script. Nothing here removes a container or a volume. */
export const PERMITTED_DOCKER_COMMANDS = Object.freeze([
  DOCKER_RUNTIME_PROBE_COMMAND,
  COMPOSE_STATE_COMMAND,
  COMPOSE_UP_COMMAND,
]);

/**
 * How often the readiness of the container is checked, and how long it is waited for.
 *
 * The numbers themselves belong to `readiness.mjs`, because 1.11 states them once for the container,
 * the API_Service and the Web_App alike. These two names stay because step 4 is where they are read
 * as "how long until the database is given up on".
 */
export const CONTAINER_READINESS_INTERVAL_MS = READINESS_INTERVAL_MS;
export const CONTAINER_READINESS_TIMEOUT_MS = READINESS_TIMEOUT_MS;

/**
 * The state of the Compose service as one look reports it.
 *
 * @typedef {object} ComposeServiceState
 * @property {'PRESENT' | 'ABSENT' | 'UNREADABLE'} kind Whether a container of this service exists, does
 *   not exist, or could not be read.
 * @property {string | null} name Container name, as Compose reports it.
 * @property {string} state Lower-cased lifecycle state, for example `running` or `exited`.
 * @property {string} health Lower-cased health status, `healthy`, `starting`, `unhealthy`, or empty
 *   when the container declares no health check.
 * @property {string | null} status The human-readable status line, quoted by the German error of 1.1.
 */

/** A state value for the two cases in which there is nothing to read. */
const emptyState = (kind, status = null) =>
  Object.freeze({ kind, name: null, state: '', health: '', status });

/**
 * Whether the container runtime answered the probe (1.13).
 *
 * Both halves matter: a non-zero exit means the CLI could not reach the daemon or is not installed, and
 * an empty rendering means it answered without a server version, which is the same thing for the
 * purposes of step 4.
 *
 * @param {import('./command-runner.mjs').CommandResult} result
 * @returns {boolean}
 */
export function isRuntimeReachable(result) {
  return result.ok && result.stdout.trim() !== '';
}

/**
 * The Compose variables derived from the connection string (1.10).
 *
 * `DATABASE_URL` stays the single source of truth, so these four values are read out of it rather than
 * configured twice. Returns `null` when no connection string can be read at all, and then step 4 passes
 * no override and leaves Compose with the values of the environment file — the missing-key gate of 1.15
 * belongs to task 20.3, and guessing a port here would only hide that.
 *
 * Only non-empty values are returned, so a connection string without credentials does not blank out the
 * ones the environment file carries.
 *
 * @param {string | undefined} databaseUrl
 * @returns {Readonly<Record<string, string>> | null}
 */
export function derivePostgresEnvironment(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    return null;
  }

  let url;

  try {
    url = new URL(databaseUrl.trim());
  } catch {
    return null;
  }

  if (!url.protocol.startsWith('postgres') || url.hostname === '') {
    return null;
  }

  const values = {
    POSTGRES_PORT: url.port === '' ? String(DEFAULT_POSTGRES_PORT) : url.port,
    POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    POSTGRES_DB: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };

  return Object.freeze(
    Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')),
  );
}

/**
 * Parses `docker compose ps --all --format json <service>` into the state of that service.
 *
 * The output format has changed across Compose versions — one JSON object per line in some, a JSON
 * array in others — so both are read, and a single object is read as well. Unparsable output is
 * reported as `UNREADABLE` rather than as "no container": the two lead to the same safe action (an
 * `up --no-recreate`, which neither replaces a container nor touches a volume), but only one of them is
 * the truth, and the readiness poll quotes what it saw.
 *
 * @param {string} stdout
 * @param {string} [serviceName]
 * @returns {ComposeServiceState}
 */
export function parseComposeServiceState(stdout, serviceName = COMPOSE_SERVICE_NAME) {
  const trimmed = stdout.trim();

  if (trimmed === '') {
    return emptyState('ABSENT');
  }

  const entries = parseJsonEntries(trimmed);

  if (entries === null) {
    return emptyState('UNREADABLE', trimmed.split('\n')[0]);
  }

  // Compose names the service in every version that supports `--format json`; where it does not, the
  // output was asked for this one service anyway, so the first entry is it.
  const named = entries.filter((candidate) => typeof candidate.Service === 'string');
  const entry =
    named.length === 0 ? entries[0] : named.find((candidate) => candidate.Service === serviceName);

  if (entry === undefined) {
    return emptyState('ABSENT');
  }

  return Object.freeze({
    kind: 'PRESENT',
    name: readString(entry.Name) ?? readString(entry.Names),
    state: (readString(entry.State) ?? '').toLowerCase(),
    health: (readString(entry.Health) ?? '').toLowerCase(),
    status: readString(entry.Status),
  });
}

/**
 * What one look at the container state says about readiness (1.1).
 *
 * `unhealthy` is fatal and is not waited out: the health check of `docker-compose.yml` runs every 2
 * seconds and allows 30 retries, so a container that reports `unhealthy` has already failed its own
 * check for the full 60-second window of 1.11. Waiting a second window would only delay the same
 * message. A container that has exited is fatal for the same reason in reverse: nothing will make it
 * healthy while the Start_Script waits, and `restart: unless-stopped` would show as `restarting`.
 *
 * An empty health status means the container declares no health check — an older container from before
 * `docker-compose.yml` gained one. Running is then all that can be confirmed, so running is accepted.
 *
 * @param {ComposeServiceState} state
 * @returns {string} One of {@link CONTAINER_READINESS_DECISIONS}, never `TIMED_OUT`.
 */
export function decideContainerReadiness(state) {
  if (state.kind !== 'PRESENT') {
    return CONTAINER_READINESS_DECISIONS.WAIT;
  }

  if (state.state === 'exited' || state.state === 'dead') {
    return CONTAINER_READINESS_DECISIONS.STOPPED;
  }

  if (state.state !== 'running') {
    // `created`, `restarting`, `paused`: not ready, and not a failure this step can name yet.
    return CONTAINER_READINESS_DECISIONS.WAIT;
  }

  if (state.health === 'unhealthy') {
    return CONTAINER_READINESS_DECISIONS.UNHEALTHY;
  }

  return state.health === 'healthy' || state.health === ''
    ? CONTAINER_READINESS_DECISIONS.READY
    : CONTAINER_READINESS_DECISIONS.WAIT;
}

/**
 * Reads the state of the Compose service once.
 *
 * @param {import('./command-runner.mjs').CommandRunner} run
 * @param {Readonly<Record<string, string>> | null} composeEnvironment
 * @returns {Promise<ComposeServiceState>}
 */
export async function readComposeServiceState(run, composeEnvironment) {
  const result = await run(withEnvironment(COMPOSE_STATE_COMMAND, composeEnvironment));

  return result.ok
    ? parseComposeServiceState(result.stdout)
    : emptyState('UNREADABLE', extractFailureDetail(result));
}

/**
 * Looks at the container until it is ready, fails, or the waiting window ends (1.1).
 *
 * @param {object} dependencies
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {() => number} dependencies.now Monotonic enough for a 60-second window; `Date.now` in
 *   production, a counter in the tests.
 * @param {(ms: number) => Promise<void>} dependencies.sleep
 * @param {Readonly<Record<string, string>> | null} [dependencies.composeEnvironment]
 * @param {number} [dependencies.intervalMs]
 * @param {number} [dependencies.timeoutMs]
 * @returns {Promise<{ decision: string, state: ComposeServiceState, waitedMs: number }>}
 */
export async function pollContainerReadiness({
  run,
  now,
  sleep,
  composeEnvironment = null,
  intervalMs = CONTAINER_READINESS_INTERVAL_MS,
  timeoutMs = CONTAINER_READINESS_TIMEOUT_MS,
}) {
  const polled = await pollUntilSettled({
    observe: () => readComposeServiceState(run, composeEnvironment),
    decide: decideContainerReadiness,
    pendingDecision: CONTAINER_READINESS_DECISIONS.WAIT,
    timedOutDecision: CONTAINER_READINESS_DECISIONS.TIMED_OUT,
    now,
    sleep,
    intervalMs,
    timeoutMs,
  });

  return { decision: polled.decision, state: polled.observation, waitedMs: polled.waitedMs };
}

/**
 * Runs step 4: probe the runtime, then one progress line, then start or reuse, then the readiness gate.
 *
 * @param {object} dependencies
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {NodeJS.ProcessEnv} [dependencies.env] Where `DATABASE_URL` is read from. `pnpm start` runs
 *   Node with `--env-file-if-exists=.env`, so the local environment file is already in here.
 * @param {() => number} [dependencies.now]
 * @param {(ms: number) => Promise<void>} [dependencies.sleep]
 * @returns {Promise<{ outcome: string, state: ComposeServiceState, waitedMs: number }>}
 * @throws {StartStepError} When the runtime is unreachable (1.13), when the container can neither be
 *   started nor reused, or when it never confirms itself ready (1.1).
 */
export async function runPostgresContainerStep({
  run,
  reporter,
  env = process.env,
  now = () => Date.now(),
  sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
}) {
  // Before the progress line on purpose: 1.13 stops the start *before* step 4, so step 4 must not have
  // announced itself when the runtime turns out to be unreachable.
  const probe = await run(DOCKER_RUNTIME_PROBE_COMMAND);

  if (!isRuntimeReachable(probe)) {
    throw new StartStepError({
      message: 'The container runtime did not answer; the Start_Script stops before step 4 (1.13).',
      messageDe: containerRuntimeUnreachableError(extractFailureDetail(probe)),
      code: 'CONTAINER_RUNTIME_UNREACHABLE',
      exitCode: EXIT_CODES.CONTAINER_RUNTIME_UNREACHABLE,
    });
  }

  reporter.progress(START_STEPS.POSTGRES_CONTAINER);

  const composeEnvironment = derivePostgresEnvironment(env.DATABASE_URL);

  if (composeEnvironment === null && env.DATABASE_URL !== undefined) {
    reporter.warn(databaseUrlUnusableWarning(env.DATABASE_URL));
  }

  const existing = await readComposeServiceState(run, composeEnvironment);
  // An unreadable state is reported as `STARTED`, because nothing confirmed that a container existed.
  // The action that follows is the same either way, and it creates no second container.
  const outcome =
    existing.kind === 'PRESENT'
      ? POSTGRES_CONTAINER_OUTCOMES.REUSED
      : POSTGRES_CONTAINER_OUTCOMES.STARTED;

  if (decideContainerReadiness(existing) === CONTAINER_READINESS_DECISIONS.READY) {
    // A container from an earlier start that is already accepting connections is used exactly as it
    // is: no `up`, nothing recreated, nothing written (1.10).
    return { outcome, state: existing, waitedMs: 0 };
  }

  const up = await run(withEnvironment(COMPOSE_UP_COMMAND, composeEnvironment));

  if (!up.ok) {
    throw new StartStepError({
      message: 'The PostgreSQL container could neither be started nor reused (1.1, 1.10).',
      messageDe: postgresContainerFailedError({
        detail: extractFailureDetail(up),
        exitCode: up.code,
      }),
      code: 'POSTGRES_CONTAINER_FAILED',
      exitCode: EXIT_CODES.POSTGRES_CONTAINER_FAILED,
    });
  }

  const readiness = await pollContainerReadiness({ run, now, sleep, composeEnvironment });

  if (readiness.decision !== CONTAINER_READINESS_DECISIONS.READY) {
    throw new StartStepError({
      message: `The PostgreSQL container did not confirm readiness: ${readiness.decision} (1.1).`,
      messageDe: postgresContainerNotReadyError({
        decision: readiness.decision,
        status: readiness.state.status,
        waitedMs: readiness.waitedMs,
      }),
      code: 'POSTGRES_CONTAINER_NOT_READY',
      exitCode: EXIT_CODES.POSTGRES_CONTAINER_NOT_READY,
    });
  }

  return { outcome, state: readiness.state, waitedMs: readiness.waitedMs };
}

/**
 * A command with the derived Compose variables attached, or the command unchanged when nothing could be
 * derived.
 *
 * @param {import('./command-runner.mjs').CommandSpec} command
 * @param {Readonly<Record<string, string>> | null} composeEnvironment
 * @returns {import('./command-runner.mjs').CommandSpec}
 */
function withEnvironment(command, composeEnvironment) {
  return composeEnvironment === null ? command : { ...command, env: composeEnvironment };
}

/**
 * The entries of a `--format json` output, across the formats the Compose versions use.
 *
 * @param {string} trimmed
 * @returns {Record<string, unknown>[] | null} `null` when the output is not JSON at all.
 */
function parseJsonEntries(trimmed) {
  const whole = parseJson(trimmed);

  if (Array.isArray(whole)) {
    return whole.filter(isRecord);
  }

  if (isRecord(whole)) {
    return [whole];
  }

  /** @type {Record<string, unknown>[]} */
  const entries = [];

  for (const line of trimmed.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    const parsed = parseJson(line);

    if (!isRecord(parsed)) {
      return null;
    }

    entries.push(parsed);
  }

  return entries.length === 0 ? null : entries;
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function readString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}
