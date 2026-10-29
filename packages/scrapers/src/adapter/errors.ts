/**
 * The error types a Platform_Adapter raises, and their single mapping onto Platform_Status.
 *
 * Requirement 13.1 is the rule behind this file: an adapter that ends a retrieval with an error does
 * not end the Scrape_Run. The Scraper_Service catches, reports the error with platform name and page
 * number, sets the Platform_Status of that Platform and executes the remaining activated adapters to
 * the end. For that to work without a chain of `instanceof` checks per call site, every error an
 * adapter raises on purpose carries the Platform_Status it stands for, and everything else maps to
 * `FAILED`.
 *
 * No German text lives here. The user-facing wording is mapped once, in the error mapping of the
 * API_Service, from the Platform_Status and the stable `code` carried by these errors — duplicating it
 * per adapter would be the second place it could drift.
 *
 * Deliberately *not* part of this hierarchy: the time limit of a single page request and its
 * repetitions. Those are owned by the `PlatformQueue` (`RetryableRequestError`,
 * `RequestAttemptsExhaustedError`), and an exhausted attempt series maps to `FAILED` (13.8), which is
 * exactly what {@link platformStatusForError} answers for an error it does not recognise.
 */

import type { Platform, PlatformStatus } from '@job-scraper/domain';

/** Where an adapter error occurred, as far as the adapter knows it. */
export interface AdapterErrorDetails {
  /** The 1-based Result_Page the retrieval was on, for the log entry of 13.1. */
  readonly pageNumber?: number;
  /** The Result_Page URL the observation was made on (6.7, 7.2, 7.6). */
  readonly sourceUrl?: string;
  readonly cause?: unknown;
}

/** Construction arguments of an {@link AdapterError}. */
export interface AdapterErrorOptions extends AdapterErrorDetails {
  readonly platform: Platform;
  /** The Platform_Status this error stands for; one of the 14 permitted values. */
  readonly platformStatus: PlatformStatus;
  /** Stable English log key, for example `platform.signInRequired`. */
  readonly code: string;
  /** English technical message. The German user text is derived from `platformStatus` and `code`. */
  readonly message: string;
}

/**
 * An error that ends the retrieval of exactly one Platform and names the Platform_Status to report.
 *
 * The subclasses below cover the observations the requirements name. The base class stays usable on
 * its own so the Playwright runtime and later adapters can report a further permitted Platform_Status
 * without a new class per case.
 */
export class AdapterError extends Error {
  /** The Platform whose retrieval ended. */
  readonly platform: Platform;

  /** The Platform_Status the Scraper_Service reports for that Platform. */
  readonly platformStatus: PlatformStatus;

  /** Stable English log key. */
  readonly code: string;

  /** The 1-based Result_Page the retrieval was on, where the adapter knows it. */
  readonly pageNumber: number | undefined;

  /** The Result_Page URL the observation was made on, where the adapter knows it. */
  readonly sourceUrl: string | undefined;

  constructor(options: AdapterErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AdapterError';
    this.platform = options.platform;
    this.platformStatus = options.platformStatus;
    this.code = options.code;
    this.pageNumber = options.pageNumber;
    this.sourceUrl = options.sourceUrl;
  }
}

/** The page suffix of a technical message, naming the Result_Page where one is known. */
function onPage(pageNumber: number | undefined): string {
  return pageNumber === undefined ? '' : ` on Result_Page ${String(pageNumber)}`;
}

/**
 * The Platform shows its result list only after sign-in: a redirect to a sign-in or registration page,
 * a covering overlay, or zero readable Job_Posting together with a sign-in prompt (7.2).
 *
 * The retrieval of that Platform ends without a further attempt in the same Scrape_Run (7.8) and the
 * Job_Posting already read stay as Partial_Result (7.7).
 */
export class SignInRequiredError extends AdapterError {
  constructor(platform: Platform, details: AdapterErrorDetails = {}) {
    super({
      ...details,
      platform,
      platformStatus: 'SIGN_IN_REQUIRED',
      code: 'platform.signInRequired',
      message: `Platform ${platform} showed a sign-in prompt${onPage(details.pageNumber)}; the retrieval ended.`,
    });
    this.name = 'SignInRequiredError';
  }
}

/**
 * The Platform served a Captcha page or bot check page (7.6). The check is left unanswered, the
 * retrieval ends within 5 seconds and no further attempt follows in the same Scrape_Run (7.8).
 */
export class PlatformBlockedError extends AdapterError {
  constructor(platform: Platform, details: AdapterErrorDetails = {}) {
    super({
      ...details,
      platform,
      platformStatus: 'PLATFORM_BLOCKED',
      code: 'platform.blocked',
      message: `Platform ${platform} served a bot check${onPage(details.pageNumber)}; the retrieval ended unanswered.`,
    });
    this.name = 'PlatformBlockedError';
  }
}

/**
 * A Result_Page loaded within the time limit but yielded no readable Job_Posting (6.7). The retrieval
 * of that Platform ends; the Scrape_Run continues unchanged for the remaining Platform.
 */
export class PageLayoutUnknownError extends AdapterError {
  constructor(platform: Platform, details: AdapterErrorDetails = {}) {
    super({
      ...details,
      platform,
      platformStatus: 'PAGE_LAYOUT_UNKNOWN',
      code: 'platform.layoutUnknown',
      message: `Platform ${platform} yielded no readable Job_Posting${onPage(details.pageNumber)}; the page layout is unknown.`,
    });
    this.name = 'PageLayoutUnknownError';
  }
}

/**
 * The Platform reported an exceeded permitted fetch rate (13.5). No further request reaches that
 * Platform in the running Scrape_Run and the postings normalized so far are retained.
 */
export class FetchRateLimitedError extends AdapterError {
  constructor(platform: Platform, details: AdapterErrorDetails = {}) {
    super({
      ...details,
      platform,
      platformStatus: 'FETCH_RATE_LIMITED',
      code: 'platform.rateLimited',
      message: `Platform ${platform} reported an exceeded fetch rate${onPage(details.pageNumber)}; no further request follows.`,
    });
    this.name = 'FetchRateLimitedError';
  }
}

/**
 * The Platform stayed unanswered at the transport level after the repetitions permitted by 6.10. The
 * Job_Posting already read are retained.
 */
export class PlatformUnreachableError extends AdapterError {
  constructor(platform: Platform, details: AdapterErrorDetails = {}) {
    super({
      ...details,
      platform,
      platformStatus: 'PLATFORM_UNREACHABLE',
      code: 'platform.unreachable',
      message: `Platform ${platform} was unreachable${onPage(details.pageNumber)}.`,
    });
    this.name = 'PlatformUnreachableError';
  }
}

/** Whether an unknown thrown value is an {@link AdapterError} carrying a Platform_Status. */
export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}

/**
 * The Platform_Status to report for an error that ended the retrieval of one Platform (13.1).
 *
 * @returns The Platform_Status the error carries, or `FAILED` for every error that names none — an
 *   exhausted attempt series (13.8) and any unexpected fault alike. Total over `unknown` on purpose:
 *   the Scraper_Service must be able to close a Platform with one of the 14 permitted values whatever
 *   reaches its catch block.
 */
export function platformStatusForError(error: unknown): PlatformStatus {
  return isAdapterError(error) ? error.platformStatus : 'FAILED';
}
