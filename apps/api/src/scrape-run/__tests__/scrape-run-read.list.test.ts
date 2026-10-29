/**
 * The five reads of the Scrape_Run read layer that are not about the reference run (7.4, 12.2,
 * 12.5, 12.9, 12.10).
 *
 * The run list, the running Scrape_Run, the one named run a Log_View is opened on, and the two
 * batched edges. Driven against stand-in delegates that record the query they were given, because
 * what these methods decide is the query: the list size cap, the order, the absence of any filter on
 * the named run, and the deduplication that makes a batch one statement.
 *
 * Requirements: 7.4, 12.2, 12.5, 12.9, 12.10.
 */

import { describe, expect, it } from 'vitest';

import type {
  Platform,
  RunOutcome,
  RunStatus,
  ScrapeRun,
  ScrapeRunPlatformResult,
} from '../../prisma/prisma.types';
import {
  SCRAPE_RUN_LIST_DEFAULT_LIMIT,
  SCRAPE_RUN_LIST_MAX_LIMIT,
  ScrapeRunReadService,
  type ScrapeRunReadStore,
} from '../scrape-run-read.service';

interface RunFindManyArgs {
  readonly where?: { readonly id?: { readonly in?: readonly string[] } };
  readonly orderBy?: readonly Record<string, string>[];
  readonly take?: number;
}

interface ResultFindManyArgs {
  readonly where: { readonly runId?: { readonly in?: readonly string[] } };
}

interface StoreFixture {
  readonly store: ScrapeRunReadStore;
  readonly runFindManyArgs: RunFindManyArgs[];
  readonly runFindFirstArgs: { readonly where: Record<string, unknown> }[];
  readonly runFindUniqueArgs: { readonly where: { readonly id: string } }[];
  readonly resultFindManyArgs: ResultFindManyArgs[];
}

const runRow = (id: string, status: RunStatus, runOutcome: RunOutcome | null): ScrapeRun => ({
  id,
  startedAt: new Date('2026-03-02T06:00:00.000Z'),
  finishedAt: runOutcome === null ? null : new Date('2026-03-02T06:20:00.000Z'),
  status,
  runOutcome,
  closedByRecovery: false,
});

const resultRow = (runId: string, platform: Platform): ScrapeRunPlatformResult => ({
  id: `${runId}-${platform}`,
  runId,
  platform,
  platformStatus: 'COMPLETED',
  pagesFetched: 1,
  newPostings: 0,
  updatedPostings: 0,
  partialResult: false,
  missingMandatoryFields: [],
  effectiveProfile: null,
});

const createStore = (
  runs: readonly ScrapeRun[] = [],
  results: readonly ScrapeRunPlatformResult[] = [],
): StoreFixture => {
  const runFindManyArgs: RunFindManyArgs[] = [];
  const runFindFirstArgs: { where: Record<string, unknown> }[] = [];
  const runFindUniqueArgs: { where: { id: string } }[] = [];
  const resultFindManyArgs: ResultFindManyArgs[] = [];

  const store = {
    jobPosting: { count: () => Promise.resolve(0) },
    scrapeRun: {
      findMany: (args: RunFindManyArgs) => {
        runFindManyArgs.push(args);

        const ids = args.where?.id?.in;

        return Promise.resolve(
          ids === undefined ? [...runs] : runs.filter((run) => ids.includes(run.id)),
        );
      },
      findFirst: (args: { where: Record<string, unknown> }) => {
        runFindFirstArgs.push(args);

        return Promise.resolve(runs.find((run) => run.status === args.where.status) ?? null);
      },
      findUnique: (args: { where: { id: string } }) => {
        runFindUniqueArgs.push(args);

        return Promise.resolve(runs.find((run) => run.id === args.where.id) ?? null);
      },
    },
    scrapeRunPlatformResult: {
      findMany: (args: ResultFindManyArgs) => {
        resultFindManyArgs.push(args);

        const ids = args.where.runId?.in ?? [];

        return Promise.resolve(results.filter((result) => ids.includes(result.runId)));
      },
    },
  } as unknown as ScrapeRunReadStore;

  return { store, runFindManyArgs, runFindFirstArgs, runFindUniqueArgs, resultFindManyArgs };
};

describe('ScrapeRunReadService.recentRuns', () => {
  it('reads the newest runs first with the default size (12.9)', async () => {
    const fixture = createStore([runRow('run-1', 'FINISHED', 'COMPLETED')]);

    await new ScrapeRunReadService(fixture.store).recentRuns();

    expect(fixture.runFindManyArgs[0]?.take).toBe(SCRAPE_RUN_LIST_DEFAULT_LIMIT);
    expect(fixture.runFindManyArgs[0]?.orderBy).toEqual([{ startedAt: 'desc' }, { id: 'desc' }]);
    expect(fixture.runFindManyArgs[0]?.where).toBeUndefined();
  });

  it('caps a larger request and lifts a smaller one to one run', async () => {
    const fixture = createStore();
    const service = new ScrapeRunReadService(fixture.store);

    await service.recentRuns(1000);
    await service.recentRuns(0);
    await service.recentRuns(7);

    expect(fixture.runFindManyArgs.map((args) => args.take)).toEqual([
      SCRAPE_RUN_LIST_MAX_LIMIT,
      1,
      7,
    ]);
  });

  it('reads the default size for a value that is no number at all', async () => {
    const fixture = createStore();

    await new ScrapeRunReadService(fixture.store).recentRuns(Number.NaN);

    expect(fixture.runFindManyArgs[0]?.take).toBe(SCRAPE_RUN_LIST_DEFAULT_LIMIT);
  });
});

describe('ScrapeRunReadService.activeRun', () => {
  it('answers with the Scrape_Run that is marked running (12.5)', async () => {
    const running = runRow('run-running', 'RUNNING', null);
    const fixture = createStore([running]);

    await expect(new ScrapeRunReadService(fixture.store).activeRun()).resolves.toEqual(running);
    expect(fixture.runFindFirstArgs[0]?.where).toEqual({ status: 'RUNNING' });
  });

  it('answers with null where no Scrape_Run is running', async () => {
    const fixture = createStore([runRow('run-1', 'FINISHED', 'COMPLETED')]);

    await expect(new ScrapeRunReadService(fixture.store).activeRun()).resolves.toBeNull();
  });
});

describe('ScrapeRunReadService.runById', () => {
  it('answers the named Scrape_Run whatever its Run_Outcome (12.2, 12.10)', async () => {
    const cancelled = runRow('run-cancelled', 'FINISHED', 'CANCELLED_BY_USER');
    const fixture = createStore([runRow('run-1', 'FINISHED', 'COMPLETED'), cancelled]);

    // The Log_View is opened on an identifier, and a run the user cancelled is one whose log and
    // whose summary they will want to see. No filter by status and none by Run_Outcome.
    await expect(new ScrapeRunReadService(fixture.store).runById('run-cancelled')).resolves.toEqual(
      cancelled,
    );
    expect(fixture.runFindUniqueArgs).toEqual([{ where: { id: 'run-cancelled' } }]);
  });

  it('answers an identifier no Scrape_Run carries with null', async () => {
    const fixture = createStore([runRow('run-1', 'FINISHED', 'COMPLETED')]);

    await expect(
      new ScrapeRunReadService(fixture.store).runById('run-does-not-exist'),
    ).resolves.toBeNull();
  });
});

describe('ScrapeRunReadService.runsByIds', () => {
  it('reads every requested Scrape_Run in one statement, duplicates collapsed', async () => {
    const fixture = createStore([
      runRow('run-1', 'FINISHED', 'COMPLETED'),
      runRow('run-2', 'FINISHED', 'CANCELLED_BY_USER'),
    ]);

    const rows = await new ScrapeRunReadService(fixture.store).runsByIds([
      'run-1',
      'run-2',
      'run-1',
    ]);

    expect(rows.map((row) => row.id)).toEqual(['run-1', 'run-2']);
    expect(fixture.runFindManyArgs).toHaveLength(1);
    expect(fixture.runFindManyArgs[0]?.where).toEqual({ id: { in: ['run-1', 'run-2'] } });
  });

  it('issues no statement for an empty batch', async () => {
    const fixture = createStore();

    await expect(new ScrapeRunReadService(fixture.store).runsByIds([])).resolves.toEqual([]);
    expect(fixture.runFindManyArgs).toEqual([]);
  });
});

describe('ScrapeRunReadService.platformResultsByRunIds', () => {
  it('reads the result rows of every requested Scrape_Run in one statement (7.4)', async () => {
    const fixture = createStore(
      [],
      [resultRow('run-1', 'STEPSTONE'), resultRow('run-2', 'INDEED')],
    );

    const rows = await new ScrapeRunReadService(fixture.store).platformResultsByRunIds([
      'run-1',
      'run-2',
    ]);

    expect(rows.map((row) => row.id)).toEqual(['run-1-STEPSTONE', 'run-2-INDEED']);
    expect(fixture.resultFindManyArgs).toHaveLength(1);
  });

  it('issues no statement for an empty batch', async () => {
    const fixture = createStore();

    await expect(
      new ScrapeRunReadService(fixture.store).platformResultsByRunIds([]),
    ).resolves.toEqual([]);
    expect(fixture.resultFindManyArgs).toEqual([]);
  });
});
