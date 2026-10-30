/**
 * robots.txt retrieval and evaluation for Requirement 14.
 *
 * One retrieval per Platform and Scrape_Run, before the first page request, reused for the rest of
 * that run (14.1). The result gates the Platform: a disallowed intended path maps to Platform_Status
 * `EXCLUDED_BY_ROBOTS_TXT` (14.2), a robots.txt that cannot be fetched within 10 seconds or cannot be
 * evaluated maps to `ROBOTS_TXT_UNAVAILABLE` (14.3). A stated `Crawl-delay` is reported here and
 * applied by the PlatformQueue, which waits `max(2000, crawlDelaySeconds * 1000)` (14.4).
 *
 * Parsing is delegated to `robots-parser` rather than hand-rolled, because user-agent group
 * precedence, wildcard patterns and `Crawl-delay` have enough edge cases to make a home-grown parser
 * a liability. Retrieval goes through `fetch`, not Playwright, so a blocked robots.txt costs no
 * browser page. The fetch function is injected, which keeps every test here off the network.
 */

import { type Platform, type PlatformStatus } from '@job-scraper/domain';
import robotsParserModule from 'robots-parser';

/** The part of the parsed rule set this module uses; `robots-parser` exports no name for it. */
interface RobotsRuleset {
  /** `undefined` when the URL does not belong to the robots.txt the rule set was built from. */
  isAllowed: (url: string, userAgent?: string) => boolean | undefined;
  getCrawlDelay: (userAgent?: string) => number | undefined;
}

/**
 * `robots-parser` is a CommonJS module whose single export is the parser function, but its bundled
 * declaration file describes that export in a shape NodeNext resolves to the module namespace rather
 * than to a callable. The one cast here restores the documented signature; the runtime value is the
 * function in both Node and Vitest, because the CommonJS interop binds `module.exports` to `default`.
 */
const robotsParser = robotsParserModule as unknown as (url: string, body: string) => RobotsRuleset;

/** The path a robots.txt is served under, fixed by the robots exclusion protocol. */
const ROBOTS_TXT_PATH = '/robots.txt';

/** The retrieval budget of 14.3: a robots.txt that takes longer counts as unavailable. */
export const ROBOTS_FETCH_TIMEOUT_MS = 10_000;

/**
 * HTTP statuses that mean the Platform publishes no robots.txt: the 4xx range apart from 429. RFC
 * 9309 calls these "unavailable status" and permits unrestricted retrieval, so the evaluation
 * continues against an empty rule set instead of skipping the Platform.
 *
 * 429 and every 5xx are deliberately excluded: RFC 9309 treats them as "unreachable status" with a
 * complete disallow, which here is the Platform being skipped with `ROBOTS_TXT_UNAVAILABLE` (14.3).
 */
function isAbsentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/** Whether the robots.txt of a Platform could be evaluated at all. */
export type RobotsStatus = 'EVALUATED' | 'UNAVAILABLE';

/**
 * The two Platform_Status a robots.txt evaluation can produce (14.2, 14.3).
 *
 * Narrower than `PlatformStatus` on purpose: a caller deciding what to do about a robots.txt
 * outcome — and under the `ignore` Robots_Policy of 14.11 there is such a caller — needs the two
 * cases to be exhaustive, which they are not if the type is the full list of 14.
 */
export type RobotsPlatformStatus = Extract<
  PlatformStatus,
  'EXCLUDED_BY_ROBOTS_TXT' | 'ROBOTS_TXT_UNAVAILABLE'
>;

/** The evaluation of one Platform's robots.txt against the paths a Platform_Adapter intends to visit. */
export interface RobotsDecision {
  /** The intended paths the robots.txt permits, in the order they were passed in. */
  readonly allowedPaths: readonly string[];
  /** The intended paths the robots.txt forbids. A non-empty list excludes the Platform (14.2). */
  readonly disallowedPaths: readonly string[];
  /** The `Crawl-delay` in seconds for the sent user agent, or `null` if none is stated (14.4). */
  readonly crawlDelaySeconds: number | null;
  /** `UNAVAILABLE` leaves both path lists empty: nothing about the Platform is known (14.3). */
  readonly status: RobotsStatus;
}

/** The part of a `fetch` response the robots.txt retrieval reads. */
export interface RobotsResponse {
  readonly ok: boolean;
  readonly status: number;
  text: () => Promise<string>;
}

/**
 * The injected retrieval function. The global `fetch` satisfies this type, so production code passes
 * `fetch` and the tests pass a recorder that answers from a fixture.
 */
export type RobotsFetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<RobotsResponse>;

/** What a single robots.txt retrieval yielded, before any path is looked at. */
type RobotsSource =
  { readonly kind: 'PARSED'; readonly ruleset: RobotsRuleset } | { readonly kind: 'UNAVAILABLE' };

const UNAVAILABLE_SOURCE: RobotsSource = { kind: 'UNAVAILABLE' };

const UNAVAILABLE_DECISION: RobotsDecision = {
  allowedPaths: [],
  disallowedPaths: [],
  crawlDelaySeconds: null,
  status: 'UNAVAILABLE',
};

/** Arguments of a single uncached evaluation. */
export interface EvaluateRobotsOptions {
  /** The Platform origin, for example `https://www.example.com`. */
  readonly origin: string;
  /** The paths the Platform_Adapter intends to request, resolved against `origin`. */
  readonly intendedPaths: readonly string[];
  /** The unchanged Job_Tool user agent, sent with the request and used for group matching (14.5). */
  readonly userAgent: string;
  /** Cancellation of the surrounding Scrape_Run. An abort rejects rather than yielding a decision. */
  readonly signal: AbortSignal;
  /** The retrieval function; pass the global `fetch` in production. */
  readonly fetch: RobotsFetch;
}

/** The part of {@link EvaluateRobotsOptions} the retrieval itself needs; the paths come later. */
type FetchRobotsOptions = Omit<EvaluateRobotsOptions, 'intendedPaths'>;

/** One robots.txt evaluation request against a {@link RobotsCache}. */
export interface RobotsCacheRequest {
  /** The cache key: one retrieval per Platform for the lifetime of the cache (14.1). */
  readonly platform: Platform;
  readonly origin: string;
  readonly intendedPaths: readonly string[];
  readonly signal: AbortSignal;
}

/** Construction arguments of a {@link RobotsCache}. */
export interface RobotsCacheOptions {
  readonly userAgent: string;
  readonly fetch: RobotsFetch;
}

/**
 * Fetches and evaluates the robots.txt of one Platform without caching.
 *
 * @returns A decision with status `UNAVAILABLE` when the retrieval fails, exceeds
 *   {@link ROBOTS_FETCH_TIMEOUT_MS} or produces a body that cannot be evaluated (14.3).
 * @throws The abort reason of `options.signal` when the surrounding Scrape_Run is cancelled while the
 *   request is in flight. Cancellation is not a robots.txt condition, so it must not be reported as
 *   `ROBOTS_TXT_UNAVAILABLE`.
 */
export async function evaluateRobots(options: EvaluateRobotsOptions): Promise<RobotsDecision> {
  const source = await fetchRobotsSource(options);

  return decide(source, options.origin, options.intendedPaths, options.userAgent);
}

/**
 * One robots.txt retrieval per Platform, cached for the lifetime of the instance. The
 * Scraper_Service creates exactly one instance per Scrape_Run, so the cache lifetime is the run
 * lifetime that 14.1 asks for.
 *
 * The retrieved body is cached, not the decision, so a later call with further intended paths is
 * answered from the same body instead of triggering a second request. Concurrent callers for the
 * same Platform share the one in-flight retrieval.
 */
export class RobotsCache {
  readonly #userAgent: string;

  readonly #fetch: RobotsFetch;

  /** The in-flight or settled retrieval per Platform. Its size is the number of requests issued. */
  readonly #sources = new Map<Platform, Promise<RobotsSource>>();

  constructor(options: RobotsCacheOptions) {
    this.#userAgent = options.userAgent;
    this.#fetch = options.fetch;
  }

  /** The Platform whose robots.txt has been requested so far, in request order. */
  get requestedPlatforms(): readonly Platform[] {
    return [...this.#sources.keys()];
  }

  /**
   * Evaluates the intended paths of one Platform, fetching its robots.txt on the first call only.
   *
   * @throws The abort reason of `request.signal`, as {@link evaluateRobots} does.
   */
  async evaluate(request: RobotsCacheRequest): Promise<RobotsDecision> {
    const source = await this.#source(request);

    return decide(source, request.origin, request.intendedPaths, this.#userAgent);
  }

  /**
   * The cached retrieval for a Platform, started on first use.
   *
   * A rejected retrieval is dropped from the cache again: the only rejection path is cancellation of
   * the Scrape_Run, and a cancelled first attempt must not leave the Platform permanently
   * unevaluable for a later instance sharing this cache.
   */
  async #source(request: RobotsCacheRequest): Promise<RobotsSource> {
    const cached = this.#sources.get(request.platform);

    if (cached !== undefined) {
      return cached;
    }

    const pending = fetchRobotsSource({
      origin: request.origin,
      userAgent: this.#userAgent,
      signal: request.signal,
      fetch: this.#fetch,
    });

    this.#sources.set(request.platform, pending);

    try {
      return await pending;
    } catch (error) {
      if (this.#sources.get(request.platform) === pending) {
        this.#sources.delete(request.platform);
      }

      throw error;
    }
  }
}

/**
 * Maps a decision onto the Platform_Status the Scraper_Service reports for that Platform.
 *
 * @returns `ROBOTS_TXT_UNAVAILABLE` when the robots.txt could not be evaluated (14.3),
 *   `EXCLUDED_BY_ROBOTS_TXT` when it forbids at least one intended path (14.2), and `null` when the
 *   retrieval may proceed — in which case the Platform_Status follows from the retrieval itself.
 */
export function robotsPlatformStatus(decision: RobotsDecision): RobotsPlatformStatus | null {
  if (decision.status === 'UNAVAILABLE') {
    return 'ROBOTS_TXT_UNAVAILABLE';
  }

  if (decision.disallowedPaths.length > 0) {
    return 'EXCLUDED_BY_ROBOTS_TXT';
  }

  return null;
}

/** Signals that the robots.txt retrieval exceeded {@link ROBOTS_FETCH_TIMEOUT_MS}. */
class RobotsTimeoutError extends Error {
  constructor(url: string) {
    super(`The robots.txt at ${url} did not arrive within ${String(ROBOTS_FETCH_TIMEOUT_MS)} ms.`);
    this.name = 'RobotsTimeoutError';
  }
}

/**
 * Performs the single robots.txt request and parses the body.
 *
 * The 10 second budget is enforced with an own controller rather than `AbortSignal.timeout`, so the
 * timer is the ordinary `setTimeout` the tests can drive with fake timers, and so the Scrape_Run
 * signal and the budget stay distinguishable: the first rejects, the second yields `UNAVAILABLE`.
 */
async function fetchRobotsSource(options: FetchRobotsOptions): Promise<RobotsSource> {
  const { origin, userAgent, signal, fetch: fetchRobots } = options;

  throwIfAborted(signal);

  const robotsUrl = resolveUrl(origin, ROBOTS_TXT_PATH);

  // An origin that does not form a URL yields no robots.txt, so the Platform is skipped rather than
  // retrieved without an evaluation.
  if (robotsUrl === undefined) {
    return UNAVAILABLE_SOURCE;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new RobotsTimeoutError(robotsUrl));
  }, ROBOTS_FETCH_TIMEOUT_MS);
  const forwardAbort = (): void => {
    controller.abort(signal.reason);
  };

  signal.addEventListener('abort', forwardAbort, { once: true });

  try {
    const response = await fetchRobots(robotsUrl, {
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      signal: controller.signal,
    });

    if (response.ok) {
      return parseRobots(robotsUrl, await response.text());
    }

    return isAbsentStatus(response.status) ? parseRobots(robotsUrl, '') : UNAVAILABLE_SOURCE;
  } catch {
    // A cancelled Scrape_Run is reported through its own Platform_Status, not as a robots.txt fault.
    throwIfAborted(signal);

    return UNAVAILABLE_SOURCE;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}

/** Parses a robots.txt body; a body `robots-parser` rejects leaves the Platform unevaluable (14.3). */
function parseRobots(robotsUrl: string, body: string): RobotsSource {
  try {
    return { kind: 'PARSED', ruleset: robotsParser(robotsUrl, body) };
  } catch {
    return UNAVAILABLE_SOURCE;
  }
}

/**
 * Splits the intended paths into allowed and forbidden ones and reads the `Crawl-delay`.
 *
 * `robots-parser` answers `undefined` for a path it cannot relate to the robots.txt it was given,
 * which is the "remains unevaluable" case of 14.3 and turns the whole decision into `UNAVAILABLE`
 * rather than silently permitting the path.
 */
function decide(
  source: RobotsSource,
  origin: string,
  intendedPaths: readonly string[],
  userAgent: string,
): RobotsDecision {
  if (source.kind === 'UNAVAILABLE') {
    return UNAVAILABLE_DECISION;
  }

  const allowedPaths: string[] = [];
  const disallowedPaths: string[] = [];

  for (const path of intendedPaths) {
    const url = resolveUrl(origin, path);
    const allowed = url === undefined ? undefined : source.ruleset.isAllowed(url, userAgent);

    if (allowed === undefined) {
      return UNAVAILABLE_DECISION;
    }

    if (allowed) {
      allowedPaths.push(path);
    } else {
      disallowedPaths.push(path);
    }
  }

  return {
    allowedPaths,
    disallowedPaths,
    crawlDelaySeconds: crawlDelaySeconds(source.ruleset, userAgent),
    status: 'EVALUATED',
  };
}

/** The stated `Crawl-delay` in seconds, or `null` if none is stated or the stated value is unusable. */
function crawlDelaySeconds(ruleset: RobotsRuleset, userAgent: string): number | null {
  const delay = ruleset.getCrawlDelay(userAgent);

  if (delay === undefined || !Number.isFinite(delay) || delay <= 0) {
    return null;
  }

  return delay;
}

/** Resolves an intended path against the Platform origin, or `undefined` if the two form no URL. */
function resolveUrl(origin: string, path: string): string | undefined {
  try {
    return new URL(path, origin).toString();
  } catch {
    return undefined;
  }
}

/** Rethrows the cancellation reason of the Scrape_Run, matching the Semaphore's abort behaviour. */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  throw signal.reason ?? new Error('The robots.txt evaluation was aborted.');
}
