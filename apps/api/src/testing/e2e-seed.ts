/**
 * The Posting_Store seeding command of the E2E harness (task 21.1).
 *
 * ```bash
 * node apps/api/dist/testing/e2e-seed.js --scenario posting-overview --database-url postgresql://…
 * ```
 *
 * Truncates every table and writes one of the scenarios of `./e2e-scenarios.ts`, then prints the
 * result as a single JSON line so the caller can read what was written. Exit code 0 on success and 1
 * with a message on stderr for anything else.
 *
 * ## Why a command and not a module the Playwright suite imports
 *
 * The seeding helper the specs call lives in `apps/web/e2e/`, and `apps/web` is an ESM package with
 * no access to the Posting_Store: Prisma, the schema and every row shape live in `apps/api`, which is
 * CommonJS. Reaching across that boundary would mean giving `apps/web` a dependency on the API
 * package, an export map for its build output and the module-format friction that comes with both —
 * all so that a test could hold a second database client beside the one the API_Service already has.
 *
 * A process boundary is the cheaper and the more honest arrangement. The database knowledge stays in
 * the package that owns the schema, the web package gains no dependency, and the helper in
 * `apps/web/e2e/fixtures/posting-store.ts` is a dozen lines that spawn this file.
 *
 * ## Why the connection string is an argument and not an environment variable
 *
 * It names the throwaway container the harness started, which changes per run, and the repository
 * rule against environment-variable prefixes on shell commands applies to the caller as much as to a
 * developer. A flag keeps the invocation a plain `node …` line. It also makes the safety check below
 * unmissable: this command refuses any database whose name does not end in `_test`, because it
 * truncates everything it connects to and the development Posting_Store holds the user's data.
 *
 * Requirements: 9.6, 10.1, 12.1.
 */

import { databaseNameOf, FIXTURE_MODE_DATABASE_SUFFIX } from '../config/fixture-mode';
import { PrismaService } from '../prisma/prisma.service';
import {
  E2E_SCENARIO_SEEDERS,
  E2E_SCENARIOS,
  type E2eScenario,
  type SeededScenario,
} from './e2e-scenarios';

/** Prisma's own bookkeeping table, which records the applied migrations and must survive. */
const MIGRATIONS_TABLE = '_prisma_migrations';

/** Unquoted PostgreSQL identifier; everything read out of `information_schema` has to match. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How long {@link awaitSettledScrapeRun} waits for a Scrape_Run of the previous spec to finish. */
const SETTLE_TIMEOUT_MS = 30_000;

/** How often it looks. */
const SETTLE_POLL_MS = 100;

/** What one invocation was asked to do. */
export interface E2eSeedRequest {
  readonly scenario: E2eScenario;
  readonly databaseUrl: string;
}

/** Whether a value names one of the scenarios. */
export const isE2eScenario = (value: string): value is E2eScenario =>
  (E2E_SCENARIOS as readonly string[]).includes(value);

/**
 * Reads `--scenario` and `--database-url` out of an argument list.
 *
 * @throws An `Error` naming the usage when either is missing, when the scenario is unknown, or when
 *   the connection string does not name a database whose name ends in
 *   {@link FIXTURE_MODE_DATABASE_SUFFIX}.
 */
export const parseE2eSeedArgs = (argv: readonly string[]): E2eSeedRequest => {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);

    return index === -1 ? undefined : argv[index + 1];
  };

  const scenario = valueOf('--scenario');
  const databaseUrl = valueOf('--database-url');

  if (scenario === undefined || databaseUrl === undefined) {
    throw new Error(
      'Usage: node dist/testing/e2e-seed.js --scenario <name> --database-url <postgresql://…>\n' +
        `Scenarios: ${E2E_SCENARIOS.join(', ')}`,
    );
  }

  if (!isE2eScenario(scenario)) {
    throw new Error(
      `Unknown scenario ${JSON.stringify(scenario)}. Known scenarios: ${E2E_SCENARIOS.join(', ')}.`,
    );
  }

  const databaseName = databaseNameOf(databaseUrl);

  if (databaseName === null || !databaseName.endsWith(FIXTURE_MODE_DATABASE_SUFFIX)) {
    // The same rule the API_Service applies in fixture mode, applied again here because this command
    // is the thing that actually issues the TRUNCATE.
    throw new Error(
      `Refusing to seed ${databaseName === null ? 'a connection string without a database name' : `the database "${databaseName}"`}: ` +
        `the E2E seeding truncates every table, so it only runs against a database whose name ends with "${FIXTURE_MODE_DATABASE_SUFFIX}".`,
    );
  }

  return { scenario, databaseUrl };
};

/**
 * Clears every table except the migration bookkeeping.
 *
 * The same statement the integration harness uses, for the same reasons: `TRUNCATE` is atomic over
 * the list so the foreign keys between Job_Posting, Scrape_Run and the log messages never see a
 * half-cleared store, `CASCADE` covers a table a later migration adds, and `RESTART IDENTITY` resets
 * the sequences so an identifier from a previous scenario cannot reappear with different content.
 */
export const truncatePostingStore = async (prisma: PrismaService): Promise<void> => {
  const rows = await prisma.$queryRaw<{ tableName: string }[]>`
    SELECT table_name AS "tableName"
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> ${MIGRATIONS_TABLE}
     ORDER BY table_name
  `;

  const names = rows.map((row) => row.tableName);
  const unexpected = names.filter((name) => !SAFE_IDENTIFIER.test(name));

  if (unexpected.length > 0) {
    // Interpolating an identifier into DDL is unavoidable — TRUNCATE takes no bind parameters — so
    // anything that would need quoting is refused rather than quoted.
    throw new Error(
      `Refusing to truncate tables with unexpected names: ${unexpected.join(', ')}. ` +
        'Posting_Store tables must be plain identifiers.',
    );
  }

  if (names.length === 0) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${names.map((name) => `"public"."${name}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
};

/**
 * Waits until no Scrape_Run of a previous spec is still writing, before the truncation.
 *
 * The race this closes was visible in the E2E output as a `LogMessage_runId_fkey` foreign key
 * violation, one ERROR saying a Scrape_Run could not be closed because "No record was found for an
 * update", and several warnings that a Job_Posting "was gone before it could be enriched". All 47
 * specs passed through it, which is exactly why it had to be removed rather than tolerated: a suite
 * that is green over a bed of ERROR lines is a suite nobody reads the output of, and the next real
 * failure hides in it.
 *
 * The cause is a Scrape_Run of the preceding spec. A fixture-mode run is alive for roughly 130
 * milliseconds, so a spec that starts one and asserts on the Log_View typically ends while the
 * API_Service is still closing the run, writing its last Log_Stream line and finishing the
 * enrichment stages. The `TRUNCATE` of the next spec's seeding then pulls the rows out from under
 * those writes.
 *
 * Two conditions have to hold, and the second is what makes the first enough:
 *
 * 1. **No `ScrapeRun` row is marked `RUNNING`.** That covers the enrichment stages and the closing
 *    update, because both happen before the status is written.
 * 2. **The `LogMessage` count is unchanged since the previous look.** A handful of writes follow the
 *    closing update — the end-of-run summary, the counters of 15.16 — and a store that stopped
 *    growing is the observable form of "nothing is in flight any more".
 *
 * Nothing is silenced and no logging is changed: the waiting happens in the harness, which is where
 * the knowledge that a previous spec may still be settling belongs. A timeout throws and names the
 * cause rather than truncating anyway, because truncating anyway is the behaviour that was wrong.
 */
export const awaitSettledScrapeRun = async (prisma: PrismaService): Promise<void> => {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previousMessageCount: number | null = null;

  for (;;) {
    const running = await prisma.scrapeRun.count({ where: { status: 'RUNNING' } });
    const messages = await prisma.logMessage.count();

    if (running === 0 && previousMessageCount === messages) {
      return;
    }

    previousMessageCount = running === 0 ? messages : null;

    if (Date.now() >= deadline) {
      throw new Error(
        `A Scrape_Run of the previous spec has not settled within ${String(SETTLE_TIMEOUT_MS)} ms: ` +
          `${String(running)} Scrape_Run still marked "running", ${String(messages)} Log_Stream ` +
          'messages stored. Truncating now would pull the rows out from under the writes still in ' +
          'flight, which is the foreign key violation this wait exists to prevent.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
};

/** Truncates the Posting_Store and writes one scenario into it. */
export const seedE2eScenario = async (request: E2eSeedRequest): Promise<SeededScenario> => {
  const prisma = new PrismaService({ datasourceUrl: request.databaseUrl });

  try {
    await prisma.$connect();
    await awaitSettledScrapeRun(prisma);
    await truncatePostingStore(prisma);

    return await E2E_SCENARIO_SEEDERS[request.scenario](prisma);
  } finally {
    await prisma.$disconnect();
  }
};

/** The command line entry point. */
const main = async (): Promise<void> => {
  const result = await seedE2eScenario(parseE2eSeedArgs(process.argv.slice(2)));

  // One JSON line on stdout, so the caller parses rather than scrapes.
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
