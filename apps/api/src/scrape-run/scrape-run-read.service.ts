import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { RunOutcome, ScrapeRun, ScrapeRunPlatformResult } from '../prisma/prisma.types';

/**
 * The part of the Posting_Store client this service reads from.
 *
 * Three delegates, one per number the answers below are assembled from: the `ScrapeRun` row of the
 * most recently completed Scrape_Run, the per-Platform result rows that run's counters are summed
 * from, and the store-wide tally of stored Job_Posting. Narrowed like every other dependency in this
 * application, so the selection rule — which run counts as "completed", which row wins a tie — can
 * be driven in a unit test against in-memory delegates. `PrismaService` is imported as a value
 * because it is also the injection token.
 *
 * The `JobPosting` delegate is read here rather than through `PostingRepository`, as the two
 * enrichment stages read their candidates directly as well. The repository owns the *write* rules of
 * a Job_Posting — the field groups of 9.3, the gated sweep of 9.5 — and a `count()` over the whole
 * table neither reads a row nor can break one. Putting a counter of 11.5 in that file would also put
 * a statement about a Scrape_Run in the one file whose subject is a single posting's lifecycle.
 */
export type ScrapeRunReadStore = Pick<
  PrismaService,
  'jobPosting' | 'scrapeRun' | 'scrapeRunPlatformResult'
>;

/**
 * The most recently completed Scrape_Run, with the end time it is selected by.
 *
 * A narrowed `ScrapeRun`: `finishedAt` is non-nullable here, because a run without an end time is
 * not a finished one and is excluded by the query. `runOutcome` is kept at the full `RunOutcome`
 * although it is always `COMPLETED` by construction, so the Web_App renders it through the same
 * label table as every other Run_Outcome instead of special-casing this one operation.
 */
export interface CompletedScrapeRun {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly runOutcome: RunOutcome;
}

/**
 * What the posting overview states about the most recently completed Scrape_Run (11.5).
 *
 * Published by `ScrapeRunSummaryModel` as the answer to `latestScrapeRun`. `null` instead of this
 * shape is the case of 11.6: no Scrape_Run has ever reached the Run_Outcome "completed", so there
 * are no values to state and the Web_App shows its German hint instead.
 */
export interface ScrapeRunSummary extends CompletedScrapeRun {
  /** Job_Posting recorded for the first time in this Scrape_Run. */
  readonly newPostings: number;
  /** Job_Posting that were already stored and were sighted again in this Scrape_Run. */
  readonly resightedPostings: number;
  /** Job_Posting the Posting_Store holds in total, across every Scrape_Run and every Platform. */
  readonly totalPostings: number;
}

/**
 * How many Scrape_Run the run list answers with when the client names no limit.
 *
 * The design fixes 20 for the `scrapeRuns` query. The requirements name no number for the run list —
 * it is the Log_View's way back into an earlier run (12.9) — so the default is the design's and the
 * cap below is what keeps a client from reading the whole table in one request.
 */
export const SCRAPE_RUN_LIST_DEFAULT_LIMIT = 20;

/** The largest run list one request is served, whatever it asks for. */
export const SCRAPE_RUN_LIST_MAX_LIMIT = 100;

/** The part of this service the posting read layer calls: the compared identifier of 11.2. */
export type LatestCompletedRunReader = Pick<ScrapeRunReadService, 'latestCompletedRunId'>;

/** The part of this service the `latestScrapeRun` query calls (11.5, 11.6). */
export type LatestScrapeRunQuery = Pick<ScrapeRunReadService, 'latestScrapeRunSummary'>;

/** The part of this service the run list, the active run and the two edges of the read layer call. */
export type ScrapeRunReader = Pick<
  ScrapeRunReadService,
  'recentRuns' | 'activeRun' | 'runsByIds' | 'platformResultsByRunIds'
>;

/** The part of this service the four queries of the read resolver call (11.5, 11.6, 12.5, 12.9). */
export type ScrapeRunReadQueries = Pick<
  ScrapeRunReadService,
  'recentRuns' | 'activeRun' | 'runById' | 'latestScrapeRunSummary'
>;

/** The requested run list size as this service serves it: at least 1, at most the cap. */
const listLimitOf = (limit: number | null | undefined): number =>
  limit === null || limit === undefined || !Number.isFinite(limit)
    ? SCRAPE_RUN_LIST_DEFAULT_LIMIT
    : Math.min(SCRAPE_RUN_LIST_MAX_LIMIT, Math.max(1, Math.trunc(limit)));

/** `_sum` over an empty set of rows is null; a Scrape_Run without result rows counted nothing. */
const sumOrZero = (sum: number | null | undefined): number => sum ?? 0;

/**
 * The stored row as the narrowed {@link CompletedScrapeRun}.
 *
 * The two fallbacks the shape needs are made here, in one place, and both are guaranteed away by the
 * query's filter: `runOutcome = COMPLETED` and a non-null `finishedAt`. They are unreachable and
 * exist because a Prisma row type cannot express "this column is non-null under this filter";
 * neither of them invents a value — the end time falls back to the start time, which is the earliest
 * instant the run can possibly have ended at.
 */
const completedRunOf = (run: ScrapeRun): CompletedScrapeRun => ({
  id: run.id,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt ?? run.startedAt,
  runOutcome: run.runOutcome ?? 'COMPLETED',
});

/**
 * The read side of a Scrape_Run that the posting overview is built on (11.2, 11.4, 11.5, 11.6).
 *
 * The first two questions are about the *most recently completed* Scrape_Run — the run
 * 11.2 calls the reference for the marking "neu" and 11.5 asks the counters of. "Completed" is
 * narrow on purpose and is the whole selection rule: `runOutcome = COMPLETED`, which the glossary's
 * closed list leaves exactly one meaning. A Scrape_Run the user cancelled, one the 30-minute limit
 * of 13.6 ended and one the stale-run recovery closed after a crash all carry a different
 * Run_Outcome and are therefore invisible here, which is 11.7 — the marking and the counters stay
 * where the last run that actually got through left them. The recovery exists in that exact shape
 * for this reason: it closes a crashed run with `CANCELLED_BY_TIME_LIMIT` and `closedByRecovery`
 * rather than with `COMPLETED`, so a restart cannot move the marking.
 *
 * Nothing is cached. 11.4 asks for the marking and the values to move to the next completed
 * Scrape_Run "on the next build of the posting overview", so each read of the overview asks again;
 * a cached identifier would be exactly the stale answer that acceptance criterion forbids. Both
 * queries are indexed — `@@index([runOutcome, finishedAt(sort: Desc)])` serves the selection and
 * `@@unique([runId, platform])` the counters — so asking again costs a lookup, not a scan.
 *
 * The counters of 11.5 are read from stored rows rather than recomputed: the first-recorded and
 * sighted-again numbers are summed over the `ScrapeRunPlatformResult` rows of that run, which both
 * the Scraper_Service and `ScrapeRunService` upsert on `(runId, platform)`, and the total is a
 * `count` over `JobPosting`. "Sighted again" is the complement of "recorded for the first time" as
 * `UpsertResult.created` defines it — an upsert that matched an existing record. The requirements
 * never define the term, so the definition is pinned in the design document, in
 * `../posting/posting.repository.ts` and here.
 *
 * A rejected read is not contained. Every method here answers a GraphQL query of the Web_App, so a
 * Posting_Store that cannot be read is a failure of that request and not something to report as
 * "no Scrape_Run has completed yet" — which is a statement about stored data and would send the
 * user to start a run that has in fact already run.
 *
 * The four reads below the summary are the rest of what the read layer asks about a Scrape_Run and
 * are not about the reference run at all: the run list of the Web_App, the Scrape_Run that is
 * running right now, and the two batched edges the design loads with DataLoader —
 * `JobPosting.firstSeenRun` and `ScrapeRun.platformResults`. They live here for the same reason the
 * selection does: a statement about a Scrape_Run is one query against the `ScrapeRun` table, and the
 * posting repository is the file whose subject is a single Job_Posting's lifecycle.
 *
 * Requirements: 11.2, 11.4, 11.5, 11.6, 11.7.
 */
@Injectable()
export class ScrapeRunReadService {
  constructor(@Inject(PrismaService) private readonly prisma: ScrapeRunReadStore) {}

  /**
   * The most recently completed Scrape_Run, or `null` where the Posting_Store holds none (11.2,
   * 11.6).
   *
   * "Most recently" is by end time, as 11.2 words it, and the two further sort keys make the answer
   * a total order rather than a near-total one: two runs can carry the same `finishedAt` — the
   * column has millisecond precision — and a tie decided by the Posting_Store's row order would
   * make the marking of 11.2 depend on the query plan. The later start time wins such a tie, and the
   * identifier settles the remaining case.
   */
  async latestCompletedRun(): Promise<CompletedScrapeRun | null> {
    const run = await this.prisma.scrapeRun.findFirst({
      where: {
        status: 'FINISHED',
        runOutcome: 'COMPLETED',

        // A completed run always carries an end time: `ScrapeRunCoordinator` writes the status, the
        // end time and the Run_Outcome in one update. The term is in the filter because the
        // ordering below is only well defined over non-null values — in PostgreSQL a descending
        // sort puts nulls first, so a row that somehow lacked an end time would win every
        // comparison instead of being ignored.
        finishedAt: { not: null },
      },
      orderBy: [{ finishedAt: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
    });

    return run === null ? null : completedRunOf(run);
  }

  /**
   * The identifier the marking "neu" is compared against, or `null` where nothing is marked (11.2,
   * 11.6).
   *
   * The one value the posting read layer needs from this service: `isNewPosting` in
   * `../posting/new-marking.ts` turns it into the marking, and `newFirstGroups` into the default
   * grouping of 11.3.
   */
  async latestCompletedRunId(): Promise<string | null> {
    const run = await this.latestCompletedRun();

    return run?.id ?? null;
  }

  /**
   * Start time, end time, Run_Outcome and the three counts of the most recently completed
   * Scrape_Run (11.5), or `null` where none has completed (11.6).
   *
   * The counters are read after the run has been selected rather than in one joined statement,
   * because there is nothing to join for the total: it is a tally of the whole `JobPosting` table
   * and not of that run's rows. The two reads that remain are issued together, so the answer costs
   * one round trip more than the selection and not three.
   *
   * The three numbers can disagree with each other by a Scrape_Run that is running while this query
   * is answered: the total counts the postings that run has already stored, while the per-run
   * counters belong to the completed one. That is what 11.5 describes — two of the numbers are about
   * a Scrape_Run and the third is about the Posting_Store — and not a consistency gap to close here.
   */
  async latestScrapeRunSummary(): Promise<ScrapeRunSummary | null> {
    const run = await this.latestCompletedRun();

    if (run === null) {
      return null;
    }

    const [counters, totalPostings] = await Promise.all([
      this.prisma.scrapeRunPlatformResult.aggregate({
        where: { runId: run.id },
        _sum: { newPostings: true, updatedPostings: true },
      }),
      this.prisma.jobPosting.count(),
    ]);

    return {
      ...run,

      // A completed Scrape_Run without a single result row is possible — every Platform is
      // deactivated, or every row was refused — and counted nothing, which is what the fallback
      // states. `_sum` over no rows is null, not 0.
      newPostings: sumOrZero(counters._sum.newPostings),
      resightedPostings: sumOrZero(counters._sum.updatedPostings),
      totalPostings,
    };
  }

  /**
   * The most recent Scrape_Run, newest first, for the run list of the Web_App (12.9).
   *
   * By start time rather than by end time, because a running Scrape_Run has no end time and belongs
   * at the top of that list: it is the run the Log_View would be opened on. The identifier breaks a
   * tie, so the order is total and two runs started in the same millisecond cannot swap places
   * between two requests.
   *
   * Unfiltered by status and by Run_Outcome: every stored Scrape_Run is one the user may want the
   * Log_Stream of, including the cancelled ones and the ones a restart closed.
   *
   * @param limit How many runs to return; normalized to 1 … {@link SCRAPE_RUN_LIST_MAX_LIMIT}, with
   *   {@link SCRAPE_RUN_LIST_DEFAULT_LIMIT} for an absent value.
   */
  async recentRuns(limit?: number | null): Promise<readonly ScrapeRun[]> {
    return this.prisma.scrapeRun.findMany({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: listLimitOf(limit),
    });
  }

  /**
   * The Scrape_Run that is currently running, or `null` where none is (12.1, 12.5).
   *
   * Read from the stored row and not from the coordinator, although the coordinator is the component
   * that owns the single running Scrape_Run. Two reasons, and both are about what the Web_App asks:
   * the published `ScrapeRun` type is a stored row with its per-Platform results, which the
   * in-process run state does not carry; and a row still marked "running" that no process is
   * executing is exactly what a crash leaves behind, so answering from the store keeps this query
   * from claiming a run is over before the stale-run recovery has closed it.
   *
   * The sort is a tie-breaker that should never be needed — 12.1 permits exactly one running
   * Scrape_Run and the coordinator enforces it — and is there so that a store which somehow holds
   * two answers this query deterministically with the later one.
   */
  async activeRun(): Promise<ScrapeRun | null> {
    return this.prisma.scrapeRun.findFirst({
      where: { status: 'RUNNING' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * One named Scrape_Run, or `null` where the Posting_Store holds none under that identifier.
   *
   * What the Log_View is opened on (12.2, 12.10). The Log_View is addressed by the identifier of
   * its Scrape_Run — a pasted URL and a browser reload both have to work — so the summary of 12.10
   * cannot be read from `activeRun`, which answers `null` the moment the run ends, nor from
   * `recentRuns`, which would make a run older than the list length unsummarizable.
   *
   * Unfiltered by status and by Run_Outcome, like the run list and for the same reason: a running
   * run, a cancelled one and one the stale-run recovery closed are all runs whose Log_View the user
   * may open. Whether the summary is shown at all is the `status` of the answer, which the Web_App
   * reads rather than guesses.
   *
   * @param id The `ScrapeRun.id` to read.
   */
  async runById(id: string): Promise<ScrapeRun | null> {
    return this.prisma.scrapeRun.findUnique({ where: { id } });
  }

  /**
   * The Scrape_Run of several identifiers, in one statement.
   *
   * The batch behind the `JobPosting.firstSeenRun` edge: a page of 25 postings references at most 25
   * Scrape_Run and usually two or three, so the edge is loaded once per page instead of once per row
   * (the N+1 the design names). The rows come back in whatever order the Posting_Store returns them;
   * the caller maps them onto its identifiers, because that is where the order is known.
   *
   * A duplicate identifier is read once and an identifier no Scrape_Run carries is simply absent
   * from the result, which is what lets the caller answer it with `null`.
   *
   * @param ids The `ScrapeRun.id` to read; an empty list is answered without a statement.
   */
  async runsByIds(ids: readonly string[]): Promise<readonly ScrapeRun[]> {
    const unique = [...new Set(ids)];

    if (unique.length === 0) {
      return [];
    }

    return this.prisma.scrapeRun.findMany({ where: { id: { in: unique } } });
  }

  /**
   * The per-Platform results of several Scrape_Run, in one statement (7.4).
   *
   * The batch behind the `ScrapeRun.platformResults` edge, the second of the two edges the design
   * loads this way: a run list of 20 entries would otherwise issue 20 result queries. Ordered by
   * Platform so that every run's block lists the Platform in the same order, which is what keeps the
   * run list readable when several runs are shown next to each other.
   *
   * @param runIds The `ScrapeRun.id` whose result rows are needed; an empty list reads nothing.
   */
  async platformResultsByRunIds(
    runIds: readonly string[],
  ): Promise<readonly ScrapeRunPlatformResult[]> {
    const unique = [...new Set(runIds)];

    if (unique.length === 0) {
      return [];
    }

    return this.prisma.scrapeRunPlatformResult.findMany({
      where: { runId: { in: unique } },
      orderBy: [{ platform: 'asc' }],
    });
  }
}
