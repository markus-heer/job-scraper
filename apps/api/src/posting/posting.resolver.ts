import type { InterestFlag, RelevanceVerdict } from '@job-scraper/domain';
import { Inject } from '@nestjs/common';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';

import { InterestFlagEnumRef, RelevanceVerdictEnumRef } from '../graphql/domain-enums';
import type { JobPosting } from '../prisma/prisma.types';
import { JobPostingModel } from './models/job-posting.model';
import { type PostingMutations, PostingService } from './posting.service';

/**
 * The two mutations the user performs on a stored Job_Posting: the Interest_Flag of 10.10 and the
 * manual Relevance_Verdict of 15.15.
 *
 * Thin by construction, like the run mutations: each method forwards to `PostingService` and returns
 * what it yields. The rules the mutations stand for — a manual verdict is marked as manual and is
 * therefore retained in every following Scrape_Run in place of a service assessment, a marking is
 * independent of the Posting_Status — are decisions about a stored Job_Posting, so they live in the
 * service and the repository behind it.
 *
 * Both answer with the updated Job_Posting rather than with a payload carrying a hint, which is what
 * the design's interface table pins for them. There is nothing for the user to act on in the success
 * case, and the Web_App confirms the stored value of 10.10 from the row it receives. A rejected
 * request reaches the client as a GraphQL error whose message is the German sentence the design's
 * table names: a Relevance_Reason beyond the stored length is answered with the sentence of 2.5 and
 * 15.3, a rejected Interest_Flag write with the one of 10.14 — and in neither case was anything
 * stored, so the Job_Posting keeps the marking and the verdict it had.
 *
 * `verdict` takes the full `RelevanceVerdict` enum, as the design's interface table declares. That
 * includes `NOT_ASSESSED`: a user who sets it pins the Job_Posting to "not assessed", because the
 * manual marking keeps the Relevance_Service away from it afterwards (15.15). That is a consequence
 * of the published schema, not of this resolver.
 *
 * Requirements: 10.3, 10.10, 10.14, 15.15.
 */
@Resolver(() => JobPostingModel)
export class PostingResolver {
  /**
   * The service is injected by its class token explicitly, as everywhere else in this application:
   * naming the token keeps the import a value import and the dependency visible, instead of making
   * the wiring depend on emitted decorator metadata that a type-only import would drop.
   */
  constructor(@Inject(PostingService) private readonly postings: PostingMutations) {}

  /** Sets or withdraws the Interest_Flag of one Job_Posting (10.10). */
  @Mutation(() => JobPostingModel, {
    name: 'setInterestFlag',
    description:
      'Sets the Interest_Flag of a Job_Posting. The Posting_Status stays unchanged; UNMARKED withdraws a marking. A Job_Posting marked NOT_INTERESTING is hidden in the default view and stays displayable through the marking filter.',
  })
  setInterestFlag(
    @Args('id', { type: () => ID, description: 'Identifier of the Job_Posting.' })
    id: string,
    @Args('flag', {
      type: () => InterestFlagEnumRef,
      description: 'The Interest_Flag to store for this Job_Posting.',
    })
    flag: InterestFlag,
  ): Promise<JobPosting> {
    return this.postings.setInterestFlag(id, flag);
  }

  /** Sets the Relevance_Verdict of one Job_Posting manually and marks it as such (15.15). */
  @Mutation(() => JobPostingModel, {
    name: 'setRelevanceVerdict',
    description:
      'Sets the Relevance_Verdict of a Job_Posting manually. The verdict is marked as set manually and is retained in every following Scrape_Run in place of an assessment by the Relevance_Service.',
  })
  setRelevanceVerdict(
    @Args('id', { type: () => ID, description: 'Identifier of the Job_Posting.' })
    id: string,
    @Args('verdict', {
      type: () => RelevanceVerdictEnumRef,
      description: 'The Relevance_Verdict to store for this Job_Posting.',
    })
    verdict: RelevanceVerdict,
    @Args('reasonDe', {
      type: () => String,
      nullable: true,
      description:
        'German reason for the manual verdict, at most 300 characters. Omitted, null or empty stores no reason.',
    })
    reasonDe?: string | null,
  ): Promise<JobPosting> {
    return this.postings.setRelevanceVerdictManually(id, verdict, reasonDe ?? null);
  }
}
