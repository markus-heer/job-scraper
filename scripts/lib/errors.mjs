/**
 * The error a step throws when the start has to end, and the exit code that goes with it.
 *
 * 1.6 and 1.7 ask for the same three things on a fatal failure: run none of the remaining steps, print
 * a German error naming the cause, exit non-zero. One error type carries all three, so the orchestrator
 * has a single `catch` and the choice of exit code stays in one table instead of in each step.
 *
 * The split between fatal and non-fatal is the requirement's, not a judgement call: a failure in step 1
 * is a warning and the start continues with step 2 (1.3, 1.4), a failure in step 2 or step 3 ends the
 * start (1.6, 1.7), an unreachable container runtime ends it before step 4 (1.13) and a failed
 * migration ends it before the API_Service and the Web_App are started (1.14). Step 1 therefore throws
 * no {@link StartStepError} at all. The gates of steps 6 and 7 are fatal in the same way (1.11), and so
 * is the configuration check that runs before step 1 (1.15).
 *
 * Every {@link StartStepError} carries both texts on purpose: `message` is English for the developer who
 * reads a stack trace, `messageDe` is the sentence the user reads (16.8).
 *
 * Requirements: 1.6, 1.7, 1.11, 1.15, 16.8.
 */

/**
 * Exit codes of the Start_Script.
 *
 * Distinct codes per cause rather than a single `1`: the requirements only ask for "non-zero", but a
 * distinct code lets a later task, a hook or a log tell the failures apart without parsing German
 * text. The two services get a code each, although 1.11 states one rule for both: the rule is the
 * same, the thing to fix is not.
 */
export const EXIT_CODES = Object.freeze({
  /** Every step that ran reported ready. */
  SUCCESS: 0,
  /** `pnpm install` failed (1.6). */
  DEPENDENCY_INSTALL_FAILED: 2,
  /** The browser files could not be checked, so their state is unknown (1.1, 1.7). */
  BROWSER_BINARY_CHECK_FAILED: 3,
  /** A missing browser file could not be installed (1.7). */
  BROWSER_BINARY_INSTALL_FAILED: 4,
  /** The container runtime was not reachable, so the start stopped before step 4 (1.13). */
  CONTAINER_RUNTIME_UNREACHABLE: 5,
  /** The PostgreSQL container could neither be started nor reused (1.1, 1.10). */
  POSTGRES_CONTAINER_FAILED: 6,
  /** The PostgreSQL container did not report itself ready within the waiting window (1.1). */
  POSTGRES_CONTAINER_NOT_READY: 7,
  /** A pending Prisma migration failed to apply (1.14). */
  PRISMA_MIGRATION_FAILED: 8,
  /** A required configuration key is missing or empty in the environment file (1.15). */
  ENVIRONMENT_INCOMPLETE: 9,
  /** `API_PORT` or `WEB_PORT` is present but is not a port the start can probe or print (1.9, 1.11). */
  ENVIRONMENT_PORT_UNUSABLE: 10,
  /** The list of required keys could not be read from the API_Service. A defect, not a user error. */
  ENVIRONMENT_KEY_LIST_UNREADABLE: 11,
  /** The API_Service could not be compiled, so there was nothing to start in step 6 (1.1). */
  API_SERVICE_BUILD_FAILED: 12,
  /** The API_Service did not accept requests within the waiting window of 1.11. */
  API_SERVICE_NOT_READY: 13,
  /** The Web_App did not accept requests within the waiting window of 1.11. */
  WEB_APP_NOT_READY: 14,
  /** A service that had confirmed itself ready ended on its own afterwards. */
  SERVICE_STOPPED: 15,
  /** A failure no step classified. */
  UNEXPECTED: 70,
});

/** A step failed in a way that ends the start (1.6, 1.7). */
export class StartStepError extends Error {
  /**
   * @param {object} options
   * @param {string} options.message English description for a developer.
   * @param {string} options.messageDe The German console line the user reads.
   * @param {string} options.code Stable English key, asserted on by the tests.
   * @param {number} options.exitCode One of {@link EXIT_CODES}, never 0.
   * @param {unknown} [options.cause]
   */
  constructor({ message, messageDe, code, exitCode, cause }) {
    super(message, { cause });
    this.name = 'StartStepError';
    this.messageDe = messageDe;
    this.code = code;
    this.exitCode = exitCode;
  }
}
