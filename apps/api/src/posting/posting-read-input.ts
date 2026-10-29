/**
 * The one translation between the published GraphQL input and the read contract (10.5, 10.7).
 *
 * `JobPostingFilterInput` and `JobPostingSortInput` are what the Web_App sends; `PostingFilter` and
 * `PostingSort` in `./posting-page-query.ts` are what the repository reads. The two differ in
 * exactly one respect, and that difference is the reason this module exists: a nullable GraphQL
 * field arrives as `null` when the client sends it explicitly and is absent when the client omits
 * the member, while the read contract admits the absent case only.
 *
 * Collapsing `null` into "not set" is not a convenience. `postingWhereOf` reads an unset filter as
 * the default view of 10.6 and 10.11, and a `null` that reached it as a value would be compared
 * against a stored column — the posting overview would answer a cleared multi-select with an empty
 * list the user cannot explain. An empty array means the same thing and is collapsed by the read
 * contract itself, which documents why.
 *
 * Pure functions rather than methods on the input classes, so the translation can be asserted
 * without Nest and without a Posting_Store, and so the input classes stay declarations of the
 * schema.
 *
 * Requirements: 10.5, 10.6, 10.7, 10.11.
 */

import type { JobPostingFilterInput } from './models/job-posting-filter.input';
import type { JobPostingSortInput } from './models/job-posting-sort.input';
import { DEFAULT_POSTING_SORT, type PostingFilter, type PostingSort } from './posting-page-query';

/** A nullable list member of the input as the read contract takes it: a value, or not set. */
const setOrAbsent = <TValue>(
  values: readonly TValue[] | null | undefined,
): readonly TValue[] | undefined => (values === null ? undefined : values);

/** A nullable bound of the recording period as the read contract takes it (10.5). */
const boundOrAbsent = (value: Date | null | undefined): Date | undefined =>
  value === null ? undefined : value;

/**
 * The filters of 10.5 as the repository reads them.
 *
 * An absent argument is the unfiltered request — the state the posting overview is opened in — and
 * yields the empty filter, which is the default view of 10.6 and 10.11 rather than "everything".
 *
 * @param input The filter the client sent, or nothing where it sent none.
 */
export const postingFilterOf = (input: JobPostingFilterInput | null | undefined): PostingFilter => {
  if (input === null || input === undefined) {
    return {};
  }

  return {
    platforms: setOrAbsent(input.platforms),
    reachability: setOrAbsent(input.reachability),
    postingStatuses: setOrAbsent(input.postingStatuses),
    interestFlags: setOrAbsent(input.interestFlags),
    relevanceVerdicts: setOrAbsent(input.relevanceVerdicts),
    firstSeenFrom: boundOrAbsent(input.firstSeenFrom),
    firstSeenTo: boundOrAbsent(input.firstSeenTo),
  };
};

/**
 * The sorting of 10.7 as the repository reads it.
 *
 * An absent argument is `DEFAULT_POSTING_SORT`, recording time descending. The default is declared
 * on the input class as well, so a client that sends the argument without its members gets the same
 * order; this fallback covers the client that sends no argument at all.
 *
 * @param input The sorting the client sent, or nothing where it sent none.
 */
export const postingSortOf = (input: JobPostingSortInput | null | undefined): PostingSort =>
  input === null || input === undefined
    ? DEFAULT_POSTING_SORT
    : { field: input.field, direction: input.direction };
