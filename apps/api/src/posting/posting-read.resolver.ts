import { Inject } from '@nestjs/common';
import { Args, Context, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import type { RequestKey } from '../graphql/request-cache';
import type { JobPosting, ScrapeRun } from '../prisma/prisma.types';
import { ScrapeRunModel } from '../scrape-run/models/scrape-run.model';
import { bestCommuteLabelDe } from './best-commute-label';
import { JobPostingModel } from './models/job-posting.model';
import { JobPostingFilterInput } from './models/job-posting-filter.input';
import { JobPostingPageModel } from './models/job-posting-page.model';
import { JobPostingSortInput } from './models/job-posting-sort.input';
import { isNewPosting } from './new-marking';
import { POSTING_PAGE_SIZE, type PostingPage } from './posting-page-query';
import { PostingReadContextFactory } from './posting-read.context';
import { type PostingReads, PostingReadService } from './posting-read.service';
import { postingFilterOf, postingSortOf } from './posting-read-input';

/**
 * The read half of the posting overview: two queries and three resolved fields (10.1 to 10.9, 11.2).
 *
 * Thin like every other resolver here — the filters, the order and the page window live in
 * `./posting-page-query.ts` and are run by the repository, and the two context values one read needs
 * are resolved by `PostingReadService`. What this class adds is the published shape of a request and
 * the three fields of a Job_Posting that are not columns:
 *
 * - **`isNew` (11.2).** One comparison against the most recently completed Scrape_Run. The
 *   identifier comes from the request's own context, so every row of a page is marked against the
 *   same run the page was *grouped* by (11.3) — see `./posting-read.context.ts` for why that is
 *   resolved once per request and never per row.
 * - **`bestCommuteLabelDe` (8.4, 8.13, 10.1).** The German line a Job_Posting shows in place of its
 *   two commute columns, including the "unbekannt" of 10.1.
 * - **`firstSeenRun` (11.1).** The edge to the Scrape_Run that recorded the posting first, batched
 *   through DataLoader: one query per page rather than one per row.
 *
 * A second `@Resolver(() => JobPostingModel)` next to `./posting.resolver.ts`, deliberately. That
 * class carries the mutations of a Job_Posting and this one its reads; Nest merges the fields both
 * declare for the same object type, so the two concerns stay in two files without the schema
 * noticing.
 *
 * The three resolved fields are non-nullable, which is what lets the Web_App render a row without a
 * branch per field: `isNew` is a comparison that always answers, the commute label always has a
 * value — "Erreichbarkeit unbekannt" is one — and `firstSeenRun` is a restricted foreign key, so a
 * stored Job_Posting always has one. A `firstSeenRunId` whose Scrape_Run is gone would be a broken
 * Posting_Store and is reported as a failure of the field rather than as a null the Web_App would
 * have to explain.
 *
 * Requirements: 8.4, 8.13, 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8, 10.9, 10.11, 10.15, 11.1,
 * 11.2, 11.3.
 */
@Resolver(() => JobPostingModel)
export class PostingReadResolver {
  /**
   * Both dependencies are injected by their class token explicitly, as everywhere else in this
   * application: naming the token keeps the import a value import and the dependency visible,
   * instead of making the wiring depend on emitted decorator metadata that a type-only import would
   * drop.
   */
  constructor(
    @Inject(PostingReadService) private readonly reads: PostingReads,
    @Inject(PostingReadContextFactory) private readonly contexts: PostingReadContextFactory,
  ) {}

  /**
   * One page of the posting overview (10.5, 10.6, 10.7, 10.9, 10.11, 11.3).
   *
   * All four arguments are optional, because opening the overview sends none of them: the first page
   * of the default view, in the default order, with the page size of 10.9. The page size carries its
   * cap in the description rather than in a validator — `postingPageWindowOf` normalizes a larger
   * request to 25, which is both the default and the maximum that requirement names.
   */
  @Query(() => JobPostingPageModel, {
    name: 'jobPostings',
    description:
      'One page of the stored Job_Posting, filtered and sorted. Without arguments this is the first page of the default view: "not relevant" and "not interesting" postings hidden, newest first recording first, and the Job_Posting of the most recently completed Scrape_Run above the rest.',
  })
  jobPostings(
    @Context() context: RequestKey,
    @Args('filter', {
      type: () => JobPostingFilterInput,
      nullable: true,
      description: 'The filters of the overview; omitted applies the default view.',
    })
    filter?: JobPostingFilterInput | null,
    @Args('sort', {
      type: () => JobPostingSortInput,
      nullable: true,
      description: 'The sorting; omitted sorts by the recording time descending.',
    })
    sort?: JobPostingSortInput | null,
    @Args('page', {
      type: () => Int,
      nullable: true,
      defaultValue: 1,
      description: 'The page to read, counted from 1. A value below 1 is served as page 1.',
    })
    page?: number | null,
    @Args('pageSize', {
      type: () => Int,
      nullable: true,
      defaultValue: POSTING_PAGE_SIZE,
      description: 'Entries per page. At most 25, which is also the default.',
    })
    pageSize?: number | null,
  ): Promise<PostingPage> {
    return this.reads.page(
      {
        filter: postingFilterOf(filter),
        sort: postingSortOf(sort),
        page: page ?? 1,
        pageSize: pageSize ?? POSTING_PAGE_SIZE,
      },
      this.contexts.for(context),
    );
  }

  /**
   * One stored Job_Posting for the detail view, or `null` where none carries the identifier (10.8,
   * 10.15).
   *
   * Nullable rather than throwing: a stale link from a bookmark or from a reloaded overview is a
   * state the Web_App can render, and the German hint for it is one of the texts it owns.
   */
  @Query(() => JobPostingModel, {
    name: 'jobPosting',
    nullable: true,
    description:
      'One stored Job_Posting with its complete description text and the link to the advertisement. Null where no Job_Posting carries that identifier.',
  })
  jobPosting(
    @Args('id', { type: () => ID, description: 'Identifier of the Job_Posting.' })
    id: string,
  ): Promise<JobPosting | null> {
    return this.reads.byId(id);
  }

  /** Whether this Job_Posting carries the marking "neu" (11.2, 11.4, 11.6, 11.7). */
  @ResolveField(() => Boolean, {
    name: 'isNew',
    description:
      'True where this Job_Posting was recorded for the first time in the most recently completed Scrape_Run. False for every other Job_Posting, and for every Job_Posting while no Scrape_Run has reached the Run_Outcome "completed".',
  })
  async isNew(@Parent() posting: JobPosting, @Context() context: RequestKey): Promise<boolean> {
    const latestCompletedRunId = await this.contexts.for(context).latestCompletedRunId();

    return isNewPosting(posting, latestCompletedRunId);
  }

  /** The German line that states the Best_Commute_Time of this Job_Posting (8.4, 8.13, 10.1). */
  @ResolveField(() => String, {
    name: 'bestCommuteLabelDe',
    description:
      'The Best_Commute_Time as German text: the whole number of minutes with its mode of transport, or "Erreichbarkeit unbekannt" where there is none.',
  })
  bestCommuteLabelDe(@Parent() posting: JobPosting): string {
    return bestCommuteLabelDe(posting);
  }

  /** The Scrape_Run that recorded this Job_Posting for the first time (11.1). */
  @ResolveField(() => ScrapeRunModel, {
    name: 'firstSeenRun',
    description: 'The Scrape_Run this Job_Posting was recorded in for the first time.',
  })
  async firstSeenRun(
    @Parent() posting: JobPosting,
    @Context() context: RequestKey,
  ): Promise<ScrapeRun> {
    const run = await this.contexts.for(context).firstSeenRun(posting.firstSeenRunId);

    if (run === null) {
      // Unreachable while the foreign key is `onDelete: Restrict`: no Scrape_Run can be deleted
      // while a Job_Posting references it. Reported rather than answered with a fabricated run,
      // because every value such a stand-in carried would be a claim about a Scrape_Run that is not
      // stored.
      throw new Error(
        `Job_Posting ${posting.id} references Scrape_Run ${posting.firstSeenRunId}, which is not stored.`,
      );
    }

    return run;
  }
}
