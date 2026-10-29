/**
 * The seeding helper every E2E spec starts from (task 21.1).
 *
 * ```ts
 * test.beforeEach(async () => {
 *   await seedPostingStore('posting-overview');
 * });
 * ```
 *
 * One call, one known Posting_Store. The scenario names and the rows behind them live in
 * `apps/api/src/testing/e2e-scenarios.ts`, next to the Prisma schema that defines them and built on
 * the same `seedScrapeRun` and `seedJobPosting` builders the integration suite uses — so there is one
 * definition of what a complete Job_Posting row looks like, not a second one for E2E.
 *
 * This module is the thin side of that arrangement: it spawns the compiled seeding command and reads
 * the single JSON line it prints. It holds no row shapes, no Prisma client and no knowledge of the
 * schema, which is what keeps `apps/web` free of a dependency on `apps/api`.
 *
 * ## What a spec gets back
 *
 * {@link SeededScenario} — the scenario name, the Scrape_Run identifiers it wrote and how many
 * Job_Posting it stored. The run identifiers are what a spec building a Log_View URL needs
 * (`/runs/<runId>/log`), and the posting count is what a pagination assertion is derived from rather
 * than hard-coded a second time.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { harnessDatabaseUrl, SEED_COMMAND_PATH } from '../harness/handoff';

const execFileAsync = promisify(execFile);

/** The scenarios the seeding command accepts; mirrors `E2E_SCENARIOS` of the API package. */
export const E2E_SCENARIOS = [
  /** No Job_Posting and no Scrape_Run at all (10.12, 11.6). */
  'empty',
  /** One completed Scrape_Run that stored nothing (2.8). */
  'completed-run-without-postings',
  /** Two completed Scrape_Run and 44 Job_Posting covering every filter and sort value of 10.5 and 10.7. */
  'posting-overview',
] as const;

/** One of {@link E2E_SCENARIOS}. */
export type E2eScenario = (typeof E2E_SCENARIOS)[number];

/** What the seeding command reports about what it wrote. */
export interface SeededScenario {
  readonly scenario: E2eScenario;
  /** The Scrape_Run identifiers, oldest first. Empty for the `empty` scenario. */
  readonly runIds: readonly string[];
  /** How many Job_Posting were written, across every Posting_Status and marking. */
  readonly postingCount: number;
  /**
   * How many of them the posting overview shows with no filter set.
   *
   * Fewer than {@link postingCount}, because the default view hides the Relevance_Verdict "nicht
   * relevant" (10.6) and the marking "nicht interessant" (10.11). Reported by the seeding rather
   * than worked out here: a spec that recomputed it would hold a second copy of the seeding rules.
   */
  readonly defaultViewCount: number;
}

/** How long the seeding command may take. Generous: it truncates and writes up to 28 rows. */
const SEED_TIMEOUT_MS = 60_000;

/**
 * Truncates the Posting_Store of the harness database and writes one scenario into it.
 *
 * Deliberately not incremental: every call starts from an empty store, so a spec never depends on
 * what the spec before it left behind and the order of the specs in a file cannot matter.
 *
 * @param scenario Which Posting_Store state to produce.
 * @returns What was written, for the assertions and the URLs of the calling spec.
 * @throws An `Error` carrying the command's own message when the seeding failed — a missing hand-off
 *   file, an un-built API package or a connection string that is not a test database.
 */
export const seedPostingStore = async (scenario: E2eScenario): Promise<SeededScenario> => {
  const databaseUrl = await harnessDatabaseUrl();

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [SEED_COMMAND_PATH, '--scenario', scenario, '--database-url', databaseUrl],
      { timeout: SEED_TIMEOUT_MS },
    );

    return JSON.parse(stdout.trim()) as SeededScenario;
  } catch (cause) {
    throw new Error(
      `Seeding the scenario "${scenario}" failed. The seeding command is ${SEED_COMMAND_PATH}; ` +
        'it is build output, so `pnpm build` has to have run. ' +
        `Underlying failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};
