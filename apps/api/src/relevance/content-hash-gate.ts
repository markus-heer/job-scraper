/**
 * The one condition that decides whether a Job_Posting costs an AI_Provider request (15.5, 15.6,
 * 15.15).
 *
 * Three requirements meet in it, and the design states them as a single expression:
 *
 * - 15.5: while title and description text are unchanged, the stored assessment is retained and no
 *   further assessment is requested. `relevanceContentHash` is the hash the stored assessment was
 *   based on, so "unchanged" is `relevanceContentHash === contentHash`.
 * - 15.6: a recorded Job_Posting with a changed title or description text gets exactly one new
 *   assessment. The retrieval of 9.3 rewrites `contentHash` with the content, so a change shows up
 *   here as the two hashes differing.
 * - 15.15: a manually set Relevance_Verdict is retained in every following Scrape_Run in place of a
 *   service assessment, which is `relevanceSetManually === false` as the first term.
 *
 * A hash comparison rather than a field-by-field one, because `computeContentHash` collapses
 * whitespace and normalizes Unicode (see `@job-scraper/domain`): a Platform that reflows its markup
 * must not cost a paid re-assessment, while a changed sentence must.
 *
 * ## Why this is a function and not a `where` clause
 *
 * The gate compares two columns of the same row, and the candidate query of the enrichment stage
 * has to read those columns anyway — the assessment request is built from the same row. Expressing
 * the comparison in SQL would need a field reference on the generated Prisma delegate, which every
 * stand-in store in a unit test would then have to imitate, and it would put the condition of 15.5,
 * 15.6 and 15.15 somewhere a property test cannot call. The query therefore narrows to what an
 * index answers — the Job_Posting of the running Scrape_Run that carry no manual verdict — and this
 * function decides the rest, once, in one place.
 *
 * Requirements: 15.5, 15.6, 15.15.
 */

/** The three columns the gate reads. The rest of a `JobPosting` row is irrelevant to it. */
export interface RelevanceGateRow {
  /** True where the user set the Relevance_Verdict by hand (15.15). */
  readonly relevanceSetManually: boolean;
  /** Content hash the stored assessment was based on; `null` where none was ever stored. */
  readonly relevanceContentHash: string | null;
  /** Content hash of the currently stored title and description text (15.5). */
  readonly contentHash: string;
}

/**
 * Whether a new assessment is requested for this Job_Posting (15.5, 15.6, 15.15).
 *
 * @param row The three gate columns as the Posting_Store holds them.
 * @returns `true` exactly when the verdict is not manual and no stored assessment covers the
 *   current content.
 */
export const needsRelevanceAssessment = (row: RelevanceGateRow): boolean =>
  !row.relevanceSetManually &&
  (row.relevanceContentHash === null || row.relevanceContentHash !== row.contentHash);
