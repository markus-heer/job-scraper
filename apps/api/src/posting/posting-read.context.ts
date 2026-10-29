import { Inject, Injectable } from '@nestjs/common';
import DataLoader from 'dataloader';

import { RequestCache, type RequestKey } from '../graphql/request-cache';
import type { ScrapeRun } from '../prisma/prisma.types';
import {
  type LatestCompletedRunReader,
  type ScrapeRunReader,
  ScrapeRunReadService,
} from '../scrape-run/scrape-run-read.service';

/** The two Scrape_Run reads one posting request makes; see {@link PostingReadContextFactory}. */
export type PostingReadRuns = LatestCompletedRunReader & Pick<ScrapeRunReader, 'runsByIds'>;

/**
 * What one request of the posting overview knows about Scrape_Run.
 *
 * Both members are promises that are resolved once per request, never once per row — see
 * `../graphql/request-cache.ts` for why that distinction is load-bearing rather than an
 * optimization.
 */
export interface PostingReadContext {
  /**
   * The identifier the marking "neu" is compared against, or `null` where nothing is marked (11.2,
   * 11.6).
   *
   * The same value for every Job_Posting of the request: the one a page's grouping was read with and
   * the one its rows are marked against.
   */
  latestCompletedRunId(): Promise<string | null>;
  /**
   * The Scrape_Run that first recorded one Job_Posting, or `null` where it is no longer stored
   * (11.1).
   *
   * Batched across the rows of a page, so a page of 25 postings costs one query for this edge.
   */
  firstSeenRun(runId: string): Promise<ScrapeRun | null>;
}

/**
 * The per-request state of a posting read: the reference run and the `firstSeenRun` loader.
 *
 * A singleton that hands out one {@link PostingReadContext} per GraphQL request, keyed on the
 * request's context object. The resolver looks it up and passes it on; nothing here is stored
 * between requests, which is what 11.4 asks for — the marking moves to the next completed
 * Scrape_Run "on the next build of the posting overview", so each request asks again.
 *
 * The memoized promise rather than the memoized value is what guarantees the single query: the field
 * resolvers of 25 rows run before any of them has awaited anything, so caching only the resolved
 * value would issue 25 identical selections before the first answer arrived.
 *
 * Requirements: 11.1, 11.2, 11.4, 11.6.
 */
@Injectable()
export class PostingReadContextFactory {
  private readonly contexts: RequestCache<PostingReadContext>;

  constructor(@Inject(ScrapeRunReadService) private readonly runs: PostingReadRuns) {
    this.contexts = new RequestCache<PostingReadContext>(() => this.createContext());
  }

  /**
   * The context of one request, created on its first field and reused by every following one.
   *
   * @param key The GraphQL context object of the request.
   */
  for(key: RequestKey): PostingReadContext {
    return this.contexts.for(key);
  }

  /** One request's state: one pending selection and one loader. */
  private createContext(): PostingReadContext {
    let pendingLatestCompletedRunId: Promise<string | null> | null = null;

    const firstSeenRunLoader = new DataLoader<string, ScrapeRun | null>(
      async (runIds: readonly string[]) => {
        const rows = await this.runs.runsByIds(runIds);
        const byId = new Map(rows.map((row) => [row.id, row]));

        // In the order of the requested keys, which is the contract of a DataLoader batch function:
        // a Scrape_Run the Posting_Store no longer holds is answered with null rather than with a
        // rejection, because `firstSeenRunId` is a restricted foreign key and its absence would be a
        // broken store, not a failed request.
        return runIds.map((runId) => byId.get(runId) ?? null);
      },
      {
        // The identifiers are strings, so the default cache key is already the identity.
        cache: true,
      },
    );

    return {
      latestCompletedRunId: () => {
        pendingLatestCompletedRunId ??= this.runs.latestCompletedRunId();

        return pendingLatestCompletedRunId;
      },
      firstSeenRun: (runId) => firstSeenRunLoader.load(runId),
    };
  }
}
