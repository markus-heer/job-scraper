/**
 * The Indeed Platform_Adapter (6.1, 6.2, 6.7, 7.2, 7.6, 7.7, 7.8, 13.3, 13.5).
 *
 * The adapter is the sequencer of a Platform's retrieval and nothing else. It builds the Result_Page URL
 * from the effective Search_Profile, walks the pages up to the limit of 13.3, hands each page to the
 * pure reader in `./parse-result-list.ts`, writes the German progress lines of 12.3 and reports one
 * Platform_Status for the Platform. That is the uniform interface of 6.6: the sequence below is the same
 * as the Stepstone, Jobvector and Glassdoor adapters', and everything Platform-specific sits in the URL
 * builder, the selector tables and the message module next to this file.
 *
 * What is different about Indeed is its retrieval scope, and both halves of it come from the robots.txt
 * of the Platform rather than from anything in this file:
 *
 * - **Five Criterion_Field, not six.** `PLATFORM_CAPABILITIES.INDEED` declares `jobTitle`,
 *   `titleSynonyms`, `searchLocation`, `employmentType` and `publicationPeriodDays`, with `jobTitle` and
 *   `searchLocation` mandatory. `searchRadiusKm` is absent although Indeed offers a radius selector,
 *   because `Disallow: /*radius=` forbids a URL that states one (14.2).
 * - **One Result_Page per Scrape_Run.** `Disallow: /*&start=` forbids Indeed's only pagination
 *   parameter, so `effectivePageBudget` caps the walk at `INDEED_RESULT_PAGE_LIMIT`.
 *
 * Both are decided and documented in `./result-list-url.ts`; this file never names a Criterion_Field
 * and only applies the cap.
 *
 * What it deliberately does not do, because another component owns it:
 *
 * - *Pacing, repetition and the page time limit.* Every `page.load` goes through the `PlatformQueue`
 *   behind {@link AdapterContext.openPage}, which holds the single in-flight request of 13.9, the
 *   2-second gap of 13.2, a stated crawl-delay (14.4) and the at-most-three attempts of 13.4. The
 *   adapter therefore contains no sleep, no retry counter and no timeout.
 * - *Normalization.* The postings leave as {@link RawJobPosting}. Field limits, ISO dates, the discard
 *   rule of 6.5 and the "mark as empty" rule of 6.8 are applied once, by the normalization stage.
 * - *The user agent.* It is the unchanged Job_Tool identification of 14.5, built by `buildUserAgent`
 *   from `USER_AGENT_CONTACT` and set by the Playwright runtime. This adapter neither reads it nor
 *   overrides it: there is no per-adapter user agent, and imitating a browser is forbidden — which is
 *   precisely why a block is a likely outcome here and is accepted as one.
 * - *The German summary sentence per Platform_Status.* That is mapped in the API_Service from the status
 *   and the log code (7.4).
 *
 * ## The bot protection: what this adapter does and does not do
 *
 * The design's risk note accepts a permanent Platform_Status `PLATFORM_BLOCKED` or `SIGN_IN_REQUIRED`
 * for Indeed as a realistic outcome, and 7.5, 7.6 and 7.8 say what may be done about it: nothing. Three
 * guarantees, each structural rather than aspirational:
 *
 * - **No Captcha is answered.** The reader detects a challenge page — including one served with a `503`
 *   rather than a `403`, which is the Indeed-specific ordering in that file — and reports it; there is
 *   no code path in this directory that submits a challenge form, reads a challenge token, or follows a
 *   challenge redirect. The retrieval ends on the observation (7.6).
 * - **No sign-in is attempted and no credential exists.** A sign-in wall is detected from the URL the
 *   load ended on and from the markers of the wall, and ends the retrieval. No form is filled, nothing
 *   is submitted, and the Job_Tool stores no Platform credential at all (7.1, 7.5).
 * - **No further attempt follows in the same Scrape_Run** (7.8), and that holds in three layers rather
 *   than by a counter in this file: the `for` loop below `return`s on every outcome other than
 *   `POSTINGS`, so no further page request is even built; `ScraperService.retrievePlatform` closes this
 *   Platform's page source in its `finally`, which closes its `PlatformQueue` permanently, so a request
 *   handed to it afterwards rejects with `PlatformQueueClosedError` *without its task running*; and the
 *   Scraper_Service calls `fetch` exactly once per Platform and Scrape_Run.
 *
 * ## Ending a retrieval: return, do not throw
 *
 * Every end this adapter can observe is a *result*, not an exception: a sign-in wall (7.2), a bot check
 * (7.6), an unreadable layout (6.7), a reported fetch rate (13.5) and the page limit (13.3) all return
 * an {@link AdapterResult} carrying the Job_Posting read so far. That is what keeps the Partial_Result
 * of 7.7 — a thrown error would take the postings with it, and for this Platform the postings read
 * before a block are frequently the only ones there will be. The error classes of `../../adapter/errors`
 * are still used, as the single place that pairs an observation with its Platform_Status and its log
 * code; they are constructed and reported rather than thrown, and `buildAdapterResult` derives
 * `partialResult` from the Platform_Status.
 *
 * The one exception is cancellation: an aborted Scrape_Run (12.7, 13.6) rejects, because only the
 * Scraper_Service knows whether the user cancelled or the 30-minute deadline struck, and inventing a
 * Platform_Status here would overwrite that knowledge.
 *
 * ## The 5-second bound of 7.2 and 7.6
 *
 * A sign-in prompt and a bot check are recognised from a page that has already loaded, and the adapter
 * returns from that observation without a further page request. The remaining work is parsing and
 * closing the page, so the bound holds by construction rather than by a timer.
 */

import { PLATFORM_CAPABILITIES, type PlatformCapabilityMap } from '@job-scraper/domain';

import {
  AdapterError,
  FetchRateLimitedError,
  isAdapterError,
  PageLayoutUnknownError,
  PlatformBlockedError,
  platformStatusForError,
  PlatformUnreachableError,
  SignInRequiredError,
} from '../../adapter/errors.js';
import {
  type AdapterContext,
  type AdapterPage,
  type AdapterPageResponse,
  type AdapterResult,
  buildAdapterResult,
  effectivePageBudget,
  type RawJobPosting,
} from '../../adapter/types.js';
import type { PlatformAdapterFor } from '../../registry.js';
import {
  emptyResultListEvent,
  endOfRetrievalEvent,
  pageFetchedEvent,
  pageLimitReachedEvent,
  resultListCompleteEvent,
} from './messages.js';
import { readIndeedResultPage, type ResultPageOutcome } from './parse-result-list.js';
import { indeedResultListUrl } from './result-list-url.js';

/** The Platform this adapter serves. Named once, so no string literal is repeated below. */
const PLATFORM = 'INDEED';

/** Where a page ended the retrieval: the error that carries the Platform_Status and the log code. */
function endOfRetrievalError(
  outcome: Exclude<ResultPageOutcome, 'POSTINGS' | 'EMPTY_RESULT_LIST'>,
  pageNumber: number,
  sourceUrl: string,
): AdapterError {
  const details = { pageNumber, sourceUrl };

  switch (outcome) {
    case 'SIGN_IN_REQUIRED':
      return new SignInRequiredError(PLATFORM, details);
    case 'BOT_CHECK':
      // 7.6: the check stays unanswered. The error only reports it, and `PLATFORM_BLOCKED` is what
      // keeps the Scraper_Service from starting a further attempt in this Scrape_Run (7.8).
      return new PlatformBlockedError(PLATFORM, details);
    case 'RATE_LIMITED':
      return new FetchRateLimitedError(PLATFORM, details);
    case 'UNREACHABLE':
      return new PlatformUnreachableError(PLATFORM, details);
    case 'LAYOUT_UNKNOWN':
      return new PageLayoutUnknownError(PLATFORM, details);
  }
}

/**
 * The error to report for a failed page request.
 *
 * An exhausted attempt series (`RequestAttemptsExhaustedError`) and a closed queue
 * (`PlatformQueueClosedError`) both answer `FAILED` through {@link platformStatusForError}, which is what
 * 13.8 asks for; an {@link AdapterError} that reached here from the runtime keeps its own status.
 */
function pageRequestError(error: unknown, pageNumber: number, sourceUrl: string): AdapterError {
  if (isAdapterError(error)) {
    return error;
  }

  return new AdapterError({
    platform: PLATFORM,
    platformStatus: platformStatusForError(error),
    code: 'page.failed',
    message: `Platform ${PLATFORM} delivered no Result_Page ${String(pageNumber)}.`,
    pageNumber,
    sourceUrl,
    cause: error,
  });
}

/** The Indeed Platform_Adapter. Registered in `../../registry.ts`, instantiated exactly once. */
export class IndeedAdapter implements PlatformAdapterFor<typeof PLATFORM> {
  /** What Indeed can express in its result list query (4.2). */
  readonly capability: PlatformCapabilityMap[typeof PLATFORM] = PLATFORM_CAPABILITIES[PLATFORM];

  // No `pageLimit`. `Disallow: /*&start=` forbids this Platform's only pagination parameter, which
  // the robots.txt evaluation reports per Scrape_Run (14.12) but which does not gate under the
  // configured Robots_Policy of 14.10. Moot in practice: `PLATFORM_ACTIVATION.INDEED` is `false`
  // because de.indeed.com answers the honest user agent with HTTP 403 and a Cloudflare check — an
  // access control, not a convention, and this repository does not defeat those.

  /** The result list entry point of one page (14.1, 14.7). See `./result-list-url.ts`. */
  readonly resultListUrl = indeedResultListUrl;

  /**
   * Retrieves the publicly accessible Indeed result list (6.2).
   *
   * @param context Everything this Scrape_Run supplies; see {@link AdapterContext}.
   * @returns The Job_Posting read, in page order, with exactly one Platform_Status and the number of
   *   Result_Page actually retrieved. A bot check or a sign-in wall is one of those returns, carrying
   *   whatever was read before it (7.7).
   * @throws The abort reason of `context.signal` when the Scrape_Run is cancelled (12.7, 13.6).
   */
  async fetch(context: AdapterContext): Promise<AdapterResult> {
    const postings: RawJobPosting[] = [];
    const budget = effectivePageBudget(context.pageBudget);
    let pagesFetched = 0;

    /** One {@link AdapterResult} from the state collected so far. */
    const finish = (platformStatus: AdapterResult['platformStatus']): AdapterResult =>
      buildAdapterResult({ platform: PLATFORM, postings, platformStatus, pagesFetched });

    /** Reports the end of the retrieval and builds the result that keeps the Partial_Result (7.7). */
    const endWith = (error: AdapterError): AdapterResult => {
      context.log(endOfRetrievalEvent(error));

      return finish(error.platformStatus);
    };

    context.signal.throwIfAborted();

    // One page for the whole retrieval: the queue behind it serialises the loads and paces them, so a
    // second page would buy nothing and would have to be torn down as well.
    const page: AdapterPage = await context.openPage();

    try {
      for (let pageNumber = 1; pageNumber <= budget; pageNumber += 1) {
        context.signal.throwIfAborted();

        const url = this.resultListUrl(context.profile, pageNumber);
        let html: string;
        let response: AdapterPageResponse;

        try {
          response = await page.load(url);
          pagesFetched += 1;
          html = await page.html();
        } catch (error) {
          // A cancelled Scrape_Run is not a Platform failure and is not this adapter's to classify.
          context.signal.throwIfAborted();

          return endWith(pageRequestError(error, pageNumber, url));
        }

        const reading = readIndeedResultPage({ html, response });
        const sourceUrl = response.url;

        // Taken over before the classification, whatever the page turned out to be: a sign-in wall or a
        // bot check can sit above a readable part of the list, and those postings are the
        // Partial_Result 7.7 keeps. For Indeed that is the likely case rather than the exotic one. A
        // posting that is missing one of the three fields of 6.5 travels on as well; the normalization
        // stage discards it and writes that event.
        postings.push(...reading.postings);

        if (reading.outcome === 'EMPTY_RESULT_LIST') {
          context.log(pageFetchedEvent(pageNumber, reading.postings.length, sourceUrl));
          context.log(emptyResultListEvent(pageNumber, sourceUrl));

          return finish('COMPLETED');
        }

        if (reading.outcome !== 'POSTINGS') {
          // The single exit for every end other than a readable page, and the reason 7.8 needs no
          // counter here: the loop is left, so no further Result_Page URL is built and no further
          // request is made for this Platform in this Scrape_Run.
          return endWith(endOfRetrievalError(reading.outcome, pageNumber, sourceUrl));
        }

        context.log(pageFetchedEvent(pageNumber, reading.postings.length, sourceUrl));

        if (!reading.hasNextPage) {
          context.log(resultListCompleteEvent(pagesFetched, postings.length));

          return finish('COMPLETED');
        }
      }

      // The budget is spent while Indeed still offers a further Result_Page: the orderly end of 13.3.
      // Reported as `PAGE_LIMIT_REACHED`, which makes the result a Partial_Result (7.7), because the
      // result list of this Platform was not read to its end. For Indeed the budget is spent after one
      // page, since `INDEED_RESULT_PAGE_LIMIT` is 1 — so this is the *normal* end of a retrieval that
      // found postings, not the exception it is for the other three Platform.
      context.log(pageLimitReachedEvent(pagesFetched));

      return finish('PAGE_LIMIT_REACHED');
    } finally {
      await page.close();
    }
  }
}
