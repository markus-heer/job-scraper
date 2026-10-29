/**
 * The PostgreSQL integration harness (9.6).
 *
 * `usePostgres()` is called once at the top of an `*.integration.test.ts` file. It registers the
 * Vitest hooks that start a throwaway PostgreSQL 16 container for that file, apply
 * `prisma migrate deploy` to it and hand the tests a connected `PrismaService` pointing at the
 * container. Nothing in the harness ever touches the development Posting_Store: the connection
 * string comes from the container and from nowhere else, so `DATABASE_URL` of the local `.env` is
 * irrelevant to an integration test.
 *
 * Why a real engine and no fallback: the questions the integration tests ask — upsert idempotence
 * against the real `(platform, postingId)` unique constraint (Properties 7 and 8), the gated
 * "no longer listed" sweep (Property 9), the `(runId, sequence)` constraint under concurrent
 * emission, SQL sorting and pagination (Properties 24 – 26), migration replay — are questions about
 * PostgreSQL semantics. Answering them on SQLite would assert the behaviour of a different engine,
 * so an absent Docker daemon fails the suite with an explicit message instead of degrading quietly.
 *
 * Why the image is the one from `docker-compose.yml`: `postgres:16-alpine` is already on any
 * machine that ran the Start_Script, so the harness needs no image pull in the common case, and the
 * engine under test is the engine the Job_Tool runs against in production.
 *
 * Isolation per test is `TRUNCATE ... RESTART IDENTITY CASCADE` over every table except Prisma's
 * migration bookkeeping. The alternative — a template database restored per test, which
 * Testcontainers also offers — has to drop and recreate the database and therefore needs every
 * client connection closed first; truncation keeps the connection pool and the applied migrations
 * in place and costs a single statement.
 *
 * Usage:
 *
 * ```ts
 * const postgres = usePostgres();
 *
 * it('stores a Job_Posting', async () => {
 *   await postgres.prisma.scrapeRun.create({ data: ... });
 * });
 * ```
 *
 * `postgres.prisma` is a `PrismaService`, not a bare `PrismaClient`, so a test that needs the Nest
 * module graph (the read-layer tests of task 15.10) can bind the same instance with
 * `.overrideProvider(PrismaService).useValue(postgres.prisma)`. A Nest context that owns the
 * instance calls `onModuleDestroy` on close and disconnects it; the client reconnects on the next
 * query, and the per-test truncation is such a query, so a following test still finds an open
 * connection.
 *
 * Requirements: 9.6.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { PrismaService } from '../prisma/prisma.service';

const execFileAsync = promisify(execFile);

/** The engine under test, identical to the image in `docker-compose.yml` (1.10). */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

/** Database, user and password of the throwaway container. No secret: it lives for one test file. */
const CONTAINER_DATABASE = 'jobtool_test';
const CONTAINER_USER = 'jobtool';
const CONTAINER_PASSWORD = 'jobtool';

/** Prisma's own bookkeeping table; it records which migration ran and must survive a truncation. */
export const MIGRATIONS_TABLE = '_prisma_migrations';

/**
 * Budget for starting the container plus applying the migrations, and for stopping it again.
 *
 * Generous on purpose: the first run on a machine without the image has to pull it, and Vitest's
 * default 5-second hook timeout would turn that into a confusing failure instead of a slow start.
 */
export const CONTAINER_LIFECYCLE_TIMEOUT_MS = 180_000;

/** `src/testing` sits two levels below the package root, in `dist` as well as in `src`. */
const PACKAGE_ROOT = join(__dirname, '..', '..');
const PRISMA_SCHEMA = join(PACKAGE_ROOT, 'prisma', 'schema.prisma');
const PRISMA_CLI = join(PACKAGE_ROOT, 'node_modules', '.bin', 'prisma');

/** Unquoted PostgreSQL identifier; everything read out of `information_schema` has to match. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reads a thrown value as a message without assuming it is an `Error`. */
const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The message a developer sees when no Docker daemon can be reached.
 *
 * Exported so the offline suite can assert its content: 9.6 asks for a fail-fast with an explicit
 * message rather than a fallback engine, and that promise is about this text. It names what was
 * attempted, why no other database is substituted, and the one command that makes the integration
 * suite run.
 */
export const dockerUnavailableMessage = (cause: unknown): string =>
  [
    `Could not start the ${POSTGRES_IMAGE} container for the integration tests.`,
    'These tests run against real PostgreSQL by design: the unique constraints, the sweep, the SQL',
    'sorting and the migration replay are statements about this engine, so there is no fallback to',
    'another database such as SQLite.',
    'Start the Docker daemon and run `pnpm test:integration` again. The unit suite (`pnpm test`)',
    'needs no Docker and is unaffected.',
    `Underlying failure: ${describeFailure(cause)}`,
  ].join('\n');

/**
 * Applies every pending migration in ascending version order to `databaseUrl`.
 *
 * `prisma migrate deploy` is run as the Prisma CLI rather than reimplemented, because that is the
 * command 9.6 is about: it executes each migration exactly once, in order, and records it in
 * `_prisma_migrations`. Running it a second time is therefore the migration replay the task asks
 * for — it must apply nothing and keep the stored data.
 *
 * Returned is the CLI output, so a test can assert on what the replay did.
 */
export const applyMigrations = async (databaseUrl: string): Promise<string> => {
  if (!existsSync(PRISMA_CLI) || !existsSync(PRISMA_SCHEMA)) {
    throw new Error(
      `The Prisma CLI or the schema was not found below ${PACKAGE_ROOT}. ` +
        'The integration harness resolves both relative to the @job-scraper/api package root; ' +
        'run `pnpm install` in the workspace before running the integration tests.',
    );
  }

  const { stdout } = await execFileAsync(PRISMA_CLI, ['migrate', 'deploy'], {
    cwd: PACKAGE_ROOT,
    // The CLI reads the connection from the environment. Passing it here rather than exporting it
    // keeps the development DATABASE_URL of the shell and of `.env` out of reach of this process.
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  return stdout;
};

/**
 * Connection string for Prisma, with the schema the migrations were written against.
 *
 * Testcontainers hands out a `postgres://` URI. Prisma accepts that spelling as well, but the
 * `datasource` block and `.env.example` both use `postgresql://`, so the harness normalizes it —
 * a test that compares the harness URL against a configured one then compares like with like. The
 * scheme is swapped on the serialized string because the URL scheme setter refuses the change:
 * neither spelling is a "special" scheme to the WHATWG parser.
 */
const toPrismaUrl = (connectionUri: string): string => {
  const url = new URL(connectionUri);
  url.searchParams.set('schema', 'public');

  return url.toString().replace(/^postgres:\/\//, 'postgresql://');
};

/** The tables the per-test truncation clears, in a stable order. */
const readTableNames = async (prisma: PrismaService): Promise<readonly string[]> => {
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
    // Defence in depth rather than a reachable case: the names come from the migrations in this
    // repository. Interpolating an identifier into DDL is unavoidable — TRUNCATE takes no bind
    // parameters — so anything that would need quoting is refused instead of quoted.
    throw new Error(
      `Refusing to truncate tables with unexpected names: ${unexpected.join(', ')}. ` +
        'Integration tables must be plain identifiers.',
    );
  }

  return names;
};

/** Options of one harness instance. */
export interface PostgresHarnessOptions {
  /**
   * Clear every table before each test. On by default, so no test can see another's rows.
   *
   * Switched off by a test that builds its data set once in `beforeAll` and only reads afterwards —
   * the read-layer tests of task 15.10 are the expected case.
   */
  readonly truncateBetweenTests?: boolean;
}

/** What a test file gets back from {@link usePostgres}. */
export interface PostgresHarness {
  /** The connected client against the container, valid from the first test until the last. */
  readonly prisma: PrismaService;
  /** Connection string of the container, for a process or Nest module that needs it directly. */
  readonly databaseUrl: string;
  /** Clears every table except the migration bookkeeping. */
  truncate(): Promise<void>;
  /** Runs `prisma migrate deploy` against the container again (the replay of 9.6). */
  replayMigrations(): Promise<string>;
}

/**
 * Starts a PostgreSQL container for the current test file and migrates it.
 *
 * Call this at the top level of the file, outside `describe`: it registers `beforeAll`,
 * `beforeEach` and `afterAll`. One container per file, as the Testing Strategy prescribes, so a
 * file cannot be influenced by another file's data or by its schema state.
 */
export const usePostgres = (options: PostgresHarnessOptions = {}): PostgresHarness => {
  const { truncateBetweenTests = true } = options;

  let container: StartedPostgreSqlContainer | undefined;
  let prisma: PrismaService | undefined;
  let databaseUrl: string | undefined;
  let tableNames: readonly string[] | undefined;

  const started = <TValue>(value: TValue | undefined, member: string): TValue => {
    if (value === undefined) {
      throw new Error(
        `The PostgreSQL harness is not running, so \`${member}\` is unavailable. ` +
          'Call usePostgres() at the top level of the test file and read its members inside a ' +
          'test or in a hook that runs after the harness beforeAll.',
      );
    }

    return value;
  };

  const truncate = async (): Promise<void> => {
    const client = started(prisma, 'prisma');

    tableNames ??= await readTableNames(client);

    if (tableNames.length === 0) {
      return;
    }

    const list = tableNames.map((name) => `"public"."${name}"`).join(', ');

    // One statement for all tables: TRUNCATE is atomic over the list, so the foreign keys between
    // Job_Posting, Scrape_Run and the log messages never see a half-cleared store. CASCADE covers
    // a table a later migration adds without this list being updated; RESTART IDENTITY resets the
    // sequences, so an identifier from a previous test cannot reappear with different content.
    await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  };

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase(CONTAINER_DATABASE)
        .withUsername(CONTAINER_USER)
        .withPassword(CONTAINER_PASSWORD)
        .start();
    } catch (cause) {
      throw new Error(dockerUnavailableMessage(cause), { cause });
    }

    databaseUrl = toPrismaUrl(container.getConnectionUri());

    await applyMigrations(databaseUrl);

    prisma = new PrismaService({ datasourceUrl: databaseUrl });

    // Connected here rather than through `onModuleInit`, because no Nest context owns this
    // instance yet and the lifecycle hook would only add log noise to every integration file.
    await prisma.$connect();
  }, CONTAINER_LIFECYCLE_TIMEOUT_MS);

  if (truncateBetweenTests) {
    beforeEach(async () => {
      await truncate();
    });
  }

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      // Stopped even when the disconnect fails: a leaked container would survive the test run and
      // keep its port and its volume.
      await container?.stop();

      prisma = undefined;
      container = undefined;
      databaseUrl = undefined;
      tableNames = undefined;
    }
  }, CONTAINER_LIFECYCLE_TIMEOUT_MS);

  return {
    get prisma(): PrismaService {
      return started(prisma, 'prisma');
    },
    get databaseUrl(): string {
      return started(databaseUrl, 'databaseUrl');
    },
    truncate,
    replayMigrations: async (): Promise<string> =>
      applyMigrations(started(databaseUrl, 'databaseUrl')),
  };
};
