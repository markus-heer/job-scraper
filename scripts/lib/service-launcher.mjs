/**
 * The two ports steps 6 and 7 need beyond the command runner: a child that keeps running, and an HTTP
 * request.
 *
 * ## Why the command runner is the wrong shape for a server
 *
 * `command-runner.mjs` resolves its promise when the child exits. Every command of steps 1 to 5 does
 * exit — a pull, an install, a migration — and awaiting that exit is precisely how 1.1 confirms a step
 * ready. The API_Service and the Web_App never exit: awaiting them would hang the start forever, and
 * their exit is the *failure* case rather than the success case. So a persistent child gets its own
 * port, with a handle that answers three questions while the child runs — what has it printed, has it
 * exited, can it be stopped — instead of one promise that answers them all too late.
 *
 * The readiness of such a child cannot be read from an exit code either, which is why the second port
 * is here: an HTTP request to the service's own address is the only thing that proves it accepts
 * requests (1.11). Both ports are injected into the steps, so no test in the suite starts an
 * API_Service, a Vite server or a network request.
 *
 * ## `detached` is about the process group, not about outliving the start
 *
 * A service is spawned into its own process group and stopped by signalling that whole group. The
 * reason is that both services are started through `pnpm`, so the direct child is a package-manager
 * process and the listener is its grandchild: a signal to the child alone would leave a server holding
 * the port, and the next start would report that port as occupied for no reason the user caused. The
 * handles are never unreferenced and `stop` is called on every path the Start_Script can take, so a
 * detached group does not mean a service survives the start.
 *
 * ## No inherited stdio
 *
 * Captured, like every other child of the Start_Script, for the reason `command-runner.mjs` gives: 1.2
 * puts exactly one German line per step on stdout, and a Nest or Vite banner in English would bury it.
 * Only the head of the output is kept — a startup failure says what it is in its first lines, and a
 * service that runs for an hour must not fill memory with request logs.
 *
 * Requirements: 1.1, 1.2, 1.11.
 */

import { spawn } from 'node:child_process';

import { CHILD_ENVIRONMENT_OVERRIDES } from './command-runner.mjs';

/** How many characters of a service's output are kept for the German failure message. */
export const SERVICE_OUTPUT_LIMIT = 20_000;

/** How long a stopped service may take to end before it is ended the hard way. */
export const SERVICE_STOP_GRACE_MS = 5_000;

/** How long a single readiness request may take. Below the poll interval, so looks cannot pile up. */
export const SERVICE_PROBE_TIMEOUT_MS = 1_500;

/**
 * How a process reports that the port it wanted is taken by something else (1.11).
 *
 * Both spellings are needed because the two services fail in two different words:
 *
 * - Node, and therefore Nest, rejects the `listen` call with the `EADDRINUSE` error code and prints
 *   it verbatim: `Error: listen EADDRINUSE: address already in use 127.0.0.1:4000`;
 * - Vite catches that same error code and replaces it with a sentence of its own,
 *   `Port 5173 is already in use`, because `strictPort` in `apps/web/vite.config.ts` forbids it from
 *   silently moving to the next free port. Its message never contains the error code.
 */
export const PORT_OCCUPIED_PATTERNS = Object.freeze([
  /EADDRINUSE/,
  /address already in use/i,
  /port\s+\d+\s+is already in use/i,
]);

/**
 * A running service.
 *
 * @typedef {object} ServiceHandle
 * @property {string} command The program and its arguments as one string, for a developer's log.
 * @property {number | null} pid
 * @property {() => string} output Everything the service has printed so far, both streams as one text.
 * @property {() => ({ code: number | null, signal: string | null } | null)} exit `null` while the
 *   service runs.
 * @property {() => boolean} spawnFailed Whether the program could not be started at all.
 * @property {() => Promise<{ code: number | null, signal: string | null }>} whenExited Settles when
 *   the service ends, however it ends.
 * @property {() => Promise<void>} stop Ends the service and its process group.
 */

/**
 * Starts a persistent child.
 *
 * @typedef {(spec: import('./command-runner.mjs').CommandSpec) => ServiceHandle} ServiceLauncher
 */

/**
 * What one readiness request answered.
 *
 * @typedef {object} ProbeResult
 * @property {boolean} reached Whether an HTTP answer arrived at all.
 * @property {number | null} status
 * @property {string} body
 * @property {string | null} detail Why no answer arrived, for the German message.
 */

/**
 * Sends one readiness request.
 *
 * @typedef {(request: { url: string, method?: string, body?: string,
 *   headers?: Record<string, string> }) => Promise<ProbeResult>} ServiceProbe
 */

/**
 * Whether an output says the wanted port is taken (1.11).
 *
 * A pure function over the text the service itself printed, so the classification that tells "port
 * occupied" from "unreachable" is testable against real Nest and Vite output instead of being inferred
 * from an exit code that is `1` in both cases.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isPortOccupiedOutput(output) {
  return PORT_OCCUPIED_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Creates the production {@link ServiceLauncher}.
 *
 * @param {object} options
 * @param {string} options.cwd Default working directory, in production the repository root.
 * @param {NodeJS.ProcessEnv} [options.env] Environment to inherit from.
 * @param {typeof spawn} [options.spawnProcess] Injection point of this module's own test.
 * @param {number} [options.stopGraceMs] How long a stop waits before it ends the group the hard way.
 *   Shortened by the test that checks exactly that, so the suite does not sit out the grace period.
 * @returns {ServiceLauncher}
 */
export function createServiceLauncher({
  cwd,
  env = process.env,
  spawnProcess = spawn,
  stopGraceMs = SERVICE_STOP_GRACE_MS,
}) {
  return (spec) => {
    const command = [spec.command, ...spec.args].join(' ');
    /** @type {{ code: number | null, signal: string | null } | null} */
    let exit = null;
    let output = '';
    let failedToSpawn = false;
    /** @type {(value: { code: number | null, signal: string | null }) => void} */
    let announceExit;
    const exited = new Promise((resolve) => {
      announceExit = resolve;
    });

    const append = (chunk) => {
      if (output.length < SERVICE_OUTPUT_LIMIT) {
        output += chunk;
      }
    };

    const settle = (value) => {
      if (exit === null) {
        exit = value;
        announceExit(value);
      }
    };

    let child = null;

    try {
      child = spawnProcess(spec.command, [...spec.args], {
        cwd: spec.cwd ?? cwd,
        env: { ...env, ...spec.env, ...CHILD_ENVIRONMENT_OVERRIDES },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so that stopping the service reaches the listener and not only the
        // package manager that started it. Never unreferenced: the start stays the owner.
        detached: true,
      });
    } catch (error) {
      failedToSpawn = true;
      append(error instanceof Error ? error.message : String(error));
      settle({ code: null, signal: null });
    }

    if (child !== null) {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', append);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', append);

      child.once('error', (error) => {
        failedToSpawn = true;
        append(`\n${error instanceof Error ? error.message : String(error)}`);
        settle({ code: null, signal: null });
      });

      child.once('exit', (code, signal) => {
        settle({ code, signal });
      });
    }

    return {
      command,
      pid: child?.pid ?? null,
      output: () => output,
      exit: () => exit,
      spawnFailed: () => failedToSpawn,
      whenExited: () => exited,
      stop: () => stopChild({ child, isRunning: () => exit === null, exited, stopGraceMs }),
    };
  };
}

/**
 * Creates the production {@link ServiceProbe}.
 *
 * Every outcome is a result, never an exception: a connection that is refused is the normal answer
 * while a service is still starting, and the readiness loop has to be able to ask again.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchResource] Injection point of the tests.
 * @param {number} [options.timeoutMs]
 * @returns {ServiceProbe}
 */
export function createHttpProbe({
  fetchResource = fetch,
  timeoutMs = SERVICE_PROBE_TIMEOUT_MS,
} = {}) {
  return async ({ url, method = 'GET', body, headers }) => {
    try {
      const response = await fetchResource(url, {
        method,
        body,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      return {
        reached: true,
        status: response.status,
        body: await response.text(),
        detail: null,
      };
    } catch (error) {
      return {
        reached: false,
        status: null,
        body: '',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * Ends a child and the process group it leads.
 *
 * The group is signalled through the negated process id, which is what reaches the listener behind the
 * package manager. A group that is already gone answers `ESRCH`, which is success and not a failure, so
 * it is swallowed. After the grace period the group is ended without asking: a service that ignores the
 * polite signal would otherwise keep its port and make the next start report an occupied port.
 *
 * @param {object} dependencies
 * @param {import('node:child_process').ChildProcess | null} dependencies.child
 * @param {() => boolean} dependencies.isRunning
 * @param {Promise<{ code: number | null, signal: string | null }>} dependencies.exited
 * @param {number} dependencies.stopGraceMs
 * @returns {Promise<void>}
 */
async function stopChild({ child, isRunning, exited, stopGraceMs }) {
  if (child === null || child.pid === undefined || !isRunning()) {
    return;
  }

  signalGroup(child, 'SIGTERM');

  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      setTimeout(() => resolve(false), stopGraceMs).unref();
    }),
  ]);

  if (!graceful && isRunning()) {
    signalGroup(child, 'SIGKILL');
    await exited;
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @returns {void}
 */
function signalGroup(child, signal) {
  try {
    process.kill(-Number(child.pid), signal);
  } catch {
    // The group is already gone, or the platform refused the group form. Then the child alone is
    // the best that can be done, and a child that no longer exists is the outcome that was wanted.
    try {
      child.kill(signal);
    } catch {
      // Nothing left to end.
    }
  }
}
