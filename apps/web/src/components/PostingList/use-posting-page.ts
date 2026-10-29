import type { JobPostingFilterInput, JobPostingSortInput } from '../../graphql/schema.generated';
import { type JobPostingsQueryVariables, useJobPostingsQuery } from './job-postings.generated';

/**
 * The one way the posting overview reads a page of Job_Posting (10.1, 10.5, 10.7, 10.9).
 *
 * Two components need the same answer and must not cause two requests: `PostingList` renders the
 * rows, and the posting overview route needs `page`, `pageCount` and `totalCount` for the
 * pagination controls of 10.9 and needs to know whether the page came back empty for the empty
 * states of 10.12 and 10.13. Apollo Client keys the `jobPostings` field by its arguments and
 * answers the second caller from the cache — but only if both callers produce the *same* variables
 * object, and that is the whole reason this module exists.
 *
 * ## Why the variables are assembled here and nowhere else
 *
 * A variable that is present with the value `undefined` is not the same thing as an absent one:
 * Apollo compares variable objects by their keys, so `{ filter: undefined }` and `{}` are two cache
 * entries and two requests. The conditional spread below is therefore not a style choice, and it is
 * the kind of rule that is correct exactly as long as it exists once. Two copies of it in two
 * components is one copy away from a silent second request per render of the overview.
 *
 * All three members are optional, and absent is a documented state rather than a stub: the
 * API_Service applies the default view of 10.6 and 10.11, the default sorting of 10.7 and the first
 * page of 10.9 for a request that names none of them. `pageSize` is never sent by anyone —
 * `POSTING_PAGE_SIZE` in `apps/api/src/posting/posting-page-query.ts` is both the default and the
 * maximum of 10.9, so there is no second 25 in this bundle to drift from it.
 *
 * Requirements: 10.1, 10.5, 10.7, 10.9, 10.12, 10.13.
 */
export interface PostingPageSelection {
  /** The filter combination; absent means the default view (10.6, 10.11). */
  readonly filter?: JobPostingFilterInput;

  /** The sorting; absent means recording time descending (10.7). */
  readonly sort?: JobPostingSortInput;

  /** The page, counted from 1; absent means the first page (10.9). */
  readonly page?: number;
}

/** The selection as the variables of the `JobPostings` operation, with unset members omitted. */
export const postingPageVariablesOf = ({
  filter,
  sort,
  page,
}: PostingPageSelection): JobPostingsQueryVariables => ({
  ...(filter === undefined ? {} : { filter }),
  ...(sort === undefined ? {} : { sort }),
  ...(page === undefined ? {} : { page }),
});

/**
 * Reads one page of the posting overview.
 *
 * Every caller of the `JobPostings` operation goes through this hook, so every caller of it with
 * the same selection shares one cache entry and one request.
 */
export const usePostingPage = (selection: PostingPageSelection) =>
  useJobPostingsQuery({ variables: postingPageVariablesOf(selection) });
