/**
 * The one way the Start_Script runs an external command.
 *
 * Every step talks to the outside world through the {@link CommandRunner} port defined here, and never
 * through `child_process` directly. That is what makes the branching rules of 1.3, 1.4, 1.6 and 1.7
 * testable: a test hands the step a fake runner that returns a prepared result, so `pnpm test` neither
 * contacts a Git remote nor rewrites the lockfile nor downloads a 150 MB browser (task 20.4 extends the
 * same suite).
 *
 * Four decisions are worth stating because they decide what the German messages can say:
 *
 * - **No shell.** A command is a program name plus an argument array, so no value is ever parsed by a
 *   shell. This also keeps every invocation single-line and file-based, as the project rule on shell
 *   execution demands.
 * - **Captured output.** `stdout` and `stderr` are collected instead of inherited. 1.2 allows exactly
 *   one German progress line per step, and a child that streams its own English progress into the same
 *   console would bury it. Capturing is also what lets 1.4, 1.6 and 1.7 quote the reported cause.
 * - **A fixed child environment.** `LC_ALL` and `LANG` are set to `C` so the classifier of 1.4 reads the
 *   English Git output it was written against rather than a translation of the machine's locale, and
 *   `GIT_TERMINAL_PROMPT=0` so a missing credential fails instead of waiting for input nobody will type.
 *   A command may add values of its own through {@link CommandSpec.env} — the port step 4 derived, the
 *   connection step 5 passes to Prisma. These are all child process options, never a shell prefix.
 * - **A failure is a result, not an exception.** A program that is not installed resolves as a result
 *   with `spawnFailed`, so the step decides whether that is a warning (step 1) or an error (steps 2
 *   and 3) instead of the runner deciding for it.
 *
 * Requirements: 1.2, 1.4, 1.6, 1.7.
 */

import { spawn } from 'node:child_process';

/**
 * Environment values the Start_Script forces on every child, on top of the inherited environment.
 *
 * `NO_COLOR` keeps escape sequences out of the captured output, which a German message would otherwise
 * quote verbatim into the console.
 */
export const CHILD_ENVIRONMENT_OVERRIDES = Object.freeze({
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
});

/** How many characters of a reported cause a German message quotes. */
export const DETAIL_LENGTH_LIMIT = 300;

/**
 * Matches the colour escape sequences of a captured output.
 *
 * Built with `String.fromCharCode` rather than written as a literal because the escape character is a
 * control character, which the lint configuration rejects inside a regular expression literal.
 */
const ANSI_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Lines that name a cause rather than a hint, in the order a message prefers to quote them. */
const CAUSE_LINE_PATTERN = /^(fatal|error|err_pnpm[a-z_]*|warn|remote):/i;

/**
 * One command: a program and its arguments, never a command line.
 *
 * @typedef {object} CommandSpec
 * @property {string} command Program name, resolved through `PATH`.
 * @property {readonly string[]} args Arguments, passed through unparsed.
 * @property {string} [cwd] Working directory; defaults to the one the runner was created with.
 * @property {number} [timeoutMs] Kills the child after this many milliseconds. Set for commands that
 *   can hang on a network (step 1), left unset for commands that are legitimately slow (steps 2, 3).
 * @property {Readonly<Record<string, string>>} [env] Extra environment for this child only, merged on
 *   top of the inherited environment. This is how step 4 hands Compose the values it derived from
 *   `DATABASE_URL` and how step 5 hands Prisma its connection: a `VAR=value command` prefix is not an
 *   option here, because there is no shell to parse it, and the project rule forbids it anyway.
 */

/**
 * What a finished command reports back.
 *
 * @typedef {object} CommandResult
 * @property {string} command
 * @property {readonly string[]} args
 * @property {boolean} ok Whether the command exited with code 0.
 * @property {number | null} code Exit code, `null` when the child was killed or never started.
 * @property {string | null} signal The signal that killed the child, if any.
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut Whether `timeoutMs` elapsed and the child was killed.
 * @property {boolean} spawnFailed Whether the program could not be started at all.
 */

/**
 * What the steps call. Resolves for every outcome, including a program that does not exist.
 *
 * @typedef {(spec: CommandSpec) => Promise<CommandResult>} CommandRunner
 */

/**
 * Creates the production {@link CommandRunner}.
 *
 * @param {object} options
 * @param {string} options.cwd Default working directory, in production the repository root.
 * @param {NodeJS.ProcessEnv} [options.env] Environment to inherit from. Defaults to `process.env`.
 * @param {typeof spawn} [options.spawnProcess] Injection point of the runner's own unit test.
 * @returns {CommandRunner}
 */
export function createCommandRunner({ cwd, env = process.env, spawnProcess = spawn }) {
  return (spec) =>
    new Promise((resolve) => {
      const settle = (result) => {
        resolve({ command: spec.command, args: [...spec.args], ...result });
      };

      let child;

      try {
        child = spawnProcess(spec.command, [...spec.args], {
          cwd: spec.cwd ?? cwd,
          // Inherited first, then the values of this one command, then the fixed overrides: a command
          // may supply a connection or a port, but none may switch the child's locale back.
          env: { ...env, ...spec.env, ...CHILD_ENVIRONMENT_OVERRIDES },
          shell: false,
          // No stdin: a child that asks a question must fail rather than wait for an answer that
          // nobody is going to type into a start script.
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: spec.timeoutMs,
          killSignal: 'SIGTERM',
        });
      } catch (error) {
        settle(spawnFailureResult(error));

        return;
      }

      let stdout = '';
      let stderr = '';

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      // A child that cannot be started emits `error` and no `close`, so both are awaited. A promise
      // ignores the second settlement, which is what makes handling both safe.
      child.once('error', (error) => {
        const failed = spawnFailureResult(error);

        settle({
          ...failed,
          stdout,
          // Whatever the child managed to print, then the spawn failure itself. Keeping both in this
          // order means the quoted cause of 1.6 and 1.7 names the missing program even when the child
          // wrote nothing at all.
          stderr: [stderr, failed.stderr].filter((text) => text !== '').join('\n'),
        });
      });

      child.once('close', (code, signal) => {
        settle({
          ok: code === 0,
          code,
          signal,
          stdout,
          stderr,
          timedOut: spec.timeoutMs !== undefined && signal === 'SIGTERM',
          spawnFailed: false,
        });
      });
    });
}

/**
 * The result of a program that could not be started, for example because it is not installed.
 *
 * @param {unknown} error
 * @returns {Omit<CommandResult, 'command' | 'args'>}
 */
function spawnFailureResult(error) {
  return {
    ok: false,
    code: null,
    signal: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    timedOut: false,
    spawnFailed: true,
  };
}

/**
 * The one line of a failed command that a German message quotes as the reported cause.
 *
 * `stderr` before `stdout`, and a line that names a cause (`fatal:`, `error:`, an `ERR_PNPM*` code)
 * before the first line of output, because Git prints several `hint:` lines before the `fatal:` one
 * that actually says why it stopped. Returns `null` when the command produced no output at all, which
 * the messages render as {@link NO_OUTPUT_DE}.
 *
 * @param {CommandResult} result
 * @returns {string | null}
 */
export function extractFailureDetail(result) {
  return extractOutputDetail(`${result.stderr}\n${result.stdout}`);
}

/**
 * The same choice over a plain text rather than over a finished command.
 *
 * Needed by steps 6 and 7: a service that is still running has printed output but has no result yet,
 * and the German message of 1.11 quotes the reported cause either way. One implementation, so the line
 * a user sees is chosen by the same rule whether the program ended or is still trying.
 *
 * @param {string} output
 * @returns {string | null}
 */
export function extractOutputDetail(output) {
  const lines = splitLines(output);

  if (lines.length === 0) {
    return null;
  }

  const causeLine = lines.find((line) => CAUSE_LINE_PATTERN.test(line));

  return truncate(causeLine ?? lines[0]);
}

/**
 * Captured output as trimmed, non-empty, colour-free lines.
 *
 * @param {string} output
 * @returns {string[]}
 */
function splitLines(output) {
  return output
    .replace(ANSI_SEQUENCE_PATTERN, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * @param {string} line
 * @returns {string}
 */
function truncate(line) {
  return line.length <= DETAIL_LENGTH_LIMIT ? line : `${line.slice(0, DETAIL_LENGTH_LIMIT)}…`;
}
