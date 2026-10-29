/**
 * The E2E suite of the Web_App (design, Testing Strategy; task 21.1).
 *
 * Run with `pnpm test:e2e` from the repository root, which goes through Turborepo and therefore
 * builds what this configuration depends on first: the compiled API_Service in `apps/api/dist` that
 * `webServer` starts, and the compiled seeding command the specs call.
 *
 * ## What a run consists of, in order
 *
 * 1. `webServer` runs `e2e/harness/start-api.mjs`, which starts a throwaway PostgreSQL 16 container,
 *    migrates it, writes its connection string to the hand-off file and then boots the API_Service
 *    in-process with `SCRAPER_FIXTURE_MODE` on. It is never the development container — see that file
 *    for why, and for the `_test` database-name rule that makes the distinction enforced rather than
 *    intended.
 * 2. `webServer` starts the Vite dev server of the Web_App. Playwright waits for both servers to
 *    answer before the first spec runs.
 * 3. Each spec seeds the Posting_Store state it needs and drives the browser.
 * 4. Playwright stops both servers, and the API starter stops its container with itself.
 *
 * There is no `globalSetup`, and that is a decision rather than an omission: Playwright starts the
 * processes of `webServer` *before* it runs `globalSetup`, so a container started there would not
 * exist yet when the API_Service connected to it. Everything that has to happen before the
 * API_Service therefore happens inside the process that starts it.
 *
 * ## Why fixture mode, and what it buys
 *
 * The API_Service under test is the real one — the real resolvers, the real Scraper_Service, the real
 * Posting_Store writes, the real Log_Stream. What fixture mode replaces is the three places it would
 * otherwise reach a third party: the Platform_Adapter read the frozen fixtures of
 * `packages/scrapers`, the Routing_Provider and the AI_Provider are local doubles, and every
 * non-loopback request is refused outright. So a spec can press "Suchlauf starten" and watch a
 * complete Scrape_Run in the Log_View (12.1 to 12.10) in a couple of seconds, deterministically, and
 * without a single request to Stepstone, Jobvector, HeiGIT or Anthropic.
 *
 * ## Why one worker and no retries
 *
 * One Posting_Store, one API_Service and — by 12.1 and 12.5 — at most one Scrape_Run. Parallel specs
 * would truncate each other's rows and compete for that single run. Retries are off for the same
 * reason they are off in the unit suite: a spec that passes on the second attempt has found a race,
 * and hiding it behind a retry is how a suite stops meaning anything. CI gets `forbidOnly` instead,
 * so a committed `test.only` fails the run rather than silently reducing it.
 */

import { defineConfig, devices } from '@playwright/test';

import { HANDOFF_PATH } from './e2e/harness/handoff';
import { API_HEALTH_URL, API_PORT, WEB_BASE_URL, WEB_PORT } from './e2e/harness/ports';

/** Whether this run is a CI run; CI has no developer to look at a report. */
const isCi = process.env.CI === 'true' || process.env.CI === '1';

/**
 * How long a server may take to come up.
 *
 * Generous, because the first run on a machine without the PostgreSQL image has to pull it before
 * the API_Service can even start — and after that the API_Service connects to the Posting_Store and
 * runs every module's init hook before it binds its listener (3.6), while the Vite dev server
 * transforms the whole application on first request.
 */
const SERVER_START_TIMEOUT_MS = 180_000;

export default defineConfig({
  testDir: './e2e',

  // Only the specs. The page objects, the fixtures and the harness live in subdirectories of `e2e`
  // and must not be collected as tests of their own.
  testMatch: '**/*.spec.ts',

  // See the file comment: one Posting_Store, one API_Service, at most one Scrape_Run.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: isCi,

  /**
   * Per-spec budget.
   *
   * Generous because the run-control flows of task 21.2 wait out a whole Scrape_Run: the retrieval
   * is fixture-backed and paced on a virtual clock, so it costs seconds rather than the 2-second
   * gaps of 13.2 multiplied by the pages, but the enrichment stages and the Log_Stream transmission
   * bound of 12.4 still take real time.
   */
  timeout: 90_000,

  expect: {
    /**
     * How long an assertion waits for the Web_App to catch up.
     *
     * 5 seconds covers the three bounds the requirements state for a view: the posting overview
     * within 3 seconds (10.1), the Interest_Flag confirmation within 2 seconds (10.10) and a status
     * message within 2 seconds of its creation (12.4). A spec that needs to assert one of those
     * bounds *as a bound* passes its own, tighter timeout.
     */
    timeout: 5_000,
  },

  reporter: isCi
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: WEB_BASE_URL,
    // Kept only for a failure: a trace per passing spec is megabytes nobody reads.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // The Web_App is German-only (2.1), so the browser asks for German and formats dates as the
    // Web_App's own `formatGermanDateTime` does.
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      // A script and not a command line, because the script starts the Posting_Store first and
      // because a shell command in this repository has to begin with the name of the program it
      // runs — so the connection string and the fixture switch are set inside the process that is
      // about to boot rather than in front of the command. See `e2e/harness/start-api.mjs`. The
      // hand-off path is passed in so `e2e/harness/handoff.ts` stays its single declaration.
      command: `node e2e/harness/start-api.mjs --handoff ${HANDOFF_PATH}`,
      env: {
        // The only two configuration values the starter takes from outside: the API_Service has to
        // listen where this configuration's `baseURL` and the dev server's `/graphql` proxy look for
        // it. Everything else it pins itself — see the `E2E_ENV` comment in that file.
        API_PORT: String(API_PORT),
        WEB_PORT: String(WEB_PORT),
      },
      // The `health` query rather than a bare GET of the port, for the reason the Start_Script gives
      // in `scripts/lib/api-step.mjs`: a bound socket proves that *something* is listening, while a
      // `health` answer proves the schema was built and the Posting_Store connection is open (1.11).
      url: API_HEALTH_URL,
      timeout: SERVER_START_TIMEOUT_MS,
      // Never reuse: a running API_Service would be pointed at the developer's Posting_Store and
      // would not be in fixture mode, so the suite would silently test something else.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm dev',
      url: WEB_BASE_URL,
      timeout: SERVER_START_TIMEOUT_MS,
      // `strictPort: true` in `vite.config.ts` means a reused server is the configured one, and a
      // dev server holds no state of its own, so reusing it costs nothing and saves the start-up.
      reuseExistingServer: !isCi,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // Both ports are already read from the repository `.env` by `vite.config.ts`; passing them
        // again keeps the dev server on the port this configuration computed its `baseURL` from,
        // even if the file changes between the two reads.
        WEB_PORT: String(WEB_PORT),
        API_PORT: String(API_PORT),
      },
    },
  ],
});
