/**
 * The deactivated Relevance_Service: no AI_Provider request at all (15.9, 15.10).
 *
 * `RELEVANCE_ASSESSOR` is bound to this class whenever the switch in the environment file turns the
 * relevance assessment off or no API key is configured. It answers `NO_API_KEY` without touching a
 * network, which the Relevance_Service turns into the Relevance_Verdict `NOT_ASSESSED` for every
 * Job_Posting of the Scrape_Run.
 *
 * ## Why a bound no-op rather than an unbound token
 *
 * The sibling {@link LOCATION_NORMALIZER} expresses "deactivated" as an absent binding, because 8.5
 * then describes a Commute_Service that asks nobody and *records nothing*. The relevance assessment
 * cannot do that: 15.10 requires every Job_Posting to be stored with a verdict even without an API
 * key, and 15.14 requires exactly one verdict per Job_Posting in every case. "Not assessed" is a
 * result that has to be written, so the deactivated case is a value of {@link RelevanceOutcome}
 * rather than a missing provider — and `RelevanceService` consequently injects the token without
 * `@Optional()` and has one code path instead of two.
 *
 * ## What "every other function unaffected" means here (15.10)
 *
 * This class holds no configuration, constructs no HTTP client and reads no credential. There is
 * nothing in it that can fail, so an installation without an AI_Provider account runs the retrieval
 * phase, the Posting_Store writes, the commute determination and the whole read layer exactly as an
 * activated one does. The one observable difference is the verdict of a Job_Posting.
 *
 * Requirements: 15.9, 15.10, 15.14.
 */

import { Injectable } from '@nestjs/common';

import type { RelevanceAssessor, RelevanceOutcome } from './relevance-assessor.port';

/**
 * The model name of a deactivated Relevance_Service: none.
 *
 * Empty rather than a word like "none" or "disabled", because this value is a *model identifier*
 * everywhere it is read, and no model answers here. Whether the service is activated is reported by
 * `RelevanceService.activated` — a boolean the landing page of 14.8 can state — not by comparing
 * this string against a sentinel.
 */
export const NO_RELEVANCE_MODEL = '';

/** The {@link RelevanceAssessor} of a deactivated Relevance_Service (15.9, 15.10). */
@Injectable()
export class NoopRelevanceAssessor implements RelevanceAssessor {
  /** No model is asked, so there is no model name to report (14.9). */
  readonly model = NO_RELEVANCE_MODEL;

  /**
   * Answers `NO_API_KEY` without sending a request (15.10).
   *
   * The parameters of the port are deliberately not declared: nothing here reads the posting data
   * or the signal, and an unused parameter would suggest otherwise. `NO_API_KEY` covers both
   * deactivation causes — which of the two it was is derived from the configuration once per run by
   * `relevanceDisabledReasonOf`, not per Job_Posting.
   */
  assess(): Promise<RelevanceOutcome> {
    return Promise.resolve({ kind: 'FAILED', code: 'NO_API_KEY' });
  }
}
