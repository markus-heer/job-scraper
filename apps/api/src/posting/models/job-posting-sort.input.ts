import { Field, InputType } from '@nestjs/graphql';

import type { PostingSort, PostingSortField } from '../posting-page-query';
import { PostingSortFieldEnumRef, SortDirectionEnumRef } from './posting-sort.enum';

/**
 * One sort key with its direction (10.7).
 *
 * `implements PostingSort` is the load-bearing part of this declaration: both members are
 * non-nullable with a default, so the input the client sends is already the read contract and the
 * repository receives it unchanged. The defaults are `DEFAULT_POSTING_SORT` — recording time
 * descending, the sorting in force when the user chose none — and they are declared here as well as
 * there so the Web_App's generated types show the order it gets without sending arguments.
 *
 * Requirements: 10.7.
 */
@InputType('JobPostingSortInput', {
  description:
    'Sorting of the posting overview. Defaults to the recording time descending, which is also the order the default grouping of 11.3 sorts within its two groups.',
})
export class JobPostingSortInput implements PostingSort {
  @Field(() => PostingSortFieldEnumRef, {
    defaultValue: 'FIRST_SEEN_AT',
    description: 'The property to sort by.',
  })
  field: PostingSortField;

  @Field(() => SortDirectionEnumRef, {
    defaultValue: 'DESC',
    description:
      'The direction. Job_Posting whose Best_Commute_Time or publication date is unknown are placed at the end of the list in both directions.',
  })
  direction: 'ASC' | 'DESC';
}
