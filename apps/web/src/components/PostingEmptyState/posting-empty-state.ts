/**
 * Which of the three empty states of the posting overview applies (2.8, 10.12, 10.13).
 *
 * Separate from the component that renders it, like `postingFilterInputOf` next to the filter bar,
 * because the interesting part is not the markup: it is that three requirements describe three
 * *different* situations which all look identical on the wire. `jobPostings` answers each of them
 * with `items: []`, so the hint the user gets is decided entirely by two further questions, and
 * getting either of them wrong means telling the user to start a Scrape_Run that has already run or
 * to reset filters they never set.
 *
 * ## The two questions
 *
 * **Is any filter set?** That is `hasSetFilter` in `../FilterBar/posting-filter-values.ts`, and it
 * is exactly what separates 10.12 from 10.13: an empty result with no filter set is a statement
 * about the Posting_Store, while an empty result with a filter set is a statement about the filter
 * combination — which 10.13 asks to be left *set*, with "Filter zurücksetzen" offered as the way
 * out. A filter result is therefore reported as such even where the Posting_Store is in fact empty:
 * the user set those filters and gets an answer about them, and resetting them produces the hint
 * about the store on the next read.
 *
 * **Has a Scrape_Run been completed?** That is `latestScrapeRun !== null`, the same value the run
 * summary is built from (11.6). It separates 10.12 from 2.8. Both speak about an empty
 * Posting_Store, and they differ in what the user is supposed to do about it: with no completed
 * Scrape_Run there is nothing to review yet and the next step is to start one (10.12), while after
 * a completed Scrape_Run the Job_Tool *has* asked the Platform and come back with nothing — "keine
 * Treffer" — and the next step is the read-only criteria view, because the criteria are what the
 * search found nothing for (2.8).
 *
 * That split is also what the German wordings in `src/i18n/de.ts` already say: `storeHint` opens
 * with "Es wurde noch kein Suchlauf durchgeführt", `runWithoutHitsHint` with "Der Suchlauf hat keine
 * Treffer geliefert". Only one of the two can be true at a time, and this function is where that is
 * decided.
 *
 * Requirements: 2.8, 10.12, 10.13.
 */

/** What the two questions above resolve to. Each value is one hint with one call to action. */
export type PostingEmptyStateKind =
  /** A filter combination that matches nothing; the filters stay set (10.13). */
  | 'FILTER_RESULT'
  /** No Job_Posting at all and no completed Scrape_Run yet (10.12). */
  | 'STORE'
  /** No Job_Posting, but a Scrape_Run has completed: it found nothing (2.8). */
  | 'RUN_WITHOUT_HITS';

/** The inputs the choice is made from. Both are facts about the answer the overview just read. */
export interface PostingEmptyStateInputs {
  /** Whether the user has set any filter at all; see `hasSetFilter`. */
  readonly hasFilter: boolean;

  /** Whether a Scrape_Run has reached the Run_Outcome "completed"; `latestScrapeRun !== null`. */
  readonly hasCompletedRun: boolean;
}

/** Which empty state an empty page of Job_Posting is (2.8, 10.12, 10.13). */
export const postingEmptyStateKindOf = ({
  hasFilter,
  hasCompletedRun,
}: PostingEmptyStateInputs): PostingEmptyStateKind => {
  if (hasFilter) {
    return 'FILTER_RESULT';
  }

  return hasCompletedRun ? 'RUN_WITHOUT_HITS' : 'STORE';
};
