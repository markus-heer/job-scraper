import type { JobPostingsQuery } from './job-postings.generated';

/**
 * One Job_Posting as the posting overview receives it.
 *
 * Derived from the generated result type of `job-postings.graphql` rather than written out, so a
 * field added to or removed from that operation moves through the row and the three badges as a
 * `pnpm check-types` failure. Writing the shape by hand would make it possible for a component to
 * read a field the operation does not select — which arrives as `undefined` at runtime and type-
 * checks fine.
 *
 * It lives in its own module rather than next to `PostingList` so that `PostingRow` and the badges
 * can import it without importing the component that renders them.
 */
export type PostingListItem = JobPostingsQuery['jobPostings']['items'][number];
