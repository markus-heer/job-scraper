/**
 * Starts the throwaway Posting_Store and the API_Service in fixture mode (task 21.1).
 *
 * `webServer` in `../../playwright.config.ts` runs this file with the hand-off path as an argument.
 * It does three things, in order, and owns all three for the lifetime of one test run:
 *
 * 1. starts a PostgreSQL 16 container and applies `prisma migrate deploy` to it;
 * 2. writes its connection string to the hand-off file, which is how the spec workers find the same
 *    database (see `./handoff.ts`);
 * 3. boots the API_Service in-process with `SCRAPER_FIXTURE_MODE` on.
 *
 * ## Why a script, and why it owns the database
 *
 * Playwright starts the processes of `webServer` before it runs `globalSetup`, so a container started
 * there would not exist yet when the API_Service connected to it. Owning it here is also the natural
 * arrangement: the Posting_Store exists exactly as long as the API_Service that uses it.
 *
 * It has to be a script rather than a command line for a second reason as well. A shell command in
 * this repository must begin with the name of the program it runs, so `DATABASE_URL=… node …` is not
 * an option and `env DATABASE_URL=… node …` is the same thing wearing a different hat. Setting the
 * two variables inside the process that is about to boot leaves the command line as a plain `node`
 * invocation.
 *
 * `bootstrap` is imported and called rather than spawned as a child process: the API_Service becomes
 * *this* process, so Playwright's own teardown — which kills what it started — reaches it directly,
 * with no signal forwarding to get wrong and no orphaned Node left holding the API port.
 *
 * ## Why it is never the development container
 *
 * `docker-compose.yml` starts `job-tool-postgres` with the database `jobtool`, which holds the
 * developer's Job_Posting, their Scrape_Run history and their relevance assessments. The harness
 * truncates the Posting_Store before every spec, so pointing it there would destroy real data on the
 * first run, and silently — a passing test says nothing about what it deleted. The container below is
 * therefore a throwaway one, named `jobtool_test` so that it ends in the suffix the API_Service's own
 * fixture-mode guard and the seeding command both insist on. A connection string that could be the
 * development database is refused by both before anything is written.
 *
 * One container for the whole run rather than one per spec file, unlike the integration suite: a spec
 * here costs a browser and a page load, so per-file isolation would dominate the runtime. Isolation
 * comes from the per-spec seeding instead, which truncates.
 *
 * What this script does *not* decide is anything about fixture mode beyond switching it on. Which
 * Platform_Adapter, Routing_Provider and AI_Provider a fixture-mode process gets is decided by the
 * module factories of the API_Service, and the real implementations refuse to be constructed while
 * the switch is on — see `apps/api/src/config/fixture-mode.ts`.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer } from '@testcontainers/postgresql';

const execFileAsync = promisify(execFile);

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(harnessDir, '..', '..', '..', '..');
const apiPackageRoot = join(repositoryRoot, 'apps', 'api');
const apiEntryPoint = join(apiPackageRoot, 'dist', 'main.js');
const prismaCli = join(apiPackageRoot, 'node_modules', '.bin', 'prisma');

/** The engine under test, identical to `docker-compose.yml` and to the integration harness. */
const POSTGRES_IMAGE = 'postgres:16-alpine';

/**
 * Database, user and password of the throwaway container.
 *
 * The name has to end in `_test`: the fixture-mode guard of the API_Service and the seeding command
 * both refuse anything else, which is what makes "the E2E run never touches the development
 * Posting_Store" a property of the code rather than of this file.
 */
const CONTAINER_DATABASE = 'jobtool_test';
const CONTAINER_USER = 'jobtool';
const CONTAINER_PASSWORD = 'jobtool';

/**
 * Where to write the connection string.
 *
 * Passed in rather than computed, so `./handoff.ts` is the single declaration of the path and the
 * writer and the reader of this file cannot disagree about where it is.
 */
const handoffPathFromArgs = () => {
  const index = process.argv.indexOf('--handoff');
  const path = index === -1 ? undefined : process.argv[index + 1];

  if (path === undefined || path === '') {
    throw new Error(
      'Usage: node e2e/harness/start-api.mjs --handoff <path>. The path is HANDOFF_PATH of ' +
        'e2e/harness/handoff.ts and is passed by the webServer entry of playwright.config.ts.',
    );
  }

  return path;
};

/** The message a developer sees when no Docker daemon can be reached. */
const dockerUnavailableMessage = (cause) =>
  [
    `Could not start the ${POSTGRES_IMAGE} container for the E2E suite.`,
    'The E2E specs run against a real Posting_Store by design — they assert the filtering, the',
    'sorting and the pagination of the posting overview, which are SQL behaviour — and the harness',
    'never falls back to the development database, because it truncates everything it connects to.',
    'Start the Docker daemon and run `pnpm test:e2e` again.',
    `Underlying failure: ${cause instanceof Error ? cause.message : String(cause)}`,
  ].join('\n');

/**
 * Connection string for Prisma, normalized the way the integration harness normalizes it.
 *
 * Testcontainers hands out a `postgres://` URI, which Prisma accepts, but `.env.example` and the
 * `datasource` block both spell it `postgresql://` — and the fixture-mode guard reads the database
 * name off this string, so one spelling everywhere is one thing fewer to get wrong. The scheme is
 * swapped on the serialized string because the URL scheme setter refuses the change: neither
 * spelling is a "special" scheme to the WHATWG parser.
 */
const toPrismaUrl = (connectionUri) => {
  const url = new URL(connectionUri);

  url.searchParams.set('schema', 'public');

  return url.toString().replace(/^postgres:\/\//, 'postgresql://');
};

const handoffPath = handoffPathFromArgs();

let container;

try {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(CONTAINER_DATABASE)
    .withUsername(CONTAINER_USER)
    .withPassword(CONTAINER_PASSWORD)
    .start();
} catch (cause) {
  throw new Error(dockerUnavailableMessage(cause), { cause });
}

const databaseUrl = toPrismaUrl(container.getConnectionUri());

/**
 * Stops the container when this process ends.
 *
 * Testcontainers' own reaper removes the container when this process's connection to it drops, so
 * even a `SIGKILL` from Playwright leaves nothing behind; these handlers are the orderly path, which
 * is faster and keeps the Docker output of a normal run clean.
 */
const stopContainer = async () => {
  const running = container;

  container = undefined;

  await running?.stop();
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void stopContainer().finally(() => {
      process.exit(0);
    });
  });
}

// `prisma migrate deploy` as the CLI rather than reimplemented, because that is the command 9.6 is
// about: each migration exactly once, in ascending version order. The connection string reaches it
// through the child process environment and not through the shell, so the development DATABASE_URL
// of the developer's shell and of `.env` stays out of reach.
await execFileAsync(prismaCli, ['migrate', 'deploy'], {
  cwd: apiPackageRoot,
  env: { ...process.env, DATABASE_URL: databaseUrl },
});

mkdirSync(dirname(handoffPath), { recursive: true });
writeFileSync(handoffPath, `${JSON.stringify({ databaseUrl }, null, 2)}\n`, 'utf8');

/**
 * The configuration the API_Service under test runs with.
 *
 * Every required key of `.env.example` is pinned here rather than read from the developer's `.env`,
 * and that is the point rather than a convenience:
 *
 * - **Reproducibility.** The seeded data sets and the assertions on them are built around these
 *   values — the Commute_Threshold of 8.3 in particular decides which Job_Posting counts as "gut
 *   erreichbar" and therefore what the reachability filter of 10.5 returns. A developer whose `.env`
 *   says 90 minutes would see different rows than CI does.
 * - **Credentials stay out of the test process.** `ROUTING_API_KEY` and `ANTHROPIC_API_KEY` are
 *   required by the configuration check but are *unusable* in fixture mode: the providers that would
 *   read them cannot be constructed. Handing the developer's real keys to a process that refuses to
 *   use them would be pointless and would put them in the process environment of a test run. The
 *   placeholders below are recognisably not keys.
 * - **A machine without a `.env` can run the suite.** The file is not in version control, so
 *   requiring it would make the E2E suite unrunnable on a fresh checkout and in CI.
 *
 * The two ports are the exception and are read from the environment: they are a property of the
 * machine rather than of the data, and `../../playwright.config.ts` passes the values it computed its
 * own `baseURL` and proxy target from — so the API_Service listens where the Web_App and the specs
 * look for it.
 */
const E2E_ENV = {
  DATABASE_URL: databaseUrl,
  HOME_ADDRESS: 'Hörkherstraße 1d, 80689 München',
  COMMUTE_THRESHOLD_MINUTES: '60',
  // Required, and unreachable: `HeigitRoutingProvider` refuses to be constructed in fixture mode.
  ROUTING_PROVIDER: 'heigit',
  ROUTING_API_KEY: 'fixture-mode-no-routing-request-is-sent',
  // Required, and unreachable: `AnthropicRelevanceAssessor` refuses to be constructed in fixture mode.
  ANTHROPIC_API_KEY: 'fixture-mode-no-ai-request-is-sent',
  ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  // On, so an E2E spec can assert a Relevance_Verdict on a freshly scraped Job_Posting. The verdicts
  // come from `FixtureRelevanceAssessor`; a spec about the deactivated service of 15.9 would need its
  // own API_Service and is out of scope for this harness.
  RELEVANCE_ENABLED: 'true',
  RELEVANCE_CONCURRENCY: '4',
  RELEVANCE_MAX_PER_RUN: '200',
  ENRICHMENT_GRACE_MINUTES: '10',
  USER_AGENT_CONTACT: 'e2e@example.invalid',
  API_PORT: process.env.API_PORT ?? '4000',
  WEB_PORT: process.env.WEB_PORT ?? '5173',
  SCRAPER_FIXTURE_MODE: '1',
};

// Set before the API_Service is loaded, because `loadEnvConfigOrExit` reads `process.env` once and
// caches the result. Node's own `loadEnvFile` leaves a value that is already present in `process.env`
// alone, so every value above wins over the repository `.env` rather than being overwritten by it —
// which is what keeps the E2E run off the development database and off the developer's credentials.
Object.assign(process.env, E2E_ENV);

const { bootstrap } = createRequire(import.meta.url)(apiEntryPoint);

await bootstrap();
