import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { JobPosting } from '../../prisma/prisma.types';
import type { PostingPage } from '../posting-page-query';
import { JobPostingModel } from './job-posting.model';

/**
 * One page of the posting overview (10.9).
 *
 * `implements PostingPage` is the load-bearing part of this declaration: the page is assembled by
 * `PostingRepository.findPage` and this class only publishes it, so a member added or retyped on the
 * read contract fails `pnpm check-types` here instead of going missing from the schema. That is also
 * why `items` is typed as the stored `JobPosting` while the GraphQL field names `JobPostingModel` —
 * the published value *is* the stored row, and `JobPostingModel` is the declaration of which of its
 * columns the Web_App gets to see.
 *
 * Three numbers next to the entries, and each answers a different question of 10.9: `totalCount` how
 * many Job_Posting the filter matched across every page, `pageCount` how many pages those fill, and
 * `page` which page these entries are from — after normalization, so a page number below 1 is
 * reported as the 1 it was served as.
 *
 * `pageCount` is 0 for an empty result rather than 1. An empty list has no page to navigate to, and
 * the two empty states of 10.12 and 10.13 are what the Web_App shows in its place; a client that
 * wants to print "Seite 1 von 1" does that where the German text lives.
 *
 * Requirements: 10.9, 10.12, 10.13.
 */
@ObjectType('JobPostingPage', {
  description: 'One page of the posting overview, at most 25 entries.',
})
export class JobPostingPageModel implements PostingPage {
  @Field(() => [JobPostingModel], {
    description: 'The Job_Posting of this page, filtered, sorted and cut to the page size.',
  })
  items: readonly JobPosting[];

  @Field(() => Int, {
    description: 'How many Job_Posting the filter matched in total, across every page.',
  })
  totalCount: number;

  @Field(() => Int, {
    description:
      'How many pages those entries fill. 0 for an empty result, which has no page to navigate to.',
  })
  pageCount: number;

  @Field(() => Int, {
    description:
      'The page these entries are from, counted from 1. A requested page below 1 is served and reported as page 1; a page above the last one is a real empty page and is reported as requested.',
  })
  page: number;
}
