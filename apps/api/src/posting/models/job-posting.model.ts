import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

import {
  CommuteModeEnumRef,
  CommutePrecisionEnumRef,
  InterestFlagEnumRef,
  PlatformEnumRef,
  PostingStatusEnumRef,
  RelevanceVerdictEnumRef,
} from '../../graphql/domain-enums';
import type {
  CommuteMode,
  CommutePrecision,
  InterestFlag,
  JobPosting,
  Platform,
  PostingStatus,
  RelevanceVerdict,
} from '../../prisma/prisma.types';

/** The columns of a stored Job_Posting that stay inside the API_Service. */
type InternalPostingColumn =
  'contentHash' | 'relevanceContentHash' | 'relevanceRank' | 'commuteLocationInput';

/**
 * One stored Job_Posting as the Web_App receives it (10.1 to 10.4, 10.15, 11.2, 15.15).
 *
 * `implements Omit<JobPosting, InternalPostingColumn>` is the load-bearing part of this declaration,
 * for the same reason it is on `LogMessageModel`: a persisted row is handed straight to GraphQL, and
 * this clause makes the compiler check that every field the schema promises exists on the row with
 * the type the schema claims. A renamed or retyped column in `schema.prisma` then fails
 * `pnpm check-types` here instead of turning into a `null` in the Web_App.
 *
 * Four columns are excluded on purpose rather than by oversight, and all four are mechanics the user
 * never sees:
 *
 * - `contentHash` and `relevanceContentHash` are the content hash gate of 15.5, 15.6 and 15.15. They
 *   decide whether an assessment is requested; they say nothing a reader of a posting could act on.
 * - `relevanceRank` is the denormalized sort key of 10.7. It exists because PostgreSQL cannot order
 *   the verdict enum the way 10.7 prescribes, so sorting happens in SQL and the client sorts nothing.
 *   Publishing it would invite a second, divergent ordering in the Web_App.
 * - `commuteLocationInput` is the work location value a stored commute result was computed from
 *   (8.5), kept so a later Scrape_Run can tell whether the location changed. The user reads
 *   `workLocation`.
 *
 * `relevanceSetManually` is published, because 10.3 asks the Web_App to show per Job_Posting whether
 * the Relevance_Verdict came from the Relevance_Service or from the user; this flag is that
 * distinction, and `setRelevanceVerdict` is what sets it (15.15).
 *
 * The resolved fields the design lists next to these columns — `isNew` from the comparison with the
 * most recently completed Scrape_Run (11.2, 11.4), `bestCommuteLabelDe` and the `firstSeenRun` edge —
 * are not columns and arrive with the read layer that owns them (tasks 15.2 and 15.3). This type is
 * the column surface they attach to.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.15, 11.2, 15.15.
 */
@ObjectType('JobPosting', {
  description: 'One job posting as the Job_Tool stored it.',
})
export class JobPostingModel implements Omit<JobPosting, InternalPostingColumn> {
  @Field(() => ID, { description: 'Identifier of the stored Job_Posting.' })
  id: string;

  @Field(() => PlatformEnumRef, { description: 'The Platform the Job_Posting was retrieved from.' })
  platform: Platform;

  @Field(() => String, {
    description:
      'The Posting_Id of the Job_Posting on its Platform; unique together with it (9.2).',
  })
  postingId: string;

  @Field(() => String, { description: 'Job title as the Platform showed it (6.3).' })
  title: string;

  @Field(() => String, {
    nullable: true,
    description: 'Employer, or null where the Platform named none (6.8).',
  })
  employer: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Work location as free text, or null where the Platform named none (6.8).',
  })
  workLocation: string | null;

  @Field(() => Date, {
    nullable: true,
    description: 'Publication date, or null where none was readable (6.4, 6.8, 6.9).',
  })
  publishedAt: Date | null;

  @Field(() => String, { description: 'Link to the advertisement on the Platform (10.8, 10.15).' })
  sourceUrl: string;

  @Field(() => String, {
    nullable: true,
    description:
      'Description text as the Platform showed it, or null where none was readable (6.8).',
  })
  descriptionText: string | null;

  @Field(() => Date, {
    description: 'When the Job_Posting was first recorded; the default sort key of 10.7 (11.1).',
  })
  firstSeenAt: Date;

  @Field(() => Date, {
    description: 'Start time of the Scrape_Run that last saw the posting (9.3).',
  })
  lastSeenAt: Date;

  @Field(() => ID, {
    description:
      'Identifier of the Scrape_Run that first recorded the Job_Posting; the "neu" marking of 11.2 is derived from it.',
  })
  firstSeenRunId: string;

  @Field(() => PostingStatusEnumRef, {
    description: 'Whether the Job_Posting is still listed on its Platform (9.5, 9.8, 10.4).',
  })
  postingStatus: PostingStatus;

  @Field(() => InterestFlagEnumRef, {
    description: "The user's marking, independent of the Posting_Status (10.10).",
  })
  interestFlag: InterestFlag;

  @Field(() => RelevanceVerdictEnumRef, {
    description: 'The Relevance_Verdict in force for this Job_Posting (15.1, 15.15).',
  })
  relevanceVerdict: RelevanceVerdict;

  @Field(() => String, {
    nullable: true,
    description:
      'German Relevance_Reason of at most 300 characters, or null where there is none (15.3).',
  })
  relevanceReason: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The AI model whose assessment is in force, or null where no model produced the verdict — which is the case for a manually set one (15.1, 15.15).',
  })
  relevanceModel: string | null;

  @Field(() => Date, {
    nullable: true,
    description:
      'When the assessment in force was made, or null where no assessment produced it (15.1).',
  })
  relevanceAssessedAt: Date | null;

  @Field(() => Boolean, {
    description:
      'True where the user set the Relevance_Verdict by hand. A manual verdict is retained in every following Scrape_Run in place of a service assessment (10.3, 15.15).',
  })
  relevanceSetManually: boolean;

  @Field(() => Int, {
    nullable: true,
    description: 'Commute time by bicycle in whole minutes, or null where it is unknown (8.2).',
  })
  bicycleMinutes: number | null;

  @Field(() => Int, {
    nullable: true,
    description:
      'Commute time by public transport in whole minutes, or null where it is unknown (8.2).',
  })
  transitMinutes: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'The Best_Commute_Time in whole minutes, or null where it is unknown (8.3, 8.13).',
  })
  bestCommuteMinutes: number | null;

  @Field(() => CommuteModeEnumRef, {
    nullable: true,
    description:
      'The means of transport of the Best_Commute_Time, or null where it is unknown (8.4).',
  })
  bestCommuteMode: CommuteMode | null;

  @Field(() => CommutePrecisionEnumRef, {
    description: 'How precisely the work location behind the commute result was resolved (8.12).',
  })
  commutePrecision: CommutePrecision;

  @Field(() => Date, {
    nullable: true,
    description: 'When the commute result was determined, or null where it never was (8.2).',
  })
  commuteCheckedAt: Date | null;
}
