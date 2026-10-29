/**
 * The "neu" marking of a Job_Posting, derived rather than stored (11.2, 11.3, 11.4, 11.6, 11.7).
 *
 * A Job_Posting carries the identifier of the Scrape_Run that recorded it first (11.1), and that
 * column is established once and never rewritten (11.8). The marking is therefore not a column of
 * its own but one comparison: `firstSeenRunId === latestCompletedRunId`. Everything 11.2 to 11.7
 * ask for follows from that single equality, which is why the design rejects a stored boolean:
 *
 * - **11.4** needs no write at all. A further completed Scrape_Run changes the compared identifier,
 *   so the marking moves to its postings and leaves every other one on the next read of the
 *   overview. A boolean column would mean a bulk update per run, and a crash between its two halves
 *   would leave a stale `true` behind that nothing ever corrects.
 * - **11.6** is the `latestCompletedRunId === null` case: no Scrape_Run has ever reached the
 *   Run_Outcome "completed", nothing compares equal, and nothing is marked. The German hint that
 *   replaces the counters of 11.5 in that case belongs to the Web_App; the API_Service answers
 *   `latestScrapeRun` with null — see `../scrape-run/scrape-run-read.service.ts`.
 * - **11.7** holds because a Scrape_Run that ended with any other Run_Outcome never becomes the
 *   latest *completed* one. Its postings are stored and listed, and they render unmarked while the
 *   marking stays where the last genuinely completed run left it. The stale-run recovery closes a
 *   crashed run the same way, with `CANCELLED_BY_TIME_LIMIT` and `closedByRecovery`, precisely so
 *   that a restart cannot move the marking either.
 *
 * What this module deliberately does not do is decide *which* Scrape_Run is the most recently
 * completed one. That is one query against the `ScrapeRun` table and it lives with the other
 * Scrape_Run reads, in `ScrapeRunReadService`. Here the identifier is a plain input, so the
 * derivation is a pure function of a posting and a string: no clock, no database, no ordering.
 *
 * Requirements: 11.2, 11.3, 11.4, 11.6, 11.7.
 */

import type { JobPosting, Prisma } from '../prisma/prisma.types';
import { DEFAULT_POSTING_SORT, type PostingSort } from './posting-page-query';

/** The one column the marking is derived from, so a caller may pass a selection as well as a row. */
export type MarkablePosting = Pick<JobPosting, 'firstSeenRunId'>;

/**
 * Whether a Job_Posting carries the marking "neu" (11.2).
 *
 * @param posting The stored Job_Posting, or any object carrying its `firstSeenRunId`.
 * @param latestCompletedRunId Identifier of the most recently completed Scrape_Run, or `null` where
 *   the Posting_Store holds none (11.6).
 * @returns True exactly when the Job_Posting was recorded for the first time in that Scrape_Run.
 */
export const isNewPosting = (
  posting: MarkablePosting,
  latestCompletedRunId: string | null,
): boolean => latestCompletedRunId !== null && posting.firstSeenRunId === latestCompletedRunId;

/**
 * The two groups of the default grouping, as a `JobPosting` filter each (11.3).
 *
 * The grouping is expressed as two filters rather than as an `orderBy`, because no `orderBy` can
 * express it: the sort key is the *equality* `firstSeenRunId = :latestCompletedRunId`, and Prisma
 * orders by columns and relations, not by expressions. Splitting the filtered set into "marked" and
 * "unmarked" and reading the two in order produces exactly the same sequence while every statement
 * stays an ordinary indexed query — `@@index([firstSeenRunId])` serves both halves, and the sort
 * inside each half is whatever the default sort of 10.7 prescribes.
 *
 * Both filters are meant to be combined with the caller's own conjunctive filter, which is what
 * keeps the grouping independent of the filtering of 10.5: the grouping reorders a result set, it
 * never changes which postings are in it.
 */
export interface NewFirstGroups {
  /** The Job_Posting marked "neu"; empty where no Scrape_Run has completed yet (11.6). */
  readonly marked: Prisma.JobPostingWhereInput;
  /** Every remaining Job_Posting, including the ones a later unfinished run recorded (11.7). */
  readonly unmarked: Prisma.JobPostingWhereInput;
}

/**
 * The filter of each group of the default grouping (11.3).
 *
 * Without a completed Scrape_Run the marked group is made empty rather than left out: `marked` then
 * matches no row at all and `unmarked` matches every one, so a caller that always reads both groups
 * in order gets the single ungrouped list 11.6 asks for without a branch of its own.
 *
 * @param latestCompletedRunId Identifier of the most recently completed Scrape_Run, or `null`.
 */
export const newFirstGroups = (latestCompletedRunId: string | null): NewFirstGroups =>
  latestCompletedRunId === null
    ? { marked: { id: { in: [] } }, unmarked: {} }
    : {
        marked: { firstSeenRunId: latestCompletedRunId },
        unmarked: { firstSeenRunId: { not: latestCompletedRunId } },
      };

/**
 * The grouping in force for one read, or `null` where the list is read ungrouped (11.3, 11.6).
 *
 * Two conditions have to hold for the grouping to apply, and both are read here so that no caller
 * has to restate either:
 *
 * - **The user chose no deviating sorting.** 11.3 scopes the grouping to exactly that case, so a
 *   read sorted by publication date, by Best_Commute_Time, by Relevance_Verdict or by recording time
 *   *ascending* is returned in that order alone — the user asked a question the grouping would
 *   answer past. A sorting that equals the default is the default: it is the same request, and 10.7
 *   makes recording time descending the order inside both groups anyway.
 * - **A Scrape_Run has completed.** Without one nothing is marked (11.6), so the grouping would
 *   split the set into an empty group and the whole set. Reading it ungrouped is the same list in
 *   the same order and two queries fewer.
 *
 * @param sort The sorting in force for this read.
 * @param latestCompletedRunId Identifier of the most recently completed Scrape_Run, or `null`.
 */
export const newFirstGroupingFor = (
  sort: PostingSort,
  latestCompletedRunId: string | null,
): NewFirstGroups | null =>
  latestCompletedRunId !== null &&
  sort.field === DEFAULT_POSTING_SORT.field &&
  sort.direction === DEFAULT_POSTING_SORT.direction
    ? newFirstGroups(latestCompletedRunId)
    : null;

/**
 * The window to read from each group for one page of the grouped list (11.3, 10.9).
 *
 * The grouped list is the concatenation "marked, then unmarked", so a page of it is a window over
 * that concatenation and never a window over each group separately. A page that straddles the
 * boundary therefore takes the tail of the marked group and the head of the unmarked one, and the
 * two numbers of each group below are exactly the `skip` and `take` of its query.
 */
export interface NewFirstPageSlices {
  readonly markedSkip: number;
  readonly markedTake: number;
  readonly unmarkedSkip: number;
  readonly unmarkedTake: number;
}

/** A non-negative integer, so a page computed from a bad input stays a page. */
const nonNegativeInteger = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/**
 * Splits one page of the grouped list into the window to read from each group (11.3, 10.9).
 *
 * Pure arithmetic over the concatenation, which is what makes the grouping page-correct instead of
 * page-local: ordering the entries of a single page would put marked postings above unmarked ones
 * *within* page 3 while page 2 still ended with an unmarked one, and 11.3 is a statement about the
 * whole overview.
 *
 * The caller needs the size of the marked group for this, and that is one `count` with the filter of
 * {@link newFirstGroups}; the total the page count of 10.9 is computed from is the sum of both
 * counts and is unaffected by the grouping.
 *
 * @param input `markedCount` is how many postings of the filtered set are marked "neu"; `skip` and
 *   `take` are the window of the requested page, i.e. `(page - 1) * pageSize` and `pageSize`.
 *   Negative, fractional or non-finite values are read as 0, so a page is never a nonsensical query.
 */
export const newFirstPageSlices = (input: {
  readonly markedCount: number;
  readonly skip: number;
  readonly take: number;
}): NewFirstPageSlices => {
  const markedCount = nonNegativeInteger(input.markedCount);
  const skip = nonNegativeInteger(input.skip);
  const take = nonNegativeInteger(input.take);

  // How much of the window still falls inside the marked group. Zero once the window starts at or
  // behind the group boundary, which is the case for every page after the marked ones are read.
  const markedSkip = Math.min(skip, markedCount);
  const markedTake = Math.min(take, markedCount - markedSkip);

  return {
    markedSkip,
    markedTake,
    // Where the window begins inside the unmarked group: at its head while the window still
    // straddles the boundary, and that much further in once the marked group is behind it.
    unmarkedSkip: Math.max(skip - markedCount, 0),
    unmarkedTake: take - markedTake,
  };
};
