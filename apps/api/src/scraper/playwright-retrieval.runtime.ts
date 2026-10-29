/**
 * The production {@link RetrievalRuntime}: one headless Chromium and one robots.txt cache per
 * Scrape_Run.
 *
 * Both halves are implemented in `@job-scraper/scrapers`, which is where the browser lifetimes of
 * 8.4 and the robots.txt rules of 14.1 - 14.4 live. This file is the wiring and nothing else, and it
 * is short on purpose: `withScrapeRunBrowser` already owns the teardown, `PlatformBrowserContext`
 * already satisfies `PlatformPages`, and `RobotsCache` already satisfies `RobotsGate`.
 *
 * Two details that are decisions rather than plumbing:
 *
 * - The user agent of 14.5 is built once per Scrape_Run and handed to *both* the browser contexts
 *   and the robots.txt retrieval, so the identification the Platform sees on a page request is the
 *   identification the robots.txt decision was made for. Property 14 asserts exactly that.
 * - robots.txt goes through `fetch`, not through the browser, so a Platform that forbids the
 *   retrieval never costs a browser page (14.2). The global `fetch` is wrapped rather than passed
 *   directly, so the two arguments the port promises are the two arguments that are sent.
 *
 * Requirements: 14.1, 14.4, 14.5.
 */

import { RobotsCache, type RobotsFetch, withScrapeRunBrowser } from '@job-scraper/scrapers';

import { assertNotFixtureMode, type FixtureModeConfig } from '../config/fixture-mode';
import type { RetrievalRuntime } from './retrieval.port';

/**
 * The robots.txt retrieval function.
 *
 * Only the headers and the abort signal of the port's request reach `fetch`: the 10-second budget of
 * 14.3 is enforced by the caller's own controller, which arrives as `init.signal`.
 */
const robotsFetch: RobotsFetch = (url, init) =>
  fetch(url, { headers: init.headers, signal: init.signal });

/**
 * The Playwright-backed retrieval runtime of a Scrape_Run.
 *
 * A plain object rather than a Nest provider class: it holds no state between runs and has no
 * dependency to inject. `scraper.module.ts` binds it to the `RETRIEVAL_RUNTIME` token through
 * {@link createPlaywrightRetrievalRuntime}.
 */
export const playwrightRetrievalRuntime: RetrievalRuntime = {
  run: (request, use) =>
    withScrapeRunBrowser(
      { userAgent: request.userAgent, signal: request.signal },
      async (browser) =>
        use({
          robots: new RobotsCache({ userAgent: request.userAgent, fetch: robotsFetch }),
          pagesFor: (pages) => browser.contextFor(pages),
        }),
    ),
};

/**
 * Hands out {@link playwrightRetrievalRuntime}, or refuses to in fixture mode.
 *
 * The runtime is a value and not a class, so there is no constructor to guard — this factory is the
 * one place it can be reached from, and the assertion therefore sits here. In fixture mode the
 * process stops at module init with a named error instead of launching a Chromium that would send
 * real requests to a Platform (14.5, and the E2E promise of task 21.1).
 *
 * @throws A `FixtureModeViolationError` while `SCRAPER_FIXTURE_MODE` is on.
 */
export const createPlaywrightRetrievalRuntime = (env: FixtureModeConfig): RetrievalRuntime => {
  assertNotFixtureMode(
    env,
    'The Playwright retrieval runtime',
    'the fixture-backed retrieval runtime of `./fixture-retrieval.runtime.ts`',
  );

  return playwrightRetrievalRuntime;
};
