/**
 * The fixture-mode {@link RetrievalRuntime}: the frozen Platform fixtures over HTTP, with no browser
 * and no external request (design, Testing Strategy; task 21.1).
 *
 * This is the other implementation of the seam `./retrieval.port.ts` describes, and it is deliberately
 * the *only* thing fixture mode replaces about the retrieval. Everything above the port stays
 * untouched and therefore stays under test: the real Stepstone and Jobvector Platform_Adapter build
 * their real Result_Page URL from the effective Search_Profile, walk the pagination, detect a sign-in
 * wall or a changed layout, report their Platform_Status, and the Scraper_Service normalizes and
 * stores what they hand over. What changes is where the bytes come from.
 *
 * The three pieces, all of them already existing in `@job-scraper/scrapers`:
 *
 * - **Pages.** A `FixtureServer` serves the stored documents of
 *   `packages/scrapers/src/adapters/<platform>/__fixtures__/`, and the fixture page factory is the
 *   `AdapterPage` port over it. The page rewrite keeps the Result_Page number and swaps the origin,
 *   which is what the adapter parser tests already do — see
 *   `packages/scrapers/src/adapters/stepstone/__tests__/fixture-adapter.test.ts`. Fixture mode
 *   introduces no second fixture mechanism.
 * - **robots.txt.** The real `RobotsCache` evaluates a real robots.txt body, so the one retrieval per
 *   Platform of 14.1, the path evaluation of 14.2 and the crawl-delay of 14.4 all still run. The body
 *   is {@link FIXTURE_ROBOTS_TXT}, answered from memory by {@link fixtureRobotsFetch}; no request
 *   leaves the process.
 * - **Pacing.** The real `PlatformQueue` with the real minimum gap, on a virtual clock. See "Why a
 *   fixture run is fast" below.
 *
 * ## Which fixture answers which Result_Page
 *
 * Both adapters express the Result_Page number as the query parameter {@link PAGE_QUERY_PARAM},
 * omitted for the first page, and nothing else about their URL depends on the page. The route table
 * is therefore keyed by that number alone and the rewrite maps any requested URL onto
 * `/<platform>/page-<n>`, so this runtime needs neither the effective Search_Profile nor any
 * knowledge of a Platform's URL shape. `__tests__/fixture-retrieval.runtime.test.ts` asserts the
 * convention against every registered adapter's own `resultListUrl`, so an adapter that paginated
 * through the path would fail that test by name instead of silently serving page 1 ten times.
 *
 * The first two pages come from the two stored result list pages, which is a complete retrieval:
 * `result-list-page-2` offers no further page, so each Platform reports `COMPLETED` after two
 * Result_Page. Every higher page number answers with the stored empty result list, so even an adapter
 * that asked for more would terminate rather than run to the page limit of 13.3.
 *
 * ## Why a fixture run is fast without the pacing being switched off
 *
 * 13.2 requires at least 2 seconds between two page requests of a Platform, and that rule is under
 * test in task 21.2 — a run whose pacing were disabled would prove nothing about the production
 * retrieval, because it would be a different code path from the one the user runs. The pacing is
 * therefore kept: the real `PlatformQueue` computes the real gap from its own `MIN_REQUEST_GAP_MS`
 * and the crawl-delay the robots.txt body states, and refuses to send before it has elapsed. What
 * fixture mode replaces is the *clock*, not the rule. {@link virtualPacingClock} hands the queue a
 * time source that only ever advances when the queue itself asks to wait, and a `sleep` that advances
 * it by the requested duration and resolves immediately. The queue's own injection points for both —
 * present because the pacing property test drives them the same way — are what make this possible
 * without a line of production code knowing about it.
 *
 * The arithmetic therefore runs unchanged and stays observable: two Result_Page per Platform cost one
 * wait of 2,000 ms of virtual time per Platform and roughly zero milliseconds of wall time, and
 * {@link FixtureScrapeRunRetrieval.pacingWaitsMs} reports them, so "fast because the clock is
 * virtual" stays distinguishable from "fast because the pacing was skipped".
 *
 * Requirements: 10.1, 12.1, 13.2, 13.3, 14.1, 14.4.
 */

import type { Platform } from '@job-scraper/domain';
import {
  type AdapterPage,
  createFixturePageFactory,
  type FixtureRoute,
  type FixtureRoutes,
  FixtureServer,
  PlatformQueue,
  readFixtureHtml,
  registeredPlatforms,
  RobotsCache,
  type RobotsFetch,
} from '@job-scraper/scrapers';

import type {
  PlatformPages,
  PlatformPagesRequest,
  RetrievalRuntime,
  RetrievalRuntimeRequest,
  ScrapeRunRetrieval,
} from './retrieval.port';

/** The query parameter both adapters express the 1-based Result_Page number in. */
export const PAGE_QUERY_PARAM = 'page';

/**
 * How many Result_Page get a route.
 *
 * Deliberately **not** the Page_Safety_Limit of 13.10, which is 100: a fixture-mode run never walks
 * that far, because `DEFAULT_FIXTURE_PAGE_CASES` serves a last page as page 2 and every adapter then
 * reports `COMPLETED`. Ten routes leave room for a test that scripts a deeper walk, and anything
 * past them falls to {@link FIXTURE_OVERFLOW_CASE} rather than to a 404 the adapter would have to
 * report as a Platform failure.
 */
export const FIXTURE_PAGE_ROUTE_COUNT = 10;

/**
 * The stored fixture case serving each Result_Page, in page order.
 *
 * Two entries, which is a complete retrieval: the second page offers no further one, so the adapter
 * reports `COMPLETED` instead of running into the page limit of 13.3. A test that wants a different
 * Platform_Status passes its own {@link FixtureRetrievalOptions.pageCases}.
 */
export const DEFAULT_FIXTURE_PAGE_CASES = ['result-list-page-1', 'result-list-page-2'] as const;

/** What any Result_Page beyond {@link FixtureRetrievalOptions.pageCases} answers with. */
export const FIXTURE_OVERFLOW_CASE = 'result-list-empty';

/**
 * The robots.txt every Platform serves in fixture mode.
 *
 * A real body rather than a short-circuited decision, so the parsing, the user-agent group matching
 * and the crawl-delay reading of `RobotsCache` all still run (14.1 to 14.4). It allows everything and
 * states a crawl-delay below the 2-second minimum of 13.2, so the effective gap stays that minimum —
 * the production case, and the one task 21.2 asserts.
 */
export const FIXTURE_ROBOTS_TXT = ['User-agent: *', 'Allow: /', 'Crawl-delay: 1', ''].join('\n');

/**
 * A Platform is registered in the Platform_Adapter registry but has no stored fixture for a case the
 * route table needs.
 *
 * This is deliberately an error and not a skipped Platform, and the choice is worth stating because it
 * will come up again: registering an adapter and capturing its fixtures are two separate tasks, so
 * between them every fixture-mode Scrape_Run fails here. The tolerant alternatives are both worse than
 * a loud failure:
 *
 * - *Leaving the Platform out of the route table* makes its page request answer 404, which the adapter
 *   has to classify — it reports `PAGE_LAYOUT_UNKNOWN`, and a developer then goes looking at selectors
 *   for a Platform whose selectors are fine.
 * - *Serving it an empty result list* makes it report `COMPLETED` with no Job_Posting. The E2E suite
 *   then stays green while one Platform_Adapter contributes nothing and is proven by nothing, and the
 *   per-Platform summary of 7.4 shows a Platform_Status the retrieval never established.
 *
 * Fixture mode exists so the E2E suite exercises the real retrieval path; a Platform without frozen
 * pages cannot be exercised, and saying so by name is the only honest answer. What this error adds over
 * the bare `ENOENT` it replaces is the Platform, the case and the command that fixes it.
 */
export class MissingPlatformFixtureError extends Error {
  readonly platform: Platform;

  readonly fixtureCase: string;

  constructor(platform: Platform, fixtureCase: string, cause: unknown) {
    super(
      `Platform ${platform} has a registered Platform_Adapter but no stored fixture for the case "${fixtureCase}", so fixture mode cannot serve it a Result_Page. Capture or hand-author the fixtures of that Platform first: pnpm fixtures:capture --platform ${platform.toLowerCase()}`,
      { cause },
    );
    this.name = 'MissingPlatformFixtureError';
    this.platform = platform;
    this.fixtureCase = fixtureCase;
  }
}

/** The route path of one Result_Page of one Platform. */
export const fixturePagePath = (platform: Platform, pageNumber: number): string =>
  `/${platform.toLowerCase()}/page-${String(pageNumber)}`;

/**
 * The Result_Page number a requested URL asks for.
 *
 * @param requestedUrl The URL the Platform_Adapter built, pointing at the real Platform.
 * @returns The 1-based page number, and 1 for a URL without the parameter — which is how both
 *   adapters spell the first Result_Page.
 */
export const requestedPageNumber = (requestedUrl: string): number => {
  try {
    const raw = new URL(requestedUrl).searchParams.get(PAGE_QUERY_PARAM);

    if (raw === null) {
      return 1;
    }

    const parsed = Number(raw);

    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  } catch {
    return 1;
  }
};

/** Construction arguments of a {@link FixtureRetrievalRuntime}. */
export interface FixtureRetrievalOptions {
  /**
   * The stored fixture cases serving Result_Page 1, 2, … in order.
   *
   * Defaults to {@link DEFAULT_FIXTURE_PAGE_CASES}. A spec that wants a specific Platform_Status — a
   * sign-in wall, a changed layout — names the case here instead of reaching for a second fixture
   * mechanism.
   */
  readonly pageCases?: readonly string[];
  /** The Platform the route table is built for. Defaults to every Platform with an adapter. */
  readonly platforms?: readonly Platform[];
  /** How many Result_Page get a route at all. Defaults to {@link FIXTURE_PAGE_ROUTE_COUNT}. */
  readonly pageRoutes?: number;
}

/** The retrieval of one fixture-mode Scrape_Run, with what it observed about its own behaviour. */
export interface FixtureScrapeRunRetrieval extends ScrapeRunRetrieval {
  /** Every wait the queues of this run performed, in milliseconds of virtual time. */
  readonly pacingWaitsMs: readonly number[];
  /** The route paths the fixture server was asked for, in arrival order. */
  readonly requestedPaths: readonly string[];
}

/**
 * A {@link RobotsFetch} that answers {@link FIXTURE_ROBOTS_TXT} from memory.
 *
 * Answered in-process rather than served by the fixture server: the robots.txt of 14.1 is retrieved
 * with `fetch` and not through a page, and a fixture-mode process has no business holding a function
 * that could reach a Platform host even in principle.
 */
export const fixtureRobotsFetch: RobotsFetch = async (_url, init) => {
  init.signal.throwIfAborted();

  return { ok: true, status: 200, text: async () => FIXTURE_ROBOTS_TXT };
};

/** A virtual clock together with the `sleep` that advances it. */
export interface VirtualPacing {
  readonly clock: { now: () => number };
  readonly sleep: (durationMs: number) => Promise<void>;
}

/**
 * A time source that stands still until the pacing asks it to move.
 *
 * This is what makes a fixture-mode Scrape_Run quick while the gap of 13.2 is still computed and
 * still enforced: the queue measures the elapsed time against this clock, finds that nothing has
 * elapsed, and waits out the full gap — where the wait is bookkeeping. Every wait is recorded, so the
 * gaps stay assertable.
 */
export const virtualPacingClock = (record: (durationMs: number) => void): VirtualPacing => {
  let now = 0;

  return {
    clock: { now: () => now },
    sleep: async (durationMs) => {
      record(durationMs);
      now += durationMs;
    },
  };
};

/** Construction arguments of a {@link FixturePlatformPages}. */
interface FixturePlatformPagesArgs {
  readonly origin: string;
  readonly platform: Platform;
  readonly queue: PlatformQueue;
  readonly userAgent: string;
  readonly signal: AbortSignal;
}

/** The page source of one Platform in fixture mode: a fixture page factory plus its queue. */
class FixturePlatformPages implements PlatformPages {
  readonly openPage: () => Promise<AdapterPage>;

  readonly #queue: PlatformQueue;

  constructor(args: FixturePlatformPagesArgs) {
    this.#queue = args.queue;

    const factory = createFixturePageFactory({
      origin: args.origin,
      queue: args.queue,
      signal: args.signal,
      userAgent: args.userAgent,
      // The path and the query of the real Platform URL are discarded and only the Result_Page number
      // is kept: the stored fixtures are one document per page, not one per query.
      rewrite: (requestedUrl) =>
        new URL(
          fixturePagePath(args.platform, requestedPageNumber(requestedUrl)),
          args.origin,
        ).toString(),
    });

    this.openPage = factory.openPage;
  }

  async close(): Promise<void> {
    // The same contract as the production context (7.8): closing the page source closes this
    // Platform's request queue, so no further request reaches it in this Scrape_Run.
    this.#queue.close();
  }
}

/**
 * The fixture-backed retrieval runtime.
 *
 * One fixture server per Scrape_Run, started when the run opens and closed in the `finally` of
 * {@link FixtureRetrievalRuntime.run} — the same lifetime the production browser has, and closed for
 * the same reason: a cancellation (12.7) or the retrieval deadline (13.6) must not leave a listening
 * socket behind.
 */
export class FixtureRetrievalRuntime implements RetrievalRuntime {
  readonly #pageCases: readonly string[];

  readonly #platforms: readonly Platform[];

  readonly #pageRoutes: number;

  constructor(options: FixtureRetrievalOptions = {}) {
    this.#pageCases = options.pageCases ?? [...DEFAULT_FIXTURE_PAGE_CASES];
    // Read from the registry rather than listed, for the same reason the Scraper_Service reads it
    // (6.6): a Platform_Adapter added in a later task gets its routes without this file changing.
    this.#platforms = options.platforms ?? registeredPlatforms();
    this.#pageRoutes = options.pageRoutes ?? FIXTURE_PAGE_ROUTE_COUNT;
  }

  async run<T>(
    request: RetrievalRuntimeRequest,
    use: (retrieval: FixtureScrapeRunRetrieval) => Promise<T>,
  ): Promise<T> {
    request.signal.throwIfAborted();

    const server = await FixtureServer.start({ routes: await this.#routes() });
    const pacingWaitsMs: number[] = [];
    const openedPlatforms = new Set<Platform>();

    const pagesFor = async (pagesRequest: PlatformPagesRequest): Promise<PlatformPages> => {
      if (openedPlatforms.has(pagesRequest.platform)) {
        // The production runtime refuses a second context for one Platform, because a second request
        // queue would be a second permission to ignore the pacing of 13.2. The same rule here.
        throw new Error(
          `Platform ${pagesRequest.platform} already has a fixture page source in this Scrape_Run; exactly one is permitted.`,
        );
      }

      openedPlatforms.add(pagesRequest.platform);

      const { clock, sleep } = virtualPacingClock((durationMs) => pacingWaitsMs.push(durationMs));

      return new FixturePlatformPages({
        origin: server.origin,
        platform: pagesRequest.platform,
        queue: new PlatformQueue({
          platform: pagesRequest.platform,
          crawlDelaySeconds: pagesRequest.crawlDelaySeconds,
          clock,
          sleep,
        }),
        userAgent: request.userAgent,
        signal: request.signal,
      });
    };

    try {
      return await use({
        robots: new RobotsCache({ userAgent: request.userAgent, fetch: fixtureRobotsFetch }),
        pagesFor,
        // Getters rather than snapshots: both lists grow while `use` runs, and a copy taken here
        // would be empty for every caller.
        get pacingWaitsMs() {
          return pacingWaitsMs;
        },
        get requestedPaths() {
          return server.requests.map((received) => received.pathname);
        },
      });
    } finally {
      await server.close();
    }
  }

  /** One route per Platform and Result_Page, read from the stored fixtures. */
  async #routes(): Promise<FixtureRoutes> {
    const routes: Record<string, FixtureRoute> = {};
    const documents = new Map<string, string>();

    const documentOf = async (platform: Platform, fixtureCase: string): Promise<string> => {
      const key = `${platform}:${fixtureCase}`;
      const cached = documents.get(key);

      if (cached !== undefined) {
        return cached;
      }

      let html: string;

      try {
        html = await readFixtureHtml({ platform, fixtureCase });
      } catch (error) {
        throw new MissingPlatformFixtureError(platform, fixtureCase, error);
      }

      documents.set(key, html);

      return html;
    };

    for (const platform of this.#platforms) {
      for (let pageNumber = 1; pageNumber <= this.#pageRoutes; pageNumber += 1) {
        const fixtureCase = this.#pageCases[pageNumber - 1] ?? FIXTURE_OVERFLOW_CASE;

        routes[fixturePagePath(platform, pageNumber)] = {
          kind: 'HTML',
          html: await documentOf(platform, fixtureCase),
        };
      }
    }

    return routes;
  }
}
