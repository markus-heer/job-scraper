/**
 * Step 5: apply the pending Prisma migrations (1.1, 1.2, 1.14).
 *
 * ## `migrate deploy`, not `migrate dev`
 *
 * 1.14 is about *applying pending* migrations, and `deploy` is the command that does exactly that: it
 * runs each migration file once, in ascending order, records it in `_prisma_migrations`, and never
 * generates, resets or drops anything. `migrate dev` would compare the schema against the database and
 * offer to reset it — on the user's own Posting_Store, which 1.10 and 1.14 both forbid touching. The
 * integration harness (`apps/api/src/testing/postgres-harness.ts`) invokes the same command for the
 * same reason, so the start and the test suite migrate identically.
 *
 * No timeout: a migration that is killed halfway is the one thing worse than a migration that is slow.
 * Prisma wraps each migration in a transaction, so an interrupted process leaves the data as it was,
 * but the failed row it leaves in `_prisma_migrations` then needs a manual `migrate resolve`.
 *
 * ## The connection
 *
 * `DATABASE_URL` is handed to the child through the runner's `env` option — never as a `VAR=value`
 * prefix. It matters that it is passed explicitly rather than only inherited: the Prisma CLI looks for
 * an environment file next to the schema, so a stray `apps/api/.env` would otherwise decide which
 * database the start migrates. Passing the value the Start_Script itself resolved keeps step 4 and
 * step 5 pointed at the same Posting_Store.
 *
 * ## Naming the failed migration
 *
 * 1.14 asks for the *name* of the failed migration, so {@link extractMigrationFailure} reads it out of
 * Prisma's output as a pure function over text, and the Vitest suite drives it with the real output of
 * both failure shapes (`P3018` while applying, `P3009` on a start after one already failed) rather than
 * with invented text.
 *
 * Requirements: 1.1, 1.2, 1.14.
 */

import { extractFailureDetail } from './command-runner.mjs';
import { EXIT_CODES, StartStepError } from './errors.mjs';
import { PRISMA_MIGRATION_OUTCOMES } from './outcomes.mjs';
import { prismaMigrationFailedError } from './start.messages.mjs';
import { START_STEPS } from './steps.mjs';

/** The workspace package that owns `prisma/schema.prisma` and the Prisma CLI. */
export const PRISMA_OWNER_PACKAGE = '@job-scraper/api';

/**
 * The command of step 5.
 *
 * Run through `pnpm --filter`, so the CLI of that package and its working directory are used and the
 * schema is found where it lives — the same shape step 3 uses for Playwright.
 */
export const PRISMA_MIGRATE_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze(['--filter', PRISMA_OWNER_PACKAGE, 'exec', 'prisma', 'migrate', 'deploy']),
});

/** What Prisma prints when the Posting_Store is already at the current migration state. */
export const NOTHING_PENDING_MARKER = 'No pending migrations to apply';

/** `Migration name: 20261028090000_add_probe_index` — the `P3018` shape, printed while applying. */
const MIGRATION_NAME_PATTERN = /^Migration name:\s*(\S+)\s*$/m;

/** The `P3009` shape: ``The `20261028090000_add_probe_index` migration started at … failed``. */
const FAILED_MIGRATION_PATTERN = /The `([^`]+)` migration started at [^\n]* failed/;

/** ``Applying migration `20261028090000_add_probe_index` `` — the last one Prisma began. */
const APPLYING_MIGRATION_PATTERN = /Applying migration `([^`]+)`/g;

/** `Error: P3018` — the Prisma error code, named in the German message next to the migration. */
const ERROR_CODE_PATTERN = /^Error: (P\d{4})\b/m;

/** The database error Prisma quotes under its own code, which is the line that says what went wrong. */
const DATABASE_ERROR_PATTERN = /^Database error:\s*\n(.+)$/m;

/** The sentence Prisma prints under its error code, used where there is no database error to quote. */
const ERROR_SUMMARY_PATTERN = /^Error: P\d{4}\s*\n(.+)$/m;

/**
 * What a failed `prisma migrate deploy` says about itself.
 *
 * @typedef {object} MigrationFailure
 * @property {string | null} migrationName The migration 1.14 asks to be named, or `null` when the
 *   output did not reveal one.
 * @property {string | null} errorCode The Prisma error code, for example `P3018`.
 * @property {string | null} detail The one line the German message quotes as the reported cause.
 */

/**
 * Reads the failed migration and the reported cause out of Prisma's output (1.14).
 *
 * Three name sources, in this order, because they are increasingly indirect:
 *
 * 1. `Migration name:` — printed with `P3018` when a migration failed while being applied. The name
 *    Prisma itself calls the failed one;
 * 2. ``The `…` migration started at … failed`` — printed with `P3009` on a later start, when a failed
 *    migration is still recorded in the database. The start then applies nothing at all, and this is
 *    the only name in the output;
 * 3. the last ``Applying migration `…` `` line — a fallback for a failure that produced neither code,
 *    for instance a connection that dropped mid-migration. Prisma prints one such line per migration it
 *    begins, so the last one is the one that did not finish.
 *
 * Both streams are read as one text: Prisma prints its progress on stdout and its error block on
 * stderr, and 1.14 cares about neither distinction.
 *
 * @param {import('./command-runner.mjs').CommandResult} result
 * @returns {MigrationFailure}
 */
export function extractMigrationFailure(result) {
  const output = `${result.stdout}\n${result.stderr}`;

  return {
    migrationName: readMigrationName(output),
    errorCode: ERROR_CODE_PATTERN.exec(output)?.[1] ?? null,
    detail: readFailureDetail(output, result),
  };
}

/**
 * Whether the run applied something or found the Posting_Store already current.
 *
 * @param {import('./command-runner.mjs').CommandResult} result
 * @returns {string} One of {@link PRISMA_MIGRATION_OUTCOMES}.
 */
export function classifyMigrationSuccess(result) {
  return result.stdout.includes(NOTHING_PENDING_MARKER)
    ? PRISMA_MIGRATION_OUTCOMES.ALREADY_UP_TO_DATE
    : PRISMA_MIGRATION_OUTCOMES.APPLIED;
}

/**
 * Runs step 5: one progress line, then one `prisma migrate deploy`.
 *
 * @param {object} dependencies
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {NodeJS.ProcessEnv} [dependencies.env] Where `DATABASE_URL` is read from.
 * @returns {Promise<{ outcome: string }>}
 * @throws {StartStepError} When a migration fails (1.14). The orchestrator prints `messageDe` and exits
 *   non-zero, so neither the API_Service nor the Web_App is started.
 */
export async function runPrismaMigrationStep({ run, reporter, env = process.env }) {
  reporter.progress(START_STEPS.PRISMA_MIGRATIONS);

  const databaseUrl = env.DATABASE_URL;
  const result = await run(
    databaseUrl === undefined || databaseUrl === ''
      ? PRISMA_MIGRATE_COMMAND
      : { ...PRISMA_MIGRATE_COMMAND, env: { DATABASE_URL: databaseUrl } },
  );

  if (result.ok) {
    return { outcome: classifyMigrationSuccess(result) };
  }

  const failure = extractMigrationFailure(result);

  throw new StartStepError({
    message: `A pending Prisma migration failed: ${failure.migrationName ?? 'unknown migration'} (1.14).`,
    messageDe: prismaMigrationFailedError({ ...failure, exitCode: result.code }),
    code: 'PRISMA_MIGRATION_FAILED',
    exitCode: EXIT_CODES.PRISMA_MIGRATION_FAILED,
  });
}

/**
 * The one line the German message quotes as the reported cause.
 *
 * The database error first, because that is the statement PostgreSQL rejected and therefore the thing
 * to fix; then the sentence Prisma prints under its own error code, which is all there is when the
 * migration never ran (`P3009`); then the generic first cause line, which covers an output that matches
 * neither shape.
 *
 * @param {string} output
 * @param {import('./command-runner.mjs').CommandResult} result
 * @returns {string | null}
 */
function readFailureDetail(output, result) {
  const quoted = DATABASE_ERROR_PATTERN.exec(output) ?? ERROR_SUMMARY_PATTERN.exec(output);

  return quoted === null ? extractFailureDetail(result) : quoted[1].trim();
}

/**
 * The name of the failed migration, from the most direct source the output offers.
 *
 * @param {string} output
 * @returns {string | null}
 */
function readMigrationName(output) {
  const named = MIGRATION_NAME_PATTERN.exec(output) ?? FAILED_MIGRATION_PATTERN.exec(output);

  if (named !== null) {
    return named[1];
  }

  const applied = [...output.matchAll(APPLYING_MIGRATION_PATTERN)];

  return applied.length === 0 ? null : applied[applied.length - 1][1];
}
