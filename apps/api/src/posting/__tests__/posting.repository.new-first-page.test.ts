/**
 * The posting overview in the default grouping of 11.3, read through `findPage`.
 *
 * The grouping is the one part of the read that is not a single statement, and what has to hold
 * about it is a statement about the *whole* list rather than about one page: every Job_Posting
 * marked "neu" stands above every unmarked one, both groups are sorted by recording time descending,
 * and the pages of the grouped list still partition it. A stand-in `JobPosting` delegate that really
 * evaluates the filter, the order and the window is what makes that assertable without a database:
 * the repository's own decisions are the real ones, only the storage is an array.
 *
 * The grouping applies only where the user chose no deviating sorting (11.3) and only while a
 * Scrape_Run has completed (11.6); both exclusions are asserted here as well, because in both cases
 * the answer is the plain sorted list and a grouping applied anyway would reorder it.
 *
 * Requirements: 10.7, 10.9, 11.2, 11.3, 11.6, 11.7.
 */

import { describe, expect, it } from 'vitest';

import type { JobPosting, Prisma } from '../../prisma/prisma.types';
import { PostingRepository, type PostingStore } from '../posting.repository';
import {
  DEFAULT_POSTING_SORT,
  type FindPostingPageInput,
  type PostingSort,
} from '../posting-page-query';

/** The columns these tests distinguish rows by; everything else is at its declared default. */
interface SeedRow {
  readonly id: string;
  readonly firstSeenRunId: string;
  readonly firstSeenAt: string;
  readonly interestFlag?: JobPosting['interestFlag'];
}

/** The reference run of the marking: the most recently completed Scrape_Run. */
const LATEST_COMPLETED_RUN = 'run-2';

/**
 * Seven stored Job_Posting from three Scrape_Run, in no particular order.
 *
 * `run-1` completed earlier, `run-2` is the most recently completed one and `run-3` ran *after* it
 * and did not complete — the case of 11.7, whose postings are the newest of all and still unmarked.
 */
const SEEDED_ROWS: readonly SeedRow[] = [
  { id: 'p-3-b', firstSeenRunId: 'run-3', firstSeenAt: '2026-03-03T08:00:00.000Z' },
  { id: 'p-1-a', firstSeenRunId: 'run-1', firstSeenAt: '2026-03-01T08:00:00.000Z' },
  { id: 'p-2-c', firstSeenRunId: 'run-2', firstSeenAt: '2026-03-02T08:00:00.000Z' },
  { id: 'p-2-a', firstSeenRunId: 'run-2', firstSeenAt: '2026-03-02T08:00:00.000Z' },
  { id: 'p-1-b', firstSeenRunId: 'run-1', firstSeenAt: '2026-03-01T08:00:00.000Z' },
  { id: 'p-3-a', firstSeenRunId: 'run-3', firstSeenAt: '2026-03-03T08:00:00.000Z' },
  { id: 'p-2-b', firstSeenRunId: 'run-2', firstSeenAt: '2026-03-02T08:00:00.000Z' },
];

const rowOf = (seed: SeedRow): JobPosting =>
  ({
    id: seed.id,
    platform: 'STEPSTONE',
    postingId: seed.id,
    title: seed.id,
    employer: null,
    workLocation: null,
    publishedAt: null,
    sourceUrl: `https://www.stepstone.de/${seed.id}`,
    descriptionText: null,
    firstSeenAt: new Date(seed.firstSeenAt),
    lastSeenAt: new Date(seed.firstSeenAt),
    firstSeenRunId: seed.firstSeenRunId,
    postingStatus: 'LISTED',
    interestFlag: seed.interestFlag ?? 'UNMARKED',
    relevanceVerdict: 'NOT_ASSESSED',
    relevanceReason: null,
    relevanceModel: null,
    relevanceAssessedAt: null,
    relevanceSetManually: false,
    relevanceRank: 2,
    contentHash: seed.id,
    relevanceContentHash: null,
    bicycleMinutes: null,
    transitMinutes: null,
    bestCommuteMinutes: null,
    bestCommuteMode: null,
    commutePrecision: 'UNKNOWN',
    commuteLocationInput: null,
    commuteCheckedAt: null,
  }) satisfies JobPosting;

/** The `where` terms the grouped read sends; the stand-in evaluates exactly these. */
interface EvaluatedWhere {
  readonly AND?: readonly EvaluatedWhere[];
  readonly firstSeenRunId?: string | { readonly not: string };
  readonly interestFlag?: { readonly not?: string; readonly in?: readonly string[] };
  readonly relevanceVerdict?: { readonly not?: string; readonly in?: readonly string[] };
}

const matchesEnum = (
  value: string,
  term: { readonly not?: string; readonly in?: readonly string[] } | undefined,
): boolean => {
  if (term === undefined) {
    return true;
  }

  return (
    (term.not === undefined || value !== term.not) &&
    (term.in === undefined || term.in.includes(value))
  );
};

const matches = (row: JobPosting, where: EvaluatedWhere): boolean => {
  if (where.AND !== undefined && !where.AND.every((term) => matches(row, term))) {
    return false;
  }

  if (where.firstSeenRunId !== undefined) {
    const term = where.firstSeenRunId;
    const held =
      typeof term === 'string' ? row.firstSeenRunId === term : row.firstSeenRunId !== term.not;

    if (!held) {
      return false;
    }
  }

  return (
    matchesEnum(row.interestFlag, where.interestFlag) &&
    matchesEnum(row.relevanceVerdict, where.relevanceVerdict)
  );
};

/** The two sort keys of the default sorting: recording time descending, then the identifier. */
const byDefaultSort = (left: JobPosting, right: JobPosting): number =>
  right.firstSeenAt.getTime() - left.firstSeenAt.getTime() || left.id.localeCompare(right.id);

/** The ascending counterpart, for the read that is not grouped because the user chose it. */
const byAscendingFirstSeen = (left: JobPosting, right: JobPosting): number =>
  left.firstSeenAt.getTime() - right.firstSeenAt.getTime() || left.id.localeCompare(right.id);

interface StoreFixture {
  readonly store: PostingStore;
  /** Every `findMany` the read issued, so an untouched group is visible as a missing statement. */
  readonly findManyArgs: readonly Prisma.JobPostingFindManyArgs[];
  readonly countArgs: readonly Prisma.JobPostingCountArgs[];
}

/**
 * A `JobPosting` delegate over the seeded rows that evaluates the filter, the order and the window.
 *
 * `orderBy` is not interpreted generally — the repository sends the orders of 10.7 and this fixture
 * answers the two the tests use — but the filter and the window are applied as sent, which is where
 * a wrong grouping would show up.
 */
const createStore = (rows: readonly JobPosting[]): StoreFixture => {
  const findManyArgs: Prisma.JobPostingFindManyArgs[] = [];
  const countArgs: Prisma.JobPostingCountArgs[] = [];

  const selected = (where: EvaluatedWhere | undefined): JobPosting[] =>
    rows.filter((row) => where === undefined || matches(row, where));

  const store: PostingStore = {
    jobPosting: {
      count: (args: Prisma.JobPostingCountArgs) => {
        countArgs.push(args);

        return Promise.resolve(selected(args.where as EvaluatedWhere | undefined).length);
      },

      findMany: (args: Prisma.JobPostingFindManyArgs) => {
        findManyArgs.push(args);

        const ascending =
          JSON.stringify(args.orderBy).includes('"firstSeenAt":"asc"') ||
          JSON.stringify(args.orderBy).includes('"sort":"asc"');
        const ordered = selected(args.where as EvaluatedWhere | undefined).sort(
          ascending ? byAscendingFirstSeen : byDefaultSort,
        );
        const skip = args.skip ?? 0;

        return Promise.resolve(ordered.slice(skip, skip + (args.take ?? ordered.length)));
      },
    } as unknown as PostingStore['jobPosting'],
  };

  return { store, findManyArgs, countArgs };
};

const inputFor = (overrides: Partial<FindPostingPageInput> = {}): FindPostingPageInput => ({
  filter: {},
  sort: DEFAULT_POSTING_SORT,
  page: 1,
  pageSize: 3,
  commuteThresholdMinutes: 45,
  latestCompletedRunId: LATEST_COMPLETED_RUN,
  ...overrides,
});

const idsOf = async (
  fixture: StoreFixture,
  overrides: Partial<FindPostingPageInput> = {},
): Promise<readonly string[]> => {
  const page = await new PostingRepository(fixture.store).findPage(inputFor(overrides));

  return page.items.map((item) => item.id);
};

describe('findPage in the default grouping (11.3)', () => {
  it('places the postings of the most recently completed Scrape_Run above every other one', async () => {
    const fixture = createStore(SEEDED_ROWS.map(rowOf));

    // Page 1 is the marked group, in recording time descending — which is one instant for all three
    // of them, so the identifier decides inside the group.
    await expect(idsOf(fixture)).resolves.toEqual(['p-2-a', 'p-2-b', 'p-2-c']);
  });

  it('continues with the unmarked postings, newest first, across the page boundary (11.7)', async () => {
    const fixture = createStore(SEEDED_ROWS.map(rowOf));

    // The two postings of the *later* Scrape_Run that did not complete are the newest of all and
    // still come after the marked ones; 11.7 is what makes that the right order.
    await expect(idsOf(fixture, { page: 2 })).resolves.toEqual(['p-3-a', 'p-3-b', 'p-1-a']);
    await expect(idsOf(fixture, { page: 3 })).resolves.toEqual(['p-1-b']);
  });

  it('reports the filtered total and the page count of the grouped list (10.9)', async () => {
    const fixture = createStore(SEEDED_ROWS.map(rowOf));
    const page = await new PostingRepository(fixture.store).findPage(inputFor());

    expect(page).toMatchObject({ totalCount: 7, pageCount: 3, page: 1 });
  });

  it('partitions the grouped list across its pages, each entry exactly once (10.9, 11.3)', async () => {
    const fixture = createStore(SEEDED_ROWS.map(rowOf));
    const pages = await Promise.all([
      idsOf(fixture, { page: 1 }),
      idsOf(fixture, { page: 2 }),
      idsOf(fixture, { page: 3 }),
      idsOf(fixture, { page: 4 }),
    ]);

    expect(pages.flat()).toEqual(['p-2-a', 'p-2-b', 'p-2-c', 'p-3-a', 'p-3-b', 'p-1-a', 'p-1-b']);
    expect(pages.at(3)).toEqual([]);
  });

  it('applies the filter inside both groups, so the default view still hides a posting (10.11)', async () => {
    const marked = SEEDED_ROWS.map((seed) =>
      seed.id === 'p-2-b' ? { ...seed, interestFlag: 'NOT_INTERESTING' as const } : seed,
    );
    const fixture = createStore(marked.map(rowOf));
    const page = await new PostingRepository(fixture.store).findPage(
      inputFor({ page: 1, pageSize: 25 }),
    );

    // Marked "neu" does not exempt a Job_Posting from the default view: the grouping reorders the
    // filtered set and never changes which postings are in it.
    expect(page.items.map((item) => item.id)).toEqual([
      'p-2-a',
      'p-2-c',
      'p-3-a',
      'p-3-b',
      'p-1-a',
      'p-1-b',
    ]);
    expect(page.totalCount).toBe(6);
  });

  it('does not query a group the requested page does not reach into', async () => {
    const fixture = createStore(SEEDED_ROWS.map(rowOf));

    await idsOf(fixture, { page: 1 });

    // Page 1 lies entirely inside the marked group, so only that group is read.
    expect(fixture.findManyArgs).toHaveLength(1);
    expect(fixture.findManyArgs.at(0)?.where).toEqual({
      AND: [expect.anything(), { firstSeenRunId: LATEST_COMPLETED_RUN }],
    });
  });
});

describe('findPage without the default grouping', () => {
  it('returns the plain sorted list when the user chose a deviating sorting (11.3)', async () => {
    const fixture = createStore(SEEDED_ROWS.map(rowOf));
    const ascending: PostingSort = { field: 'FIRST_SEEN_AT', direction: 'ASC' };

    await expect(idsOf(fixture, { sort: ascending, pageSize: 25 })).resolves.toEqual([
      'p-1-a',
      'p-1-b',
      'p-2-a',
      'p-2-b',
      'p-2-c',
      'p-3-a',
      'p-3-b',
    ]);
    expect(fixture.countArgs).toHaveLength(1);
  });

  it('returns the plain sorted list while no Scrape_Run has completed (11.6)', async () => {
    const fixture = createStore(SEEDED_ROWS.map(rowOf));

    await expect(idsOf(fixture, { latestCompletedRunId: null, pageSize: 25 })).resolves.toEqual([
      'p-3-a',
      'p-3-b',
      'p-2-a',
      'p-2-b',
      'p-2-c',
      'p-1-a',
      'p-1-b',
    ]);
    // One count and one page read: nothing is marked, so there is no group to split.
    expect(fixture.countArgs).toHaveLength(1);
    expect(fixture.findManyArgs).toHaveLength(1);
  });
});
