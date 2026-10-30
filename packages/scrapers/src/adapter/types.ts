/**
 * The uniform adapter interface of Requirement 6.6.
 *
 * Everything a Platform_Adapter needs from its surroundings arrives in one {@link AdapterContext}, and
 * everything it reports back leaves in one {@link AdapterResult}. That is what makes 6.6 hold: the
 * Scraper_Service talks to this interface only, so a further Platform_Adapter takes effect by being
 * registered (see `../registry.ts`) and the Scraper_Service source stays untouched.
 *
 * Two deliberate restrictions:
 *
 * - A Platform_Adapter returns *raw* values ({@link RawJobPosting}). Normalization onto the eight fields
 *   of 6.3 happens once, in the pure normalization layer, not four times in four adapters.
 * - The adapter never sees Playwright. It sees {@link AdapterPage}, a small port over "load a
 *   Result_Page and hand me its HTML". The Playwright runtime of task 8.4 implements that port; the
 *   fixture-based adapter tests implement it over a frozen HTML file, which is what keeps the adapter
 *   parsers testable without a browser and without a network.
 */

import type {
  EffectiveSearchProfile,
  Platform,
  PlatformCapability,
  PlatformStatus,
} from '@job-scraper/domain';

/**
 * The Page_Safety_Limit of 13.10: Result_Page per Platform and Scrape_Run.
 *
 * **This is a safety net, not the intended retrieval depth.** 13.3 asks for the result list to be
 * read to its *end*; this number only bounds a Platform that keeps claiming a further Result_Page
 * without ever delivering a last one, which is a real failure mode of an infinite-scroll list and of
 * a `load-more` control that never disables itself. A retrieval that hits it reports
 * `PAGE_LIMIT_REACHED` and is therefore a Partial_Result (7.7, 13.11) — the honest statement that
 * the Job_Tool stopped before the Platform did.
 *
 * 100 rather than the 10 this started at. The binding constraint is not this number but the
 * 30-minute retrieval window of 13.6: one Platform's page requests are strictly serial with the
 * 2-second gap of 13.2, so at a realistic 2 to 3 seconds per load a Platform manages roughly 360 to
 * 600 Result_Page inside the window. 100 pages is about 7 minutes per Platform, comfortably inside
 * it, while being far more than any of the four Platform actually offers for one search.
 *
 * A Platform whose robots.txt or whose pagination mechanism leaves fewer Result_Page addressable
 * declares that through {@link PlatformAdapter.pageLimit}, which is the tighter bound of the two
 * (13.13).
 */
export const RESULT_PAGE_BUDGET = 100;

/** The per-Result_Page time limit of 6.2 and 13.4, in milliseconds. */
export const RESULT_PAGE_TIMEOUT_MS = 30_000;

/**
 * Raw, unnormalized values as read from a Result_Page.
 *
 * Every field is nullable because the page is the source of truth for presence: a field the Platform
 * does not show is `null` here, and the decision between "discard the Job_Posting" (6.5) and "mark the
 * field as empty" (6.8) belongs to the normalization layer, not to the adapter.
 */
export interface RawJobPosting {
  readonly postingId: string | null;
  readonly title: string | null;
  readonly employer: string | null;
  readonly workLocation: string | null;
  /** Either an ISO date or a platform-specific relative text such as "vor 3 Tagen" (6.4). */
  readonly publishedAtText: string | null;
  readonly sourceUrl: string | null;
  readonly descriptionText: string | null;
}

/** The severity of an {@link AdapterLogEvent}, matching the levels of the Log_Stream. */
export type AdapterLogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * One entry a Platform_Adapter writes to the Log_Stream.
 *
 * The stable English `code` is what tests assert on and what the error mapping keys off; `messageDe` is
 * the German text the Log_View shows (12.3, 16.8). Both travel together so that no component has to
 * reconstruct one from the other.
 */
export interface AdapterLogEvent {
  readonly level: AdapterLogLevel;
  /** Stable English key, asserted on in tests, for example `platform.pageLimit`. */
  readonly code: string;
  /** German text shown in the Log_View (12.3). */
  readonly messageDe: string;
  /** The 1-based Result_Page the event belongs to, where the event belongs to a page (13.1). */
  readonly pageNumber?: number;
  readonly sourceUrl?: string;
}

/** What a single Result_Page load answered with, apart from its HTML. */
export interface AdapterPageResponse {
  /** The URL the load ended on, which differs from the requested one after a redirect (7.2). */
  readonly url: string;
  /** HTTP status of the main document, or `null` where the Platform served none. */
  readonly status: number | null;
  /**
   * Response headers with lowercased names. Read for the rate-limit signals of 13.5 (`retry-after`
   * and the per-Platform quota headers); an adapter that needs none ignores them.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The one page operation a Platform_Adapter performs, as a port rather than as a Playwright type.
 *
 * The implementing runtime (task 8.4) owns the browser, the Job_Tool user agent (14.5), the request
 * interception and the per-page time limit of 6.2; the implementing test owns a frozen HTML fixture.
 * Neither detail belongs in an adapter, so neither appears here.
 */
export interface AdapterPage {
  /**
   * Loads one Result_Page.
   *
   * @param url The absolute Result_Page URL, built by {@link PlatformAdapter.resultListUrl}.
   * @returns Where the load ended and how the Platform answered.
   * @throws A `RetryableRequestError` when the load exceeded {@link AdapterContext.pageTimeoutMs} or
   *   failed at the transport level, so that the PlatformQueue can spend the repetitions of 13.4.
   */
  load(url: string): Promise<AdapterPageResponse>;
  /** The HTML of the Result_Page last loaded, which is the input of the adapter's parser. */
  html(): Promise<string>;
  /**
   * Operates an in-page pagination control to reveal the next block of Job_Posting (13.12).
   *
   * This exists because a Platform may paginate its result list through a control rather than
   * through an addressable Result_Page URL — Glassdoor's `<button data-test="load-more">` is the
   * case it was written for. Without it, 13.3 would be unreachable for such a Platform: the next
   * block has no URL to request, so the only way to the rest of the result list is the control the
   * Platform itself offers.
   *
   * **It is deliberately not a general `click`.** The narrow shape is what keeps the prohibitions of
   * 7.1, 7.5 and 7.6 intact: this method reveals more of a result list the Job_Tool is already
   * reading, and it must never be used to submit a form, to supply credentials, to sign in or to
   * answer a Captcha. A Platform that presents a sign-in wall or a bot check is *ended* (7.2, 7.6),
   * never clicked through.
   *
   * After it returns `true`, {@link AdapterPage.html} answers the grown document — which for an
   * appending control contains every block read so far, not only the new one. An adapter therefore
   * replaces its posting list from each reading rather than appending to it.
   *
   * @param selector A CSS selector naming the pagination control of that Platform.
   * @returns `true` when the control was present, was operated and the document grew; `false` when
   *   it was absent, disabled, or revealed nothing further — each of which is the end of the result
   *   list rather than a failure.
   * @throws A `RetryableRequestError` when the step exceeded {@link AdapterContext.pageTimeoutMs} or
   *   failed at the transport level, so that the PlatformQueue can spend the repetitions of 13.4.
   */
  loadMore(selector: string): Promise<boolean>;
  /** Releases the page. The runtime closes it again in its own `finally` block, so this is idempotent. */
  close(): Promise<void>;
}

/**
 * Everything one Platform_Adapter receives for one Scrape_Run.
 *
 * The context is the only channel: an adapter reads no configuration, no clock and no environment of
 * its own. That keeps a Scrape_Run reproducible from its inputs and keeps the adapter tests free of
 * globals.
 */
export interface AdapterContext {
  readonly runId: string;
  /** Reference point for converting relative dates such as "vor 3 Tagen" (6.4). */
  readonly runStartedAt: Date;
  /** The effective Search_Profile of this Platform, already resolved by the Profile_Resolver (5.1). */
  readonly profile: EffectiveSearchProfile;
  /**
   * Opens a page in the BrowserContext of this Platform. Each call goes through the PlatformQueue of
   * that Platform, which enforces the single in-flight page request of 13.9, the minimum gap of 13.2
   * and a stated crawl-delay (14.4), so an adapter never paces itself.
   */
  readonly openPage: () => Promise<AdapterPage>;
  /** Max Result_Page per Platform and Scrape_Run, {@link RESULT_PAGE_BUDGET} in production (13.3). */
  readonly pageBudget: number;
  /** Per-Result_Page timeout, {@link RESULT_PAGE_TIMEOUT_MS} in production (6.2, 13.4). */
  readonly pageTimeoutMs: number;
  readonly log: (event: AdapterLogEvent) => void;
  /** Cancellation of the Scrape_Run by the user (12.7) or by the 30-minute limit (13.6). */
  readonly signal: AbortSignal;
}

/** What one Platform_Adapter reports back for one Platform of one Scrape_Run. */
export interface AdapterResult {
  readonly platform: Platform;
  /** Everything read before the retrieval ended, in page order. Never discarded (7.7, 13.5, 13.8). */
  readonly postings: readonly RawJobPosting[];
  readonly platformStatus: PlatformStatus;
  /** Result_Page actually retrieved, at most `context.pageBudget` (13.3). */
  readonly pagesFetched: number;
  /** True when the retrieval ended with a Platform_Status other than `COMPLETED` (Partial_Result, 7.7). */
  readonly partialResult: boolean;
}

/**
 * The uniform adapter interface of Requirement 6.6.
 *
 * `TCapability` stays open so that a concrete adapter keeps the literal tuples of its capability
 * declaration: `resultListUrl` can then read exactly the Criterion_Field its Platform supports, and a
 * Platform_Override for an unsupported field stays the compile error that 4.5 demands.
 */
export interface PlatformAdapter<TCapability extends PlatformCapability = PlatformCapability> {
  /** What this Platform can express in its result list query (4.2). Also the registry key check. */
  readonly capability: TCapability;
  /**
   * This Platform's own upper bound on Result_Page per Scrape_Run, where it is tighter than the
   * {@link RESULT_PAGE_BUDGET} of 13.10. Omitted by a Platform that has no such bound.
   *
   * Declared on the interface rather than hidden inside the adapter because the Scraper_Service
   * needs it *before* the first page request: it resolves every intended path for the robots.txt
   * evaluation of 14.1, and a Platform is excluded if any of them is forbidden (14.2). A Platform
   * whose pagination parameter its own robots.txt disallows would therefore be excluded in full on
   * account of paths the adapter never intended to request. 13.13 is what this prevents, and
   * `intendedPathsOf` in `apps/api/src/scraper/scraper.service.ts` is the one reader.
   *
   * Two of the four Platform declare one, both `1` and both for a reason recorded beside the
   * constant: Stepstone, whose robots.txt forbids every pagination shape, and Indeed, whose
   * robots.txt forbids its only pagination parameter.
   */
  readonly pageLimit?: number;
  /**
   * The result list entry point for one page, used for the robots.txt evaluation before the first page
   * request (14.1) and documented per Platform (14.7).
   *
   * @param profile The effective Search_Profile of this Platform.
   * @param pageNumber The 1-based Result_Page number.
   */
  readonly resultListUrl: (profile: EffectiveSearchProfile, pageNumber: number) => string;
  /**
   * Retrieves the publicly accessible result list of this Platform (6.2).
   *
   * An implementation ends the retrieval by returning a result — including for a sign-in prompt, a bot
   * check, an unknown page layout or a reported rate limit, whose Platform_Status the adapter sets
   * itself. Throwing is reserved for the unexpected; the Scraper_Service maps a thrown error onto
   * Platform_Status `FAILED` and keeps the postings already handed over (13.1).
   */
  fetch(context: AdapterContext): Promise<AdapterResult>;
}

/** The Platform_Status that stands for a retrieval which ran to its natural end. */
const COMPLETED_STATUS: PlatformStatus = 'COMPLETED';

/**
 * Builds an {@link AdapterResult} from what an adapter knows, deriving `partialResult` from the
 * Platform_Status.
 *
 * Derived rather than passed so that the Partial_Result rule of 7.7 lives in exactly one place: every
 * end other than `COMPLETED` leaves a Partial_Result, including the orderly `PAGE_LIMIT_REACHED` end of
 * 13.3, where the postings read so far are kept but the result list of that Platform is not exhausted.
 */
export function buildAdapterResult(result: Omit<AdapterResult, 'partialResult'>): AdapterResult {
  return { ...result, partialResult: result.platformStatus !== COMPLETED_STATUS };
}

/**
 * The number of Result_Page one adapter may actually read, from the budget it was handed.
 *
 * Three bounds, narrowest wins: the {@link AdapterContext.pageBudget} the caller passed, the
 * {@link RESULT_PAGE_BUDGET} of 13.10 so the Page_Safety_Limit holds even against a larger budget,
 * and the Platform's own `platformLimit` where its robots.txt or its pagination mechanism leaves
 * fewer Result_Page addressable (13.13).
 *
 * A test may shrink the budget below every bound — which is what keeps the `PAGE_LIMIT_REACHED` path
 * and the Partial_Result rule of 7.7 observable without a hundred fixtures — and nothing can raise
 * it. A non-finite budget falls back to the bound rather than looping, and a negative one floors at
 * 0 so a nonsensical budget reads no page at all.
 *
 * Shared by all four adapters rather than copied into each, because it is one rule of 13.10 and
 * 13.13 and not four.
 *
 * @param pageBudget What the {@link AdapterContext} handed in.
 * @param platformLimit This Platform's own bound; omit where it has none.
 */
export function effectivePageBudget(pageBudget: number, platformLimit?: number): number {
  const upperBound = Math.min(RESULT_PAGE_BUDGET, platformLimit ?? RESULT_PAGE_BUDGET);

  if (!Number.isFinite(pageBudget)) {
    return upperBound;
  }

  return Math.min(Math.max(Math.trunc(pageBudget), 0), upperBound);
}
