import { Field, InputType } from '@nestjs/graphql';

import {
  InterestFlagEnumRef,
  PlatformEnumRef,
  PostingStatusEnumRef,
  RelevanceVerdictEnumRef,
} from '../../graphql/domain-enums';
import type {
  InterestFlag,
  Platform,
  PostingStatus,
  RelevanceVerdict,
} from '../../prisma/prisma.types';
import type { Reachability } from '../posting-page-query';
import { ReachabilityEnumRef } from './reachability.enum';

/**
 * The six filters of 10.5 as the Web_App sends them.
 *
 * Every member is nullable and every list member means "include these values": an omitted member is
 * the filter the user did not set, which `postingWhereOf` in `../posting-page-query.ts` reads as
 * "every Platform" for the Platform filter and as the default view of 10.6 and 10.11 for the two
 * filters that have one.
 *
 * The "all" value 10.5 names for the marking filter and for the Relevance_Verdict filter is not an
 * enum member here, and that is the one place where this input deviates from the literal wording of
 * the requirement. "All" is the complete value list, so a client that wants it sends it: every
 * Interest_Flag, or every Relevance_Verdict. Publishing an additional `ALL` member would make the
 * enums disagree with the stored columns they filter and would put a value into the schema that no
 * Job_Posting can carry; the Web_App's "Alle" option maps onto the full list instead. The default
 * view is what an *omitted* filter means, which is why the two cases have to stay distinguishable.
 *
 * Why this class does not implement `PostingFilter`: a nullable GraphQL field arrives as `null` when
 * the client sends it explicitly and as `undefined` when it omits the member, while `PostingFilter`
 * admits `undefined` only. `postingFilterOf` in `../posting-read-input.ts` collapses the two, which
 * is the one translation between the published input and the read contract.
 *
 * Requirements: 8.11, 10.5, 10.6, 10.11.
 */
@InputType('JobPostingFilterInput', {
  description:
    'Filters of the posting overview. Several set filters have to be met simultaneously. An omitted filter is not set; the marking and the Relevance_Verdict filter then apply the default view, which hides "not interesting" and "not relevant" postings.',
})
export class JobPostingFilterInput {
  @Field(() => [PlatformEnumRef], {
    nullable: true,
    description: 'The Platform to include. Omitted or empty includes every Platform.',
  })
  platforms?: readonly Platform[] | null;

  @Field(() => [ReachabilityEnumRef], {
    nullable: true,
    description:
      'The reachability classes to include, read against the configured Commute_Threshold. Selecting "WELL_REACHABLE" alone hides every Job_Posting whose Best_Commute_Time is unknown (8.11).',
  })
  reachability?: readonly Reachability[] | null;

  @Field(() => [PostingStatusEnumRef], {
    nullable: true,
    description: 'The Posting_Status to include. Independent of the two filters below.',
  })
  postingStatuses?: readonly PostingStatus[] | null;

  @Field(() => [InterestFlagEnumRef], {
    nullable: true,
    description:
      'The Interest_Flag to include. Omitted hides Job_Posting marked "not interesting"; send both values for the "all" option of 10.5.',
  })
  interestFlags?: readonly InterestFlag[] | null;

  @Field(() => [RelevanceVerdictEnumRef], {
    nullable: true,
    description:
      'The Relevance_Verdict to include. Omitted hides Job_Posting with the verdict "not relevant"; send every value for the "all" option of 10.5.',
  })
  relevanceVerdicts?: readonly RelevanceVerdict[] | null;

  @Field(() => Date, {
    nullable: true,
    description: 'Start of the recording period, inclusive.',
  })
  firstSeenFrom?: Date | null;

  @Field(() => Date, {
    nullable: true,
    description: 'End of the recording period, inclusive.',
  })
  firstSeenTo?: Date | null;
}
