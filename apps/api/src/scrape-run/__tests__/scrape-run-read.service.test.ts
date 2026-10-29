/**
 * Which Scrape_Run the posting overview is built on, and the numbers it states about it (11.2,
 * 11.4, 11.5, 11.6, 11.7).
 *
 * The service narrows its dependency to three Posting_Store delegates, which is what lets the
 * selection rule be driven without a database: the decision under test — a Scrape_Run counts as the
 * reference exactly when it carries the Run_Outcome "completed" and the latest end time — is the
 * real one, only the storage is a map. The stand-in below applies the filter and the sort keys the
 * service sends rather than returning a prepared answer, so a wrong `where` or a missing tie-breaker
 * shows up as a wrong run instead of passing unnoticed.
 *
 * Requirements: 11.2, 11.4, 11.5, 11.6, 11.7.
 */

import { describe, expect, it } from 'vitest';

import type { Platform, RunOutcome, RunStatus, ScrapeRun } from '../../prisma/prisma.types';
import { ScrapeRunReadService, type ScrapeRunReadStore } from '../scrape-run-read.service';

/** A stored `ScrapeRun` row as a test seeds it; every column the selection reads is explicit. */
interface SeedRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly status?: RunStatus;
  readonly runOutcome?: RunOutcome | null;
  readonly closedByRecovery?: boolean;
}

/** A stored `ScrapeRunPlatformResult` row, reduced to the two counters of 11.5. */
interface SeedPlatformResult {
  readonly runId: string;
  readonly platform: Platform;
  readonly newPostings: number;
  readonly updatedPostings: number;
}

/** The filter the service sends; only the three terms it uses are modelled. */
interface RunWhere {
  readonly status?: RunStatus;
  readonly runOutcome?: RunOutcome;
  readonly finishedAt?: { readonly not: null };
}

/** One sort key of the service's `orderBy`, as Prisma receives it. */
type RunOrderBy = Partial<Record<'finishedAt' | 'startedAt' | 'id', 'asc' | 'desc'>>;

interface ReadStoreFixture {
  readonly store: ScrapeRunReadStore;
  /** How often the `ScrapeRun` selection was issued, so a cached answer is detectable. */
  readonly selections: () => number;
  /** Adds a Scrape_Run after the service has already answered once. */
  readonly addRun: (run: SeedRun) => void;
}

const rowOf = (run: SeedRun): ScrapeRun => ({
  id: run.id,
  startedAt: new Date(run.startedAt),
  finishedAt:
    run.finishedAt === undefined || run.finishedAt === null ? null : new Date(run.finishedAt),
  status: run.status ?? 'FINISHED',
  runOutcome: run.runOutcome === undefined ? 'COMPLETED' : run.runOutcome,
  closedByRecovery: run.closedByRecovery ?? false,
});

/** The sortable value of one column, with a missing end time ordering before every present one. */
const keyOf = (row: ScrapeRun, key: 'finishedAt' | 'startedAt' | 'id'): number | string => {
  if (key === 'id') {
    return row.id;
  }

  const value = key === 'finishedAt' ? row.finishedAt : row.startedAt;

  return value === null ? Number.NEGATIVE_INFINITY : value.getTime();
};

/** Compares two rows by the service's `orderBy` list, in the order the list gives the keys. */
const compareBy =
  (orderBy: readonly RunOrderBy[]) =>
  (left: ScrapeRun, right: ScrapeRun): number => {
    for (const clause of orderBy) {
      for (const [key, direction] of Object.entries(clause)) {
        const sortKey = key as 'finishedAt' | 'startedAt' | 'id';
        const leftKey = keyOf(left, sortKey);
        const rightKey = keyOf(right, sortKey);

        if (leftKey !== rightKey) {
          const ascending = leftKey < rightKey ? -1 : 1;

          return direction === 'desc' ? -ascending : ascending;
        }
      }
    }

    return 0;
  };

/**
 * Creates the three stand-in delegates.
 *
 * `findFirst` applies the filter and the sort the service sends; `aggregate` sums the seeded result
 * rows of one run and answers `null` for a run without any, as `_sum` over no rows does; `count`
 * answers with the seeded total number of stored Job_Posting.
 */
const createReadStore = (input: {
  readonly runs: readonly SeedRun[];
  readonly platformResults?: readonly SeedPlatformResult[];
  readonly totalPostings?: number;
  readonly failSelection?: unknown;
}): ReadStoreFixture => {
  const rows = input.runs.map(rowOf);
  const results = input.platformResults ?? [];
  let selections = 0;

  const store: ScrapeRunReadStore = {
    scrapeRun: {
      findFirst: ({
        where,
        orderBy,
      }: {
        where: RunWhere;
        orderBy: readonly RunOrderBy[];
      }): Promise<ScrapeRun | null> => {
        selections += 1;

        if (input.failSelection !== undefined) {
          return Promise.reject(input.failSelection);
        }

        const matching = rows.filter(
          (row) =>
            (where.status === undefined || row.status === where.status) &&
            (where.runOutcome === undefined || row.runOutcome === where.runOutcome) &&
            (where.finishedAt === undefined || row.finishedAt !== null),
        );

        return Promise.resolve([...matching].sort(compareBy(orderBy)).at(0) ?? null);
      },
    } as unknown as ScrapeRunReadStore['scrapeRun'],

    scrapeRunPlatformResult: {
      aggregate: ({ where }: { where: { runId: string } }) => {
        const ofRun = results.filter((result) => result.runId === where.runId);

        return Promise.resolve({
          _sum:
            ofRun.length === 0
              ? { newPostings: null, updatedPostings: null }
              : {
                  newPostings: ofRun.reduce((sum, result) => sum + result.newPostings, 0),
                  updatedPostings: ofRun.reduce((sum, result) => sum + result.updatedPostings, 0),
                },
        });
      },
    } as unknown as ScrapeRunReadStore['scrapeRunPlatformResult'],

    jobPosting: {
      count: () => Promise.resolve(input.totalPostings ?? 0),
    } as unknown as ScrapeRunReadStore['jobPosting'],
  };

  return {
    store,
    selections: () => selections,
    addRun: (run) => {
      rows.push(rowOf(run));
    },
  };
};

const serviceOver = (fixture: ReadStoreFixture): ScrapeRunReadService =>
  new ScrapeRunReadService(fixture.store);

describe('the most recently completed Scrape_Run', () => {
  it('is the completed run with the latest end time (11.2)', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:20:00.000Z',
        },
        {
          id: 'run-2',
          startedAt: '2026-03-02T08:00:00.000Z',
          finishedAt: '2026-03-02T08:25:00.000Z',
        },
        {
          id: 'run-3',
          startedAt: '2026-03-01T20:00:00.000Z',
          finishedAt: '2026-03-01T20:30:00.000Z',
        },
      ],
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).resolves.toBe('run-2');
  });

  it('ignores a later Scrape_Run the user cancelled (11.7)', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:20:00.000Z',
        },
        {
          id: 'run-2',
          startedAt: '2026-03-02T08:00:00.000Z',
          finishedAt: '2026-03-02T08:02:00.000Z',
          runOutcome: 'CANCELLED_BY_USER',
        },
      ],
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).resolves.toBe('run-1');
  });

  it('ignores a later Scrape_Run the retrieval limit ended (11.7, 13.6)', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:20:00.000Z',
        },
        {
          id: 'run-2',
          startedAt: '2026-03-02T08:00:00.000Z',
          finishedAt: '2026-03-02T08:30:00.000Z',
          runOutcome: 'CANCELLED_BY_TIME_LIMIT',
        },
      ],
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).resolves.toBe('run-1');
  });

  it('ignores a later Scrape_Run the stale-run recovery closed (11.7)', async () => {
    // The recovery closes a run a crashed process left behind with `CANCELLED_BY_TIME_LIMIT` and
    // `closedByRecovery`, precisely so that a restart cannot move the marking "neu".
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:20:00.000Z',
        },
        {
          id: 'run-2',
          startedAt: '2026-03-02T08:00:00.000Z',
          finishedAt: '2026-03-02T09:00:00.000Z',
          runOutcome: 'CANCELLED_BY_TIME_LIMIT',
          closedByRecovery: true,
        },
      ],
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).resolves.toBe('run-1');
  });

  it('ignores the Scrape_Run that is still running (11.7)', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:20:00.000Z',
        },
        {
          id: 'run-2',
          startedAt: '2026-03-02T08:00:00.000Z',
          finishedAt: null,
          status: 'RUNNING',
          runOutcome: null,
        },
      ],
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).resolves.toBe('run-1');
  });

  it('decides an equal end time by the later start time and then by the identifier', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-a',
          startedAt: '2026-03-02T08:00:00.000Z',
          finishedAt: '2026-03-02T08:30:00.000Z',
        },
        {
          id: 'run-b',
          startedAt: '2026-03-02T08:10:00.000Z',
          finishedAt: '2026-03-02T08:30:00.000Z',
        },
        {
          id: 'run-c',
          startedAt: '2026-03-02T08:10:00.000Z',
          finishedAt: '2026-03-02T08:30:00.000Z',
        },
      ],
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).resolves.toBe('run-c');
  });

  it('is absent while no Scrape_Run has completed (11.6)', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:05:00.000Z',
          runOutcome: 'CANCELLED_BY_USER',
        },
      ],
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).resolves.toBeNull();
    await expect(serviceOver(fixture).latestScrapeRunSummary()).resolves.toBeNull();
  });

  it('is asked again on every read, so a further completed run moves the marking (11.4)', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:20:00.000Z',
        },
      ],
    });
    const service = serviceOver(fixture);

    await expect(service.latestCompletedRunId()).resolves.toBe('run-1');

    fixture.addRun({
      id: 'run-2',
      startedAt: '2026-03-02T08:00:00.000Z',
      finishedAt: '2026-03-02T08:25:00.000Z',
    });

    await expect(service.latestCompletedRunId()).resolves.toBe('run-2');
    expect(fixture.selections()).toBe(2);
  });

  it('propagates a rejected read instead of reporting "no Scrape_Run completed"', async () => {
    const fixture = createReadStore({
      runs: [],
      failSelection: new Error('Posting_Store unreachable'),
    });

    await expect(serviceOver(fixture).latestCompletedRunId()).rejects.toThrow(
      'Posting_Store unreachable',
    );
  });
});

describe('the counters of the posting overview (11.5)', () => {
  const COMPLETED_RUN: SeedRun = {
    id: 'run-2',
    startedAt: '2026-03-02T08:00:00.000Z',
    finishedAt: '2026-03-02T08:25:00.000Z',
  };

  it('reports start time, end time, Run_Outcome and the three counts', async () => {
    const fixture = createReadStore({
      runs: [
        {
          id: 'run-1',
          startedAt: '2026-03-01T08:00:00.000Z',
          finishedAt: '2026-03-01T08:20:00.000Z',
        },
        COMPLETED_RUN,
      ],
      platformResults: [
        { runId: 'run-2', platform: 'STEPSTONE', newPostings: 4, updatedPostings: 11 },
        { runId: 'run-2', platform: 'JOBVECTOR', newPostings: 3, updatedPostings: 2 },
        // Rows of the earlier Scrape_Run; they belong to a different run and are not summed in.
        { runId: 'run-1', platform: 'STEPSTONE', newPostings: 90, updatedPostings: 90 },
      ],
      totalPostings: 128,
    });

    await expect(serviceOver(fixture).latestScrapeRunSummary()).resolves.toEqual({
      id: 'run-2',
      startedAt: new Date('2026-03-02T08:00:00.000Z'),
      finishedAt: new Date('2026-03-02T08:25:00.000Z'),
      runOutcome: 'COMPLETED',
      newPostings: 7,
      resightedPostings: 13,
      totalPostings: 128,
    });
  });

  it('reports zeros for a completed Scrape_Run without a single result row', async () => {
    const fixture = createReadStore({ runs: [COMPLETED_RUN], totalPostings: 12 });

    await expect(serviceOver(fixture).latestScrapeRunSummary()).resolves.toMatchObject({
      newPostings: 0,
      resightedPostings: 0,
      totalPostings: 12,
    });
  });

  it('counts every stored Job_Posting, not only the ones of that Scrape_Run', async () => {
    const fixture = createReadStore({
      runs: [COMPLETED_RUN],
      platformResults: [{ runId: 'run-2', platform: 'INDEED', newPostings: 1, updatedPostings: 0 }],
      totalPostings: 540,
    });

    await expect(serviceOver(fixture).latestScrapeRunSummary()).resolves.toMatchObject({
      newPostings: 1,
      totalPostings: 540,
    });
  });
});
