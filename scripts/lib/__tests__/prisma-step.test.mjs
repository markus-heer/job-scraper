/**
 * Step 5 of the Start_Script: applying the pending migrations and the fatal failure of 1.14.
 *
 * The three outputs below are recorded, not invented. They come from a real
 * `prisma migrate deploy` against a throwaway PostgreSQL 16 container with a deliberately broken
 * migration — a `CREATE INDEX` on a column that does not exist — and they cover the two shapes a user
 * can hit: the failure while applying (`P3018`) and the failure that is still recorded in the database
 * on the next start (`P3009`). Requirement 1.14 asks for the *name* of the failed migration, and these
 * are the texts that name it.
 *
 * No test runs a migration: every command goes through the injected fake runner, and the real
 * `job-tool-postgres` container is never contacted.
 */

import { describe, expect, it } from 'vitest';

import { EXIT_CODES, StartStepError } from '../errors.mjs';
import { PRISMA_MIGRATION_OUTCOMES } from '../outcomes.mjs';
import {
  classifyMigrationSuccess,
  extractMigrationFailure,
  PRISMA_MIGRATE_COMMAND,
  runPrismaMigrationStep,
} from '../prisma-step.mjs';
import { createReporter } from '../reporter.mjs';
import {
  commandKey,
  completeResult,
  createFakeCommandRunner,
  createRecordingReporter,
  failure,
  success,
} from './fake-command-runner.mjs';

const MIGRATE_KEY = commandKey(PRISMA_MIGRATE_COMMAND);
const DATABASE_URL = 'postgresql://jobtool:change-me@127.0.0.1:55432/jobtool?schema=public';

/** The migration that fails in the recorded outputs. */
const BROKEN_MIGRATION = '20261028090000_add_probe_index';

/** Recorded: a migration that fails while being applied. Prisma reports `P3018`. */
const P3018_OUTPUT = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Datasource "db": PostgreSQL database "jobtool", schema "public" at "127.0.0.1:55432"',
  '2 migrations found in prisma/migrations',
  'Applying migration `20261027173123_init`',
  `Applying migration \`${BROKEN_MIGRATION}\``,
  'Error: P3018',
  'A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve',
  `Migration name: ${BROKEN_MIGRATION}`,
  'Database error code: 42703',
  'Database error:',
  'ERROR: column "doesNotExist" does not exist',
  '',
].join('\n');

/** Recorded: a later start, with the failed migration still recorded in the database (`P3009`). */
const P3009_OUTPUT = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Datasource "db": PostgreSQL database "jobtool", schema "public" at "127.0.0.1:55432"',
  '2 migrations found in prisma/migrations',
  'Error: P3009',
  'migrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve',
  `The \`${BROKEN_MIGRATION}\` migration started at 2026-10-29 08:44:22.342903 UTC failed`,
  '',
].join('\n');

/** Recorded: the common case on a second start, with nothing left to do. */
const NOTHING_PENDING_OUTPUT = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Datasource "db": PostgreSQL database "jobtool", schema "public" at "127.0.0.1:55432"',
  '1 migration found in prisma/migrations',
  '',
  'No pending migrations to apply.',
  '',
].join('\n');

/** Recorded: a first start that applies the one migration of this repository. */
const APPLIED_OUTPUT = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Datasource "db": PostgreSQL database "jobtool", schema "public" at "127.0.0.1:55432"',
  '1 migration found in prisma/migrations',
  'Applying migration `20261027173123_init`',
  'The following migration have been applied:',
  '',
  'migrations/',
  '  └─ 20261027173123_init/',
  '    └─ migration.sql',
  '      ',
  'All migrations have been successfully applied.',
  '',
].join('\n');

/** A failed command carrying the given Prisma output on stdout, as the CLI prints it. */
function migrationFailure(stdout) {
  return completeResult(PRISMA_MIGRATE_COMMAND, failure({ code: 1, stdout }));
}

describe('extractMigrationFailure (1.14)', () => {
  it('names the migration Prisma reports as failed while applying', () => {
    expect(extractMigrationFailure(migrationFailure(P3018_OUTPUT))).toStrictEqual({
      migrationName: BROKEN_MIGRATION,
      errorCode: 'P3018',
      detail: 'ERROR: column "doesNotExist" does not exist',
    });
  });

  it('names the migration still recorded as failed on a later start', () => {
    const extracted = extractMigrationFailure(migrationFailure(P3009_OUTPUT));

    expect(extracted.migrationName).toBe(BROKEN_MIGRATION);
    expect(extracted.errorCode).toBe('P3009');
    expect(extracted.detail).toContain('migrate found failed migrations');
  });

  it('falls back to the last migration Prisma began when no code is reported', () => {
    const interrupted = [
      '2 migrations found in prisma/migrations',
      'Applying migration `20261027173123_init`',
      `Applying migration \`${BROKEN_MIGRATION}\``,
      'Error: Server has closed the connection.',
      '',
    ].join('\n');

    expect(extractMigrationFailure(migrationFailure(interrupted))).toStrictEqual({
      migrationName: BROKEN_MIGRATION,
      errorCode: null,
      detail: 'Error: Server has closed the connection.',
    });
  });

  it('reads the error block from stderr as well, not only from stdout', () => {
    const result = completeResult(
      PRISMA_MIGRATE_COMMAND,
      failure({ code: 1, stdout: '', stderr: P3018_OUTPUT }),
    );

    expect(extractMigrationFailure(result).migrationName).toBe(BROKEN_MIGRATION);
  });

  it('names no migration when the output reveals none', () => {
    const noConnection = completeResult(
      PRISMA_MIGRATE_COMMAND,
      failure({
        code: 1,
        stdout: "Error: P1001\nCan't reach database server at `127.0.0.1:55432`\n",
      }),
    );
    const extracted = extractMigrationFailure(noConnection);

    expect(extracted.migrationName).toBeNull();
    expect(extracted.errorCode).toBe('P1001');
  });
});

describe('classifyMigrationSuccess', () => {
  it('reports an applied migration', () => {
    expect(
      classifyMigrationSuccess(completeResult(PRISMA_MIGRATE_COMMAND, success(APPLIED_OUTPUT))),
    ).toBe(PRISMA_MIGRATION_OUTCOMES.APPLIED);
  });

  it('reports a Posting_Store that is already current', () => {
    expect(
      classifyMigrationSuccess(
        completeResult(PRISMA_MIGRATE_COMMAND, success(NOTHING_PENDING_OUTPUT)),
      ),
    ).toBe(PRISMA_MIGRATION_OUTCOMES.ALREADY_UP_TO_DATE);
  });
});

describe('runPrismaMigrationStep', () => {
  it('applies the pending migrations with one progress line (1.1, 1.2, 1.14)', async () => {
    const run = createFakeCommandRunner({ [MIGRATE_KEY]: success(APPLIED_OUTPUT) });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    const result = await runPrismaMigrationStep({ run, reporter, env: { DATABASE_URL } });

    expect(result.outcome).toBe(PRISMA_MIGRATION_OUTCOMES.APPLIED);
    expect(out).toStrictEqual(['Schritt 5 von 7: Offene Datenbankaktualisierungen einspielen …']);
    expect(errorLines).toHaveLength(0);
  });

  it('deploys rather than developing, and passes the connection through the child environment', async () => {
    const run = createFakeCommandRunner({ [MIGRATE_KEY]: success(NOTHING_PENDING_OUTPUT) });
    const { reporter } = createRecordingReporter(createReporter);

    await runPrismaMigrationStep({ run, reporter, env: { DATABASE_URL } });

    expect(PRISMA_MIGRATE_COMMAND.args).toContain('deploy');
    expect(PRISMA_MIGRATE_COMMAND.args).not.toContain('dev');
    expect(run.invocations).toHaveLength(1);
    expect(run.invocations[0].command).toBe('pnpm');
    expect(run.invocations[0].env).toStrictEqual({ DATABASE_URL });
  });

  it('names the failed migration and exits non-zero (1.14)', async () => {
    const run = createFakeCommandRunner({
      [MIGRATE_KEY]: failure({ code: 1, stdout: P3018_OUTPUT }),
    });
    const { reporter, out } = createRecordingReporter(createReporter);

    const error = await runPrismaMigrationStep({
      run,
      reporter,
      env: { DATABASE_URL },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.exitCode).toBe(EXIT_CODES.PRISMA_MIGRATION_FAILED);
    expect(error.exitCode).not.toBe(EXIT_CODES.SUCCESS);
    expect(error.messageDe).toContain(BROKEN_MIGRATION);
    expect(error.messageDe).toContain('ERROR: column "doesNotExist" does not exist');
    expect(error.messageDe).toContain('gespeicherten Daten bleiben unverändert');
    expect(out).toHaveLength(1);
  });

  it('names the migration still recorded as failed on a later start (1.14)', async () => {
    const run = createFakeCommandRunner({
      [MIGRATE_KEY]: failure({ code: 1, stdout: P3009_OUTPUT }),
    });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runPrismaMigrationStep({
      run,
      reporter,
      env: { DATABASE_URL },
    }).catch((caught) => caught);

    expect(error.messageDe).toContain(BROKEN_MIGRATION);
    expect(error.messageDe).toContain('P3009');
  });

  it('says so when the failed migration cannot be named', async () => {
    const run = createFakeCommandRunner({
      [MIGRATE_KEY]: failure({ code: 1, stderr: 'Error: P1001\n' }),
    });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runPrismaMigrationStep({ run, reporter, env: {} }).catch(
      (caught) => caught,
    );

    expect(error.messageDe).toContain('nicht ermittelbar');
    expect(run.invocations[0].env).toBeUndefined();
  });
});
