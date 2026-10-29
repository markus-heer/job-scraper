/**
 * The seven steps of the Start_Script, in the order Requirement 1.1 fixes.
 *
 * Declared as one frozen table rather than as numbers spread over the step modules, for two reasons:
 *
 * - the progress line of 1.2 has to say *which* step is running ("Schritt 2 von 7"), so the number and
 *   the total have to come from one place or they drift apart as the later steps arrive;
 * - 1.1 demands that each step begins only after the preceding one is confirmed ready. The order is
 *   therefore part of the specification, and this table is where a reviewer can compare it against the
 *   requirement without reading the orchestrator.
 *
 * Steps 4 to 7 are listed although tasks 20.2 and 20.3 implement them: the numbering of the three
 * implemented steps only means something next to the steps that follow, and the Reporter refuses a
 * step it has no German text for, so a half-built step cannot print a line by accident.
 *
 * Requirements: 1.1, 1.2.
 */

/** How many steps a complete start performs (1.1). Part of every progress line. */
export const TOTAL_STEP_COUNT = 7;

/**
 * One step of the Start_Script.
 *
 * @typedef {object} StartStep
 * @property {string} id Stable English key, used by the Reporter and by tests.
 * @property {number} number Position in the order of 1.1, counting from 1.
 */

/** The steps of 1.1, keyed by their English identifier. */
export const START_STEPS = Object.freeze({
  /** Step 1: fast-forward-only `git pull` (1.3, 1.4, 1.5). */
  GIT_PULL: Object.freeze({ id: 'GIT_PULL', number: 1 }),
  /** Step 2: `pnpm install` (1.6). */
  DEPENDENCY_INSTALL: Object.freeze({ id: 'DEPENDENCY_INSTALL', number: 2 }),
  /** Step 3: check the Playwright browser binaries, install the missing ones (1.7). */
  BROWSER_BINARIES: Object.freeze({ id: 'BROWSER_BINARIES', number: 3 }),
  /** Step 4: start or reuse the PostgreSQL container (1.10, 1.13). Task 20.2. */
  POSTGRES_CONTAINER: Object.freeze({ id: 'POSTGRES_CONTAINER', number: 4 }),
  /** Step 5: apply pending Prisma migrations (1.14). Task 20.2. */
  PRISMA_MIGRATIONS: Object.freeze({ id: 'PRISMA_MIGRATIONS', number: 5 }),
  /** Step 6: start the API_Service behind its readiness gate (1.11). Task 20.3. */
  API_SERVICE: Object.freeze({ id: 'API_SERVICE', number: 6 }),
  /** Step 7: serve the Web_App and print its local URL (1.9, 1.11). Task 20.3. */
  WEB_APP: Object.freeze({ id: 'WEB_APP', number: 7 }),
});
