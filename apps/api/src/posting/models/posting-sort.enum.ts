import { registerEnumType } from '@nestjs/graphql';

import { toEnumRef } from '../../graphql/domain-enums';
import type { PostingSort, PostingSortField } from '../posting-page-query';

/** The four sort keys of 10.7, as the tuple the GraphQL enum is registered from. */
export const POSTING_SORT_FIELDS = [
  'FIRST_SEEN_AT',
  'PUBLISHED_AT',
  'BEST_COMMUTE_MINUTES',
  'RELEVANCE',
] as const satisfies readonly PostingSortField[];

/** Both directions 10.7 offers for each sort key. */
export const SORT_DIRECTIONS = [
  'ASC',
  'DESC',
] as const satisfies readonly PostingSort['direction'][];

/**
 * The sort keys and the two directions of 10.7, as GraphQL enums.
 *
 * The two tuples above are the published value lists and the `satisfies` clauses are what ties them
 * to the read contract in `../posting-page-query.ts`: that module declares `PostingSortField` as a
 * union rather than as a tuple, so a key added there without being added here — or a key published
 * here that the repository cannot sort by — fails `pnpm check-types` instead of reaching the Web_App
 * as an unusable schema value.
 *
 * `satisfies readonly PostingSortField[]` catches the second direction only; it cannot catch a
 * *missing* key, which is what the exhaustiveness assertion in the test next to this file is for.
 *
 * Requirements: 10.7.
 */
export const PostingSortFieldEnumRef = toEnumRef(POSTING_SORT_FIELDS);

/** The direction of one sort key (10.7). */
export const SortDirectionEnumRef = toEnumRef(SORT_DIRECTIONS);

registerEnumType(PostingSortFieldEnumRef, {
  name: 'JobPostingSortField',
  description: 'The property the posting overview is sorted by.',
});

registerEnumType(SortDirectionEnumRef, {
  name: 'SortDirection',
  description: 'Ascending or descending.',
});
