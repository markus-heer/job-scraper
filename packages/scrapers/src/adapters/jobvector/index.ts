/**
 * The Jobvector Platform_Adapter (6.1, 6.2, 6.7, 7.2, 7.6, 7.7, 13.3, 13.5).
 *
 * The adapter is the sequencer of a Platform's retrieval and nothing else. It builds the Result_Page
 * URL from the effective Search_Profile, walks the pages up to the limit of 13.3, hands each page to
 * the pure reader in `./parse-result-list.ts`, writes the German progress lines of 12.3 and reports one
 * Platform_Status for the Platform. That is the uniform interface of 6.6: the sequence below is the
 * same as the Stepstone adapter's, and everything Platform-specific sits in the URL builder, the
 * selector tables and the message module next to this file.
 *
 * What is different about Jobvector is its capability declaration (4.2): `industry` is supported and
 * reaches the query, `employmentType` and `publicationPeriodDays` are not, and `jobTitle` is the only
 * mandatory Criterion_Field. All of that is handled in `./result-list-url.ts`; this file never names a
 * Criterion_Field.
 *
 * What it deliberately does not do, because another component owns it:
 *
 * - *Pacing, repetition and the page time limit.* Every `page.load` goes through the `PlatformQueue`
 *   behind {@link AdapterContext.openPage}, which holds the single in-flight request of 13.9, the
 *   2-second gap of 13.2, a stated crawl-delay (14.4) and the at-most-three attempts of 13.4. The
 *   adapter therefore contains no sleep, no retry counter and no timeout.
 * - *Normalization.* The postings leave as {@link RawJobPosting}. Field limits, ISO dates, the discard
 *   rule of 6.5 and the "mark as empty" rule of 6.8 are applied once, by the normalization stage.
 * - *The German summary sentence per Platform_Status.* That is mapped in the API_Service from the
 *   status and the log code (7.4).
 *
 * ## Ending a retrieval: return, do not throw
 *
 * Every end this adapter can observe is a *result*, not an exception: a sign-in wall (7.2), a bot check
 * (7.6), an unreadable layout (6.7), a reported fetch rate (13.5) and the page limit (13.3) all return
 * an {@link AdapterResult} carrying the Job_Posting read so far. That is what keeps the Partial_Result
 * of 7.7 — a thrown error would take the postings with it. The error classes of `../../adapter/errors`
 * are still used, as the single place that pairs an observation with its Platform_Status and its log
 * code; they are constructed and reported rather than thrown.
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
  SignInRequiredError,
} from '../../adapter/errors.js';
import {
  type AdapterContext,
  type AdapterPage,
  type AdapterPageResponse,
  type AdapterResult,
  buildAdapterResult,
  type RawJobPosting,
  RESULT_PAGE_BUDGET,
} from '../../adapter/types.js';
import type { PlatformAdapterFor } from '../../registry.js';
import {
  emptyResultListEvent,
  endOfRetrievalEvent,
  pageFetchedEvent,
  pageLimitReachedEvent,
  resultListCompleteEvent,
} from './messages.js';
import { readJobvectorResultPage, type ResultPageOutcome } from './parse-result-list.js';
import { jobvectorResultListUrl } from './result-list-url.js';

/** The Platform this adapter serves. Named once, so no string literal is repeated below. */
const PLATFORM = 'JOBVECTOR';

/**
 * The Result_Page the retrieval is permitted to read.
 *
 * `context.pageBudget` is the production value of 13.3 and is what the tests shrink to make a page
 * limit observable without ten fixtures. It is additionally capped at {@link RESULT_PAGE_BUDGET} here,
 * so the upper bound of 13.3 holds even if a caller passes a larger budget, and floored at 0 so a
 * nonsensical budget reads no page rather than looping.
 */
function effectivePageBudget(pageBudget: number): number {
  if (!Number.isFinite(pageBudget)) {
    return RESULT_PAGE_BUDGET;
  }

  return Math.min(Math.max(Math.trunc(pageBudget), 0), RESULT_PAGE_BUDGET);
}

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
      return new PlatformBlockedError(PLATFORM, details);
    case 'RATE_LIMITED':
      return new FetchRateLimitedError(PLATFORM, details);
    case 'UNREACHABLE':
      return new AdapterError({
        ...details,
        platform: PLATFORM,
        platformStatus: 'PLATFORM_UNREACHABLE',
        code: 'platform.unreachable',
        message: `Platform ${PLATFORM} did not serve a result list on Result_Page ${String(pageNumber)}.`,
      });
    case 'LAYOUT_UNKNOWN':
      return new PageLayoutUnknownError(PLATFORM, details);
  }
}

/**
 * The error to report for a failed page request.
 *
 * An exhausted attempt series (`RequestAttemptsExhaustedError`) and a closed queue
 * (`PlatformQueueClosedError`) both answer `FAILED` through {@link platformStatusForError}, which is
 * what 13.8 asks for; an {@link AdapterError} that reached here from the runtime keeps its own status.
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

/** The Jobvector Platform_Adapter. Registered in `../../registry.ts`, instantiated exactly once. */
export class JobvectorAdapter implements PlatformAdapterFor<typeof PLATFORM> {
  /** What Jobvector can express in its result list query (4.2). */
  readonly capability: PlatformCapabilityMap[typeof PLATFORM] = PLATFORM_CAPABILITIES[PLATFORM];

  /** The result list entry point of one page (14.1, 14.7). See `./result-list-url.ts`. */
  readonly resultListUrl = jobvectorResultListUrl;

  /**
   * Retrieves the publicly accessible Jobvector result list (6.2).
   *
   * @param context Everything this Scrape_Run supplies; see {@link AdapterContext}.
   * @returns The Job_Posting read, in page order, with exactly one Platform_Status and the number of
   *   Result_Page actually retrieved.
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

        const reading = readJobvectorResultPage({ html, response });
        const sourceUrl = response.url;

        // Taken over before the classification, whatever the page turned out to be: a sign-in overlay
        // or a bot check can sit above a readable part of the list, and those postings are the
        // Partial_Result 7.7 keeps. A posting that is missing one of the three fields of 6.5 travels on
        // as well; the normalization stage discards it and writes that event.
        postings.push(...reading.postings);

        if (reading.outcome === 'EMPTY_RESULT_LIST') {
          context.log(pageFetchedEvent(pageNumber, reading.postings.length, sourceUrl));
          context.log(emptyResultListEvent(pageNumber, sourceUrl));

          return finish('COMPLETED');
        }

        if (reading.outcome !== 'POSTINGS') {
          return endWith(endOfRetrievalError(reading.outcome, pageNumber, sourceUrl));
        }

        context.log(pageFetchedEvent(pageNumber, reading.postings.length, sourceUrl));

        if (!reading.hasNextPage) {
          context.log(resultListCompleteEvent(pagesFetched, postings.length));

          return finish('COMPLETED');
        }
      }

      // The budget is spent while Jobvector still offers a further Result_Page: the orderly end of
      // 13.3. Reported as `PAGE_LIMIT_REACHED`, which makes the result a Partial_Result (7.7), because
      // the result list of this Platform was not read to its end.
      context.log(pageLimitReachedEvent(pagesFetched));

      return finish('PAGE_LIMIT_REACHED');
    } finally {
      await page.close();
    }
  }
}
