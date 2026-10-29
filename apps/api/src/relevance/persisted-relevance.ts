/**
 * One relevance assessment as the `JobPosting` row holds it (15.1, 15.6, 15.7, 15.10 to 15.12).
 *
 * `RelevanceService` answers with a decision; this is that decision as six columns, so the
 * repository stores what it is given and the stage decides nothing about shape. The commute stage's
 * `persistedCommuteResultOf` is the same split for the same reason.
 *
 * Three decisions are expressed here rather than in the write:
 *
 * - **The rank is derived, never passed in.** `relevanceRank` is the denormalized sort key of 10.7
 *   and is written in the same statement as the verdict, from `RELEVANCE_RANK` — so re-ordering the
 *   Relevance_Verdict values stays a change in one place and the two columns cannot drift.
 * - **`relevanceContentHash` is set only by an assessment that happened.** It records the content a
 *   *stored assessment* was based on, and that is what the gate of 15.5 and 15.6 reads. A failed, a
 *   discarded, a budget-skipped and a never-sent assessment therefore write `null`: anything else
 *   would close the gate on a Job_Posting that was never assessed, and the next Scrape_Run would
 *   never ask again. 15.11 and 15.12 both end in "continue", not in "give up for good".
 * - **Model name and assessment time belong to an answer.** Both are `null` without one. A
 *   Job_Posting that shows an assessment time but no verdict would claim an assessment the data
 *   does not contain.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.7, 15.10, 15.11, 15.12, 10.7.
 */

import { RELEVANCE_RANK, type RelevanceVerdict } from '@job-scraper/domain';

import type { RelevanceAssessment } from './relevance.service';

/** The six relevance columns of a Job_Posting, as one assessment leaves them. */
export interface PersistedRelevanceResult {
  readonly relevanceVerdict: RelevanceVerdict;
  /** The German Relevance_Reason, at most 300 characters, or `null` where there is none (15.3). */
  readonly relevanceReason: string | null;
  /** The model that answered, or `null` where none did (15.1). */
  readonly relevanceModel: string | null;
  /** When the answer arrived, or `null` where none did (15.1). */
  readonly relevanceAssessedAt: Date | null;
  /** The content the stored assessment is about, or `null` where nothing is stored (15.5). */
  readonly relevanceContentHash: string | null;
  /** The denormalized sort key of 10.7, always `RELEVANCE_RANK[relevanceVerdict]`. */
  readonly relevanceRank: number;
}

/**
 * One assessment as the `JobPosting` row holds it.
 *
 * @param assessment What the Relevance_Service decided for this Job_Posting.
 * @param contentHash The content hash of the row the assessment was requested for, which an
 *   assessed Job_Posting stores as the content its verdict is about (15.5).
 */
export const persistedRelevanceResultOf = (
  assessment: RelevanceAssessment,
  contentHash: string,
): PersistedRelevanceResult => {
  if (assessment.kind === 'ASSESSED') {
    return {
      relevanceVerdict: assessment.verdict,
      relevanceReason: assessment.reasonDe,
      relevanceModel: assessment.model,
      relevanceAssessedAt: assessment.assessedAt,
      relevanceContentHash: contentHash,
      relevanceRank: RELEVANCE_RANK[assessment.verdict],
    };
  }

  return {
    relevanceVerdict: 'NOT_ASSESSED',
    // `null` for a cause that is reported once per run, the German note for a cause that is about
    // this one Job_Posting; the Relevance_Service decides which, and the sentences are the error
    // table's (15.11, 15.12).
    relevanceReason: assessment.reasonDe,
    relevanceModel: null,
    relevanceAssessedAt: null,
    relevanceContentHash: null,
    relevanceRank: RELEVANCE_RANK.NOT_ASSESSED,
  };
};
