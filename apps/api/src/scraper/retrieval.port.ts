/**
 * The seam between the Scraper_Service and the things a retrieval needs from the outside world: a
 * browser and the robots.txt of a Platform.
 *
 * Both live in `@job-scraper/scrapers` and both are real I/O — `ScrapeRunBrowser` launches Chromium,
 * `RobotsCache` sends an HTTPS request. The orchestration this port sits in front of is not: which
 * Platform is queried, in which concurrency, what happens to a Partial_Result, which Platform_Status
 * a failure becomes, when the sweep is allowed to run. Separating the two is what lets the
 * orchestration be driven by a unit test without a browser binary and without a network, which
 * matters because every requirement task 12.3 answers for is a statement about the orchestration.
 *
 * The port is deliberately thin and is shaped *after* the two implementations rather than before
 * them: `PlatformBrowserContext` of the Playwright runtime satisfies {@link PlatformPages} as it
 * stands, and `RobotsCache` satisfies {@link RobotsGate} as it stands. No adapter object, no
 * translation layer — see `./playwright-retrieval.runtime.ts`, which is 30 lines for that reason.
 *
 * Why the three nested shapes rather than one flat interface: the lifetimes differ. The browser
 * lives for one Scrape_Run and has to be torn down whatever happens, which is what the callback
 * shape of {@link RetrievalRuntime.run} enforces at the type level. The robots.txt decision is
 * cached for the same lifetime, so it hangs off the session (14.1). A page source lives for one
 * Platform and carries that Platform's own request queue (13.2, 13.9, 14.4).
 *
 * Requirements: 13.9, 14.1, 14.4.
 */

import type { Platform } from '@job-scraper/domain';
import type { AdapterPage, RobotsDecision } from '@job-scraper/scrapers';

/** What one robots.txt evaluation asks about (14.1, 14.2, 14.3). */
export interface RobotsRequest {
  /** The cache key: one retrieval per Platform for the lifetime of the Scrape_Run (14.1). */
  readonly platform: Platform;
  /** The Platform origin, for example `https://www.stepstone.de`. */
  readonly origin: string;
  /** The paths the Platform_Adapter intends to request, resolved against `origin`. */
  readonly intendedPaths: readonly string[];
  /** Cancellation of the Scrape_Run; an abort rejects rather than yielding a decision. */
  readonly signal: AbortSignal;
}

/**
 * The robots.txt gate of one Scrape_Run.
 *
 * `RobotsCache` from `@job-scraper/scrapers` is the production implementation; it fetches once per
 * Platform and answers every later question from the body it already holds, which is the reuse 14.1
 * asks for.
 */
export interface RobotsGate {
  evaluate(request: RobotsRequest): Promise<RobotsDecision>;
}

/**
 * The page source of one Platform: its `BrowserContext` plus its request queue.
 *
 * `openPage` has exactly the signature of `AdapterContext.openPage`, so the Scraper_Service hands it
 * to a Platform_Adapter unwrapped and the adapter receives the pacing of 13.2, the single in-flight
 * request of 13.9, a stated crawl-delay (14.4) and the repetitions of 13.4 without knowing that any
 * of them exist.
 */
export interface PlatformPages {
  readonly openPage: () => Promise<AdapterPage>;
  /** Closes every open page and the context. Idempotent, so a `finally` may always call it. */
  close(): Promise<void>;
}

/** What one Platform's page source is created with. */
export interface PlatformPagesRequest {
  readonly platform: Platform;
  /**
   * The `Crawl-delay` the robots.txt of that Platform states for the Job_Tool's user agent, in
   * seconds (14.4). Taken from the robots.txt decision, so the pacing of the very first page
   * request already honours it.
   */
  readonly crawlDelaySeconds?: number;
}

/** The outside world of exactly one Scrape_Run, for as long as its retrieval phase runs. */
export interface ScrapeRunRetrieval {
  /** One robots.txt retrieval per Platform, cached for this Scrape_Run (14.1). */
  readonly robots: RobotsGate;
  /**
   * Creates the page source of one Platform.
   *
   * At most one per Platform and Scrape_Run: the Playwright runtime rejects a second request for the
   * same Platform, because a second context would be a second request queue and therefore a second
   * permission to ignore the pacing of 13.2.
   */
  pagesFor(request: PlatformPagesRequest): Promise<PlatformPages>;
}

/** What the retrieval phase of one Scrape_Run is opened with. */
export interface RetrievalRuntimeRequest {
  /** The unchanged Job_Tool user agent of 14.5, sent with every page and robots.txt request. */
  readonly userAgent: string;
  /** Cancellation by the user (12.7) or by the retrieval deadline (13.6). */
  readonly signal: AbortSignal;
}

/**
 * Opens the retrieval phase of one Scrape_Run and closes it again afterwards.
 *
 * The callback shape is the point: the browser of a Scrape_Run has to be closed whatever the
 * retrieval did — completed, failed, cancelled, deadline — and a `run(use)` that owns the `finally`
 * block makes that impossible to forget. A cancellation (12.7) or the deadline (13.6) therefore
 * cannot leave a Chromium process behind.
 */
export interface RetrievalRuntime {
  run<T>(
    request: RetrievalRuntimeRequest,
    use: (retrieval: ScrapeRunRetrieval) => Promise<T>,
  ): Promise<T>;
}

/** Injection token of the {@link RetrievalRuntime}; see `./scraper.module.ts`. */
export const RETRIEVAL_RUNTIME = Symbol('RETRIEVAL_RUNTIME');
