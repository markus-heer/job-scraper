/**
 * The {@link import('../command-runner.mjs').CommandRunner} double of the Start_Script tests.
 *
 * Every step talks to the outside world through that one port, so a prepared result is all a test needs
 * to drive a branch of 1.3, 1.4, 1.6 or 1.7. Nothing in the suite contacts a Git remote, runs an install
 * or downloads a browser, and the recorded invocations are what the prohibition test of 1.5 inspects.
 *
 * Steps 6 and 7 reach the outside world through two further ports — a persistent child and an HTTP
 * request — so their doubles live here too, next to this one and built the same way. Together they are
 * the reason the readiness gates of 1.11 can be driven through every branch without an API_Service, a
 * Vite server, a socket or a minute of waiting.
 */

/**
 * A command as one comparable string, for example `git pull --ff-only`.
 *
 * @param {import('../command-runner.mjs').CommandSpec} spec
 * @returns {string}
 */
export function commandKey(spec) {
  return [spec.command, ...spec.args].join(' ');
}

/**
 * Fills a partial result up to a complete {@link import('../command-runner.mjs').CommandResult}.
 *
 * @param {import('../command-runner.mjs').CommandSpec} spec
 * @param {object} partial
 * @returns {import('../command-runner.mjs').CommandResult}
 */
export function completeResult(spec, partial) {
  const code = partial.code ?? 0;

  return {
    command: spec.command,
    args: [...spec.args],
    code,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnFailed: false,
    ...partial,
    ok: partial.ok ?? code === 0,
  };
}

/** A command that exited 0 with the given stdout. */
export function success(stdout = '') {
  return { code: 0, stdout };
}

/** A command that failed with the given code and stderr. */
export function failure({ code = 1, stderr = '', stdout = '', timedOut = false } = {}) {
  return { code, stderr, stdout, timedOut };
}

/**
 * Creates the fake runner.
 *
 * @param {Record<string, object> | ((spec: import('../command-runner.mjs').CommandSpec) => object)} results
 *   Either a table keyed by {@link commandKey}, or a function that decides per invocation.
 * @returns {import('../command-runner.mjs').CommandRunner & {
 *   invocations: import('../command-runner.mjs').CommandSpec[],
 *   keys: () => string[],
 * }}
 */
export function createFakeCommandRunner(results) {
  /** @type {import('../command-runner.mjs').CommandSpec[]} */
  const invocations = [];

  const runner = (spec) => {
    invocations.push(spec);

    const key = commandKey(spec);
    const partial = typeof results === 'function' ? results(spec) : results[key];

    if (partial === undefined) {
      return Promise.reject(new Error(`The test prepared no result for the command: ${key}`));
    }

    return Promise.resolve(completeResult(spec, partial));
  };

  runner.invocations = invocations;
  runner.keys = () => invocations.map(commandKey);

  return runner;
}

/**
 * The {@link import('../service-launcher.mjs').ServiceLauncher} double of steps 6 and 7.
 *
 * A persistent child is a handle, not a promise, so the double is a handle whose three answers a test
 * sets directly: what the service printed, whether it has exited, whether it could be started at all.
 * Nothing here starts a process, so no test in the suite brings up an API_Service or a Vite server.
 *
 * @param {object} [behaviour]
 * @param {string} [behaviour.output] What the service prints immediately.
 * @param {{ code: number | null, signal: string | null } | null} [behaviour.exitsWith] An exit the
 *   service reports right away, as a service with an occupied port does.
 * @param {boolean} [behaviour.spawnFailed]
 * @returns {import('../service-launcher.mjs').ServiceHandle & { stopped: () => number,
 *   simulate: (change: { output?: string,
 *     exitsWith?: { code: number | null, signal: string | null } }) => void }}
 */
export function createFakeServiceHandle({
  output = '',
  exitsWith = null,
  spawnFailed = false,
} = {}) {
  let exit = exitsWith;
  let stopCount = 0;
  let text = output;
  /** @type {(value: { code: number | null, signal: string | null }) => void} */
  let announceExit = () => undefined;
  const exited = new Promise((resolve) => {
    announceExit = resolve;
  });

  if (exit !== null) {
    announceExit(exit);
  }

  return {
    command: 'fake-service',
    pid: 4242,
    output: () => text,
    exit: () => exit,
    spawnFailed: () => spawnFailed,
    whenExited: () => exited,
    stop: () => {
      stopCount += 1;

      if (exit === null) {
        exit = { code: null, signal: 'SIGTERM' };
        announceExit(exit);
      }

      return Promise.resolve();
    },
    stopped: () => stopCount,
    /** Lets a test make the service print or end between two looks of the readiness gate. */
    simulate: ({ output: nextOutput, exitsWith: nextExit }) => {
      if (nextOutput !== undefined) {
        text = nextOutput;
      }

      if (nextExit !== undefined && exit === null) {
        exit = nextExit;
        announceExit(exit);
      }
    },
  };
}

/**
 * A launcher that hands out prepared handles and records what it was asked to start.
 *
 * @param {readonly ReturnType<typeof createFakeServiceHandle>[]} handles One per expected launch, in
 *   order.
 * @returns {import('../service-launcher.mjs').ServiceLauncher & {
 *   invocations: import('../command-runner.mjs').CommandSpec[],
 *   keys: () => string[],
 * }}
 */
export function createFakeServiceLauncher(handles) {
  /** @type {import('../command-runner.mjs').CommandSpec[]} */
  const invocations = [];
  let launched = 0;

  const launch = (spec) => {
    invocations.push(spec);

    const handle = handles[launched];

    launched += 1;

    if (handle === undefined) {
      throw new Error(`The test prepared no service handle for: ${commandKey(spec)}`);
    }

    return handle;
  };

  launch.invocations = invocations;
  launch.keys = () => invocations.map(commandKey);

  return launch;
}

/**
 * A readiness probe that answers from a prepared list, repeating its last answer.
 *
 * @param {readonly object[] | ((request: object) => object)} answers Partial
 *   {@link import('../service-launcher.mjs').ProbeResult} values, or a function per request.
 * @returns {import('../service-launcher.mjs').ServiceProbe & { requests: object[] }}
 */
export function createFakeProbe(answers) {
  /** @type {object[]} */
  const requests = [];

  const probe = (request) => {
    requests.push(request);

    const answer =
      typeof answers === 'function'
        ? answers(request)
        : answers[Math.min(requests.length - 1, answers.length - 1)];

    return Promise.resolve({
      reached: false,
      status: null,
      body: '',
      detail: null,
      ...answer,
    });
  };

  probe.requests = requests;

  return probe;
}

/** A probe answer of a service that is up and answered the given body. */
export function answering(body, status = 200) {
  return { reached: true, status, body, detail: null };
}

/** A probe answer of an address that refused the connection. */
export function refused(detail = 'fetch failed') {
  return { reached: false, status: null, body: '', detail };
}

/**
 * A clock whose only movement is the waiting of the code under test.
 *
 * @returns {{ now: () => number, sleep: (ms: number) => Promise<void>, sleeps: number[] }}
 */
export function createFakeClock() {
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

/**
 * A Reporter backed by arrays, so a test can assert what landed on stdout and what on stderr.
 *
 * Built on the production {@link import('../reporter.mjs').createReporter}, not on a hand-written
 * object: the counting rule of 1.2 lives in that function, and a double would not enforce it.
 *
 * @param {typeof import('../reporter.mjs').createReporter} createReporter
 * @returns {{ reporter: import('../reporter.mjs').Reporter, out: string[], errorLines: string[] }}
 */
export function createRecordingReporter(createReporter) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const errorLines = [];

  const reporter = createReporter({
    writeOut: (line) => out.push(line),
    writeError: (line) => errorLines.push(line),
  });

  return { reporter, out, errorLines };
}
