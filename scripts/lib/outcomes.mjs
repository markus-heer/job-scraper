/**
 * The closed value lists of the Start_Script steps.
 *
 * They live in their own module, not next to the step that produces them, because both sides need them:
 * the step module returns one of these values, and `start.messages.mjs` keys the German sentence of
 * 1.3, 1.4 and 1.7 on the same value. An import in both directions between a step and the messages
 * would be a cycle whose evaluation order decides whether a frozen table exists yet, so the shared
 * vocabulary is pulled out instead — the same reason `packages/domain` owns the enums of the Job_Tool.
 *
 * English identifiers, German display text elsewhere (16.8).
 *
 * Requirements: 1.3, 1.4, 1.7, 1.10, 1.11, 1.14.
 */

/**
 * How step 1 ended.
 *
 * Four outcomes and not two, because 1.3, 1.4 and 1.5 ask for three different *non*-updates, each with
 * its own German warning, and all three continue with step 2.
 */
export const GIT_PULL_OUTCOMES = Object.freeze({
  /** A fast-forward was possible and was applied. */
  UPDATED: 'UPDATED',
  /** The working tree carried uncommitted changes, so no update was attempted (1.3). */
  SKIPPED_DIRTY_TREE: 'SKIPPED_DIRTY_TREE',
  /** The state of the working tree could not be read, so no update was attempted (1.5). */
  SKIPPED_TREE_UNREADABLE: 'SKIPPED_TREE_UNREADABLE',
  /** The update was attempted and failed; the local state is unchanged (1.4). */
  FAILED: 'FAILED',
});

/**
 * The detected cause of a failed update (1.4).
 *
 * The requirement names two causes; `UNKNOWN` is the third because a classifier over tool output is
 * never total, and a warning that claims the wrong cause is worse than one that quotes the reported
 * line and says so.
 */
export const PULL_FAILURE_CAUSES = Object.freeze({
  NO_NETWORK: 'NO_NETWORK',
  NO_FAST_FORWARD: 'NO_FAST_FORWARD',
  UNKNOWN: 'UNKNOWN',
});

/** How step 3 ended (1.7). */
export const BROWSER_BINARY_OUTCOMES = Object.freeze({
  /** Every browser file the retrieval needs was already present; nothing was downloaded. */
  ALREADY_COMPLETE: 'ALREADY_COMPLETE',
  /** At least one browser file was missing and was installed. */
  INSTALLED: 'INSTALLED',
});

/** How step 2 ended (1.6). A failure is an error, never an outcome. */
export const DEPENDENCY_INSTALL_OUTCOMES = Object.freeze({
  INSTALLED: 'INSTALLED',
});

/**
 * How step 4 ended (1.10).
 *
 * The distinction is the one 1.10 makes: a container from an earlier start is reused, and only the
 * absence of one leads to a container being created. Both outcomes end with a container that reports
 * itself healthy, so the step runs to the same readiness gate either way.
 */
export const POSTGRES_CONTAINER_OUTCOMES = Object.freeze({
  /** A container of this name already existed and was reused; none was created (1.10). */
  REUSED: 'REUSED',
  /** No container of this name existed, so one was created from the Compose file. */
  STARTED: 'STARTED',
});

/**
 * What one look at the container state says about readiness (1.1).
 *
 * A closed list rather than a boolean, because the three ways of *not* being ready need three different
 * German sentences: a container that is still starting is waited for, one that reports itself unhealthy
 * has already failed its own check for the full retry window, and one that has exited will not become
 * healthy on its own.
 */
export const CONTAINER_READINESS_DECISIONS = Object.freeze({
  /** Running, and its health check passes (or it declares none). Step 5 may begin. */
  READY: 'READY',
  /** Created, starting, restarting, or healthy-not-yet: probe again after the poll interval. */
  WAIT: 'WAIT',
  /** The container reports its own health check as failed. */
  UNHEALTHY: 'UNHEALTHY',
  /** The container exited or is dead. */
  STOPPED: 'STOPPED',
  /** The waiting window elapsed without a READY state. Produced by the poll, never by one look. */
  TIMED_OUT: 'TIMED_OUT',
});

/**
 * What one look at a service says about its readiness (1.11).
 *
 * The two causes 1.11 names — unreachable, port occupied — are two of these values, and the other
 * three are the states a look can be in before a cause is known. `TIMED_OUT` is separate from
 * `UNREACHABLE` although both are reported to the user as "not reachable": only one of them waited the
 * full window, and the German sentence says which, because "it never answered in 60 seconds" and "it
 * ended immediately" lead the user to different places.
 */
export const SERVICE_READINESS_DECISIONS = Object.freeze({
  /** The service answered its own address. The next step may begin. */
  READY: 'READY',
  /** Still starting: no answer yet, and the process is still running. Look again. */
  WAIT: 'WAIT',
  /** The service reported that the port it wanted is taken by something else (1.11). */
  PORT_OCCUPIED: 'PORT_OCCUPIED',
  /** The service ended, or could not be started, without naming an occupied port (1.11). */
  UNREACHABLE: 'UNREACHABLE',
  /** The 60-second window of 1.11 elapsed while the service was still not answering. */
  TIMED_OUT: 'TIMED_OUT',
});

/**
 * How step 6 and step 7 ended (1.1, 1.11).
 *
 * `ALREADY_RUNNING` is the same consideration 1.10 makes for the container: a service from an earlier
 * start that answers its own address is ready, and the start that found it neither starts a second one
 * nor stops the one it did not start.
 */
export const SERVICE_OUTCOMES = Object.freeze({
  /** The Start_Script started the service and it confirmed itself ready. */
  STARTED: 'STARTED',
  /** A service from an earlier start was already answering and was left alone (1.10 by analogy). */
  ALREADY_RUNNING: 'ALREADY_RUNNING',
});

/** How step 5 ended (1.14). A failed migration is an error, never an outcome. */
export const PRISMA_MIGRATION_OUTCOMES = Object.freeze({
  /** At least one pending migration was applied. */
  APPLIED: 'APPLIED',
  /** The Posting_Store was already at the current migration state; nothing was applied. */
  ALREADY_UP_TO_DATE: 'ALREADY_UP_TO_DATE',
});
