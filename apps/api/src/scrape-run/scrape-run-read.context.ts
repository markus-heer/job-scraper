import { Inject, Injectable } from '@nestjs/common';
import DataLoader from 'dataloader';

import { RequestCache, type RequestKey } from '../graphql/request-cache';
import type { ScrapeRunPlatformResult } from '../prisma/prisma.types';
import { type ScrapeRunReader, ScrapeRunReadService } from './scrape-run-read.service';

/** The one read the `platformResults` edge makes. */
export type PlatformResultReader = Pick<ScrapeRunReader, 'platformResultsByRunIds'>;

/** What one request knows about the per-Platform results of the Scrape_Run it answers with. */
export interface ScrapeRunReadContext {
  /**
   * The result rows of one Scrape_Run, one per requested Platform (7.4).
   *
   * Batched across the runs of one request, so a run list of 20 entries costs one query for this
   * edge instead of 20.
   */
  platformResults(runId: string): Promise<readonly ScrapeRunPlatformResult[]>;
}

/**
 * The per-request state of a Scrape_Run read: the `platformResults` loader (7.4).
 *
 * The second of the two edges the design loads through DataLoader, and the same mechanism as
 * `../posting/posting-read.context.ts` — see `../graphql/request-cache.ts` for why the loader lives
 * for exactly one request.
 *
 * The batch is grouped rather than mapped one to one: a Scrape_Run has one result row per *requested*
 * Platform, so the loader answers each run with its own list and a run that requested no Platform
 * with an empty one. An empty list is a real answer here — a Scrape_Run that was cancelled before
 * its first Platform was asked has no result row — and not a missing value.
 */
@Injectable()
export class ScrapeRunReadContextFactory {
  private readonly contexts: RequestCache<ScrapeRunReadContext>;

  constructor(@Inject(ScrapeRunReadService) private readonly runs: PlatformResultReader) {
    this.contexts = new RequestCache<ScrapeRunReadContext>(() => this.createContext());
  }

  /**
   * The context of one request, created on its first field and reused by every following one.
   *
   * @param key The GraphQL context object of the request.
   */
  for(key: RequestKey): ScrapeRunReadContext {
    return this.contexts.for(key);
  }

  /** One request's state: one loader over the result rows of every Scrape_Run it was asked about. */
  private createContext(): ScrapeRunReadContext {
    const loader = new DataLoader<string, readonly ScrapeRunPlatformResult[]>(
      async (runIds: readonly string[]) => {
        const rows = await this.runs.platformResultsByRunIds(runIds);
        const byRunId = new Map<string, ScrapeRunPlatformResult[]>();

        for (const row of rows) {
          const existing = byRunId.get(row.runId);

          if (existing === undefined) {
            byRunId.set(row.runId, [row]);
          } else {
            existing.push(row);
          }
        }

        // In the order of the requested keys, which is the contract of a DataLoader batch function.
        // The Platform order inside each list is the one the read applied.
        return runIds.map((runId) => byRunId.get(runId) ?? []);
      },
    );

    return { platformResults: (runId) => loader.load(runId) };
  }
}
