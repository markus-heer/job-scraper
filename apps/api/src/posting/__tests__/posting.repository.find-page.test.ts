/**
 * Unit tests for how the repository runs one page read (10.5, 10.6, 10.7, 10.9).
 *
 * `findPage` makes no decisions of its own: it builds the `where`, the `orderBy` and the window with
 * the pure functions of `../posting-page-query.ts` and hands them to the Posting_Store. So what is
 * asserted here is the wiring, against a stand-in delegate that records the query it was given:
 *
 * - the filter, the order and the window reach the store as the pure functions produced them,
 *   including the normalization of a page size above the 25 of 10.9 — a client must not be able to
 *   ask the Posting_Store for every stored row at once;
 * - the reported `totalCount` is the count of the *filtered* set rather than of the page, and the
 *   reported `pageCount` and `page` follow from it (10.9);
 * - an empty store is answered with an empty page and no page count, which is the state the empty
 *   hints of 10.12 and 10.13 are shown for.
 *
 * Whether PostgreSQL executes that query as described is a question about the engine and is asked in
 * `./posting.repository.find-page.integration.test.ts`; the rules themselves are asserted in
 * `./posting-page-query.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { JobPosting, Prisma } from '../../prisma/prisma.types';
import { PostingRepository, type PostingStore } from '../posting.repository';
import {
  DEFAULT_POSTING_SORT,
  type FindPostingPageInput,
  POSTING_PAGE_SIZE,
  postingOrderByOf,
  postingWhereOf,
} from '../posting-page-query';
import { createPostingStore } from './job-posting-delegate.fixture';

/** The Commute_Threshold in force for these reads (8.10). */
const THRESHOLD_MINUTES = 60;

/** The input of one read, with the parts a test does not care about at their defaults. */
const readInput = (overrides: Partial<FindPostingPageInput> = {}): FindPostingPageInput => ({
  filter: {},
  sort: DEFAULT_POSTING_SORT,
  page: 1,
  pageSize: POSTING_PAGE_SIZE,
  commuteThresholdMinutes: THRESHOLD_MINUTES,
  latestCompletedRunId: null,
  ...overrides,
});

/** Stored rows with the column defaults of `schema.prisma`, built by the shared fixture. */
const storedRows = (count: number): readonly JobPosting[] => {
  const fixture = createPostingStore();

  return Array.from({ length: count }, (_unused, index) =>
    fixture.seed({
      platform: 'STEPSTONE',
      postingId: `stepstone-${index}`,
      title: `Projektmanagerin ${index}`,
      sourceUrl: `https://www.stepstone.de/stellenangebote--${index}`,
      firstSeenRunId: 'run-1',
    }),
  );
};

/** What the stand-in delegate recorded, so a test can assert on the query and not on its result. */
interface ReadStoreFixture {
  readonly store: PostingStore;
  readonly countArgs: Prisma.JobPostingCountArgs[];
  readonly findManyArgs: Prisma.JobPostingFindManyArgs[];
}

/**
 * A stand-in `JobPosting` delegate for reads.
 *
 * Deliberately not an in-memory query engine: a stand-in that filtered, sorted and cut the rows
 * itself would assert the stand-in's reading of the query instead of PostgreSQL's. It reports the
 * row count and the rows it was given, and records what it was asked.
 */
const createReadStore = (rows: readonly JobPosting[]): ReadStoreFixture => {
  const countArgs: Prisma.JobPostingCountArgs[] = [];
  const findManyArgs: Prisma.JobPostingFindManyArgs[] = [];

  const store: PostingStore = {
    jobPosting: {
      count: (args: Prisma.JobPostingCountArgs) => {
        countArgs.push(args);

        return Promise.resolve(rows.length);
      },
      findMany: (args: Prisma.JobPostingFindManyArgs) => {
        findManyArgs.push(args);

        return Promise.resolve([...rows]);
      },
      // Only the two methods the read calls are modelled; the cast keeps the fixture to the surface
      // under test, as in `./job-posting-delegate.fixture.ts`.
    } as unknown as PostingStore['jobPosting'],
  };

  return { store, countArgs, findManyArgs };
};

describe('PostingRepository.findPage', () => {
  it('reads the filter, the order and the window the pure rules produced (10.5, 10.7, 10.9)', async () => {
    const fixture = createReadStore(storedRows(3));
    const repository = new PostingRepository(fixture.store);
    const filter = {
      platforms: ['STEPSTONE'],
      reachability: ['WELL_REACHABLE'],
      relevanceVerdicts: ['RELEVANT', 'UNCERTAIN'],
    } as const;
    const sort = { field: 'BEST_COMMUTE_MINUTES', direction: 'ASC' } as const;

    await repository.findPage(readInput({ filter, sort, page: 2, pageSize: POSTING_PAGE_SIZE }));

    const expectedWhere = postingWhereOf(filter, THRESHOLD_MINUTES);

    expect(fixture.findManyArgs).toEqual([
      { where: expectedWhere, orderBy: postingOrderByOf(sort), skip: 25, take: 25 },
    ]);

    // The count is taken over the same filter and without the window: `totalCount` is the size of
    // the filtered result, not of the page (10.9).
    expect(fixture.countArgs).toEqual([{ where: expectedWhere }]);
  });

  it('applies the default view when no marking or verdict filter is set (10.6, 10.11)', async () => {
    const fixture = createReadStore(storedRows(1));
    const repository = new PostingRepository(fixture.store);

    await repository.findPage(readInput());

    expect(fixture.findManyArgs[0]?.where).toEqual({
      interestFlag: { not: 'NOT_INTERESTING' },
      relevanceVerdict: { not: 'NOT_RELEVANT' },
    });
  });

  it('reports the entries, the total and the pages of the requested page (10.9)', async () => {
    const rows = storedRows(4);
    const repository = new PostingRepository(createReadStore(rows).store);

    await expect(repository.findPage(readInput({ page: 1, pageSize: 2 }))).resolves.toEqual({
      items: rows,
      totalCount: 4,
      pageCount: 2,
      page: 1,
    });
  });

  it('never asks the Posting_Store for more than 25 entries (10.9)', async () => {
    const fixture = createReadStore(storedRows(1));
    const repository = new PostingRepository(fixture.store);

    await repository.findPage(readInput({ page: 0, pageSize: 10_000 }));

    expect(fixture.findManyArgs[0]).toMatchObject({ skip: 0, take: POSTING_PAGE_SIZE });
  });

  it('answers an empty Posting_Store with an empty page and no page count (10.12, 10.13)', async () => {
    const repository = new PostingRepository(createReadStore([]).store);

    await expect(repository.findPage(readInput())).resolves.toEqual({
      items: [],
      totalCount: 0,
      pageCount: 0,
      page: 1,
    });
  });
});
