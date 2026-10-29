import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/config.service';
import type { JobPosting } from '../prisma/prisma.types';
import { PostingRepository } from './posting.repository';
import type { FindPostingPageInput, PostingPage } from './posting-page-query';
import type { PostingReadContext } from './posting-read.context';

/** The part of the repository this service reads through. */
export type PostingPageReader = Pick<PostingRepository, 'findPage' | 'findById'>;

/** The part of the configuration this service reads: the Commute_Threshold in force (8.10). */
export type CommuteThresholdReader = Pick<AppConfigService, 'commuteThresholdMinutes'>;

/** The part of this service the read resolver calls. See `./posting-read.resolver.ts`. */
export type PostingReads = Pick<PostingReadService, 'page' | 'byId'>;

/** What the client asked for; the two context values are resolved by this service. */
export type PostingPageRequest = Pick<
  FindPostingPageInput,
  'filter' | 'sort' | 'page' | 'pageSize'
>;

/**
 * The read side of the posting overview: one request's worth of context plus one repository call
 * (8.10, 8.11, 10.1, 10.5, 10.6, 10.7, 10.9, 10.11, 11.2, 11.3).
 *
 * `FindPostingPageInput` needs two values the client does not send, and resolving them is what this
 * service is for:
 *
 * - **The Commute_Threshold in force (8.10).** Read from `AppConfigService` on every request, not
 *   captured once: the reachability filter of 8.11 is a comparison against configuration, so the
 *   same stored Job_Posting changes its reachability class when the user changes the threshold
 *   without anything being written.
 * - **The most recently completed Scrape_Run (11.2).** Read from the request's own context, which is
 *   where it is resolved once per request. Passing *that* value into the page read is the whole
 *   point of the detour: the default grouping of 11.3 and the `isNew` marking of its rows are
 *   derived from the same identifier, and two separate lookups could disagree — a page would then be
 *   grouped by one reference run and labelled by another.
 *
 * Everything else is the repository's: the conjunctive filters, the default view, the order and the
 * page window are pure functions in `./posting-page-query.ts` and are run against the Posting_Store
 * by `PostingRepository.findPage`. This service adds no filter and no sort of its own, so a client
 * cannot reach a reading of 10.5 that the property tests of tasks 15.5 to 15.7 do not cover.
 *
 * Requirements: 8.10, 8.11, 10.1, 10.5, 10.6, 10.7, 10.8, 10.9, 10.11, 11.2, 11.3.
 */
@Injectable()
export class PostingReadService {
  constructor(
    @Inject(PostingRepository) private readonly postings: PostingPageReader,
    @Inject(AppConfigService) private readonly config: CommuteThresholdReader,
  ) {}

  /**
   * One page of the posting overview (10.5, 10.7, 10.9, 11.3).
   *
   * @param request The filter, the sorting and the page the client asked for.
   * @param context The request's own context, which holds the reference run of 11.2.
   * @returns The page, with the entries, the total, the page count and the normalized page number.
   */
  async page(request: PostingPageRequest, context: PostingReadContext): Promise<PostingPage> {
    const latestCompletedRunId = await context.latestCompletedRunId();

    return this.postings.findPage({
      filter: request.filter,
      sort: request.sort,
      page: request.page,
      pageSize: request.pageSize,
      commuteThresholdMinutes: this.config.commuteThresholdMinutes,
      latestCompletedRunId,
    });
  }

  /**
   * One stored Job_Posting, or `null` where no Job_Posting carries that identifier (10.8, 10.15).
   *
   * No context value is needed: the detail view of 10.8 is about the columns of one row, and the
   * marking of 11.2 is resolved on the field rather than on the query — the same resolved field the
   * overview's rows use, against the same reference run of the same request.
   *
   * @param id The `JobPosting.id` the client asked for.
   */
  async byId(id: string): Promise<JobPosting | null> {
    return this.postings.findById(id);
  }
}
