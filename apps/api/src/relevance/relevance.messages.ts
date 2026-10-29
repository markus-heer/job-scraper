/**
 * The German end-of-run text of the Relevance_Service: the assessment counters of 15.16.
 *
 * Everything the design's error table lists for the relevance assessment — the failed request
 * (15.11), the unusable response (15.12), the reached run budget (15.7), the deactivated service
 * (15.9, 15.10) — has its wording in `src/common/error-mapping.ts`, and every emitter takes it from
 * there through `failureLogEntry`. The counters are the one relevance line that is not a failure:
 * they report what a Scrape_Run's assessment came to, including a run in which nothing went wrong,
 * so there is no row of that table they could belong to.
 *
 * Own line rather than a part of the end-of-run summary: 15.16 attributes the counters to the
 * Relevance_Service and the design's sequence has it write them itself, while the summary of 7.4
 * and 12.10 reports the retrieval — Run_Outcome, runtime, one Platform_Status per requested
 * Platform. Keeping them apart also keeps the summary the last message of a run (12.10) without the
 * relevance stage having to finish before it can be composed.
 *
 * German for the user, a stable English code next to it — the split
 * `src/config/config.messages.ts` and `src/scrape-run/scrape-run.messages.ts` use.
 *
 * Requirements: 15.16, 16.8.
 */

/** The stable log code of the end-of-run assessment counters (15.16). */
export const RELEVANCE_COUNTERS_LOG_CODE = 'relevance.counters';

/** The three numbers 15.16 asks for, counted over the Job_Posting of one Scrape_Run. */
export interface RelevanceRunCounters {
  /** Job_Posting the AI_Provider answered for, stored with a verdict of its own (15.1). */
  readonly assessed: number;
  /** Job_Posting stored with the Relevance_Verdict "not relevant"; a subset of {@link assessed}. */
  readonly notRelevant: number;
  /** Job_Posting stored with the Relevance_Verdict "not assessed" (15.7, 15.10 to 15.12). */
  readonly notAssessed: number;
}

/**
 * The end-of-run assessment counters of a Scrape_Run (15.16).
 *
 * All three numbers are always printed, including a zero: "0 Treffer nicht bewertet." states that
 * every assessment got through, whereas dropping the clause would leave the reader to decide
 * whether the number was zero or unknown. The "not relevant" count is written as a part of the
 * assessed ones, because that is what it is — a subset, not a fourth group next to them.
 */
export const relevanceCountersMessageDe = (counters: RelevanceRunCounters): string =>
  `KI-Bewertung: ${String(counters.assessed)} Treffer bewertet, davon ` +
  `${String(counters.notRelevant)} nicht relevant. ` +
  `${String(counters.notAssessed)} Treffer nicht bewertet.`;
