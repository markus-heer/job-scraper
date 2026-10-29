/**
 * An in-memory stand-in for the `JobPosting` delegate of the Posting_Store.
 *
 * `PostingRepository` narrows its dependency to `Pick<PrismaService, 'jobPosting'>`, which is what
 * lets the field groups of 9.3 be driven without a database: the decision logic under test is the
 * real one, only the storage is a map. The three behaviours that have to be faithful for the tests
 * to mean anything are modelled explicitly:
 *
 * - **Column defaults.** A row starts out with the defaults `schema.prisma` declares, so a field the
 *   repository never writes — the Interest_Flag, the relevance columns, the commute columns — is
 *   observably at its default rather than `undefined`.
 * - **Partial updates.** `update` and `updateMany` merge `data` into the stored rows and leave every
 *   other column alone, which is exactly the "left unchanged" of 9.3, 9.5 and 11.8. A field the
 *   repository forgot to write would show up as the old value, not as `undefined`.
 * - **The unique key.** `create` raises a `P2002` conflict for a `(platform, postingId)` that already
 *   exists, so the lost-insert-race branch of the repository is reachable.
 * - **Filtered bulk updates.** `updateMany` applies the `platform`, `postingStatus` and
 *   `postingId: { notIn }` filters the sweep of 9.5 sends and reports the number of matched rows, so
 *   a wrong filter shows up as a wrong set of swept postings rather than as a silent no-op.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern so several suites in this
 * directory can share it. Not to be confused with `src/testing/posting-store.fixture.ts`, which
 * seeds a *real* PostgreSQL instance for the integration suite; this one replaces the database
 * instead of filling it.
 *
 * Requirements: 9.2, 9.3, 9.5, 9.7, 9.8, 11.8.
 */

import type { JobPosting, Platform } from '../../prisma/prisma.types';
import type { PostingStore } from '../posting.repository';

/** The delegate methods the repository writes through. */
export type WriteKind = 'create' | 'update' | 'updateMany';

/** The columns a caller may seed; everything else comes from the declared defaults. */
export type SeedPosting = Partial<JobPosting> &
  Pick<JobPosting, 'platform' | 'postingId' | 'title' | 'sourceUrl' | 'firstSeenRunId'>;

/** A stand-in `JobPosting` store with its rows and its recorded writes. */
export interface PostingStoreFixture {
  readonly store: PostingStore;
  /** The stored rows, keyed by `id`. */
  readonly rows: Map<string, JobPosting>;
  /**
   * Every write in order, so a test can assert that an idempotent re-apply still wrote once.
   *
   * One `updateMany` contributes one entry per row it changed, because the interesting question
   * about the sweep is which records it touched, not how many statements it took.
   */
  readonly writes: readonly { readonly kind: WriteKind; readonly id: string }[];
  /** The stored row of one unique key, or `undefined` where none exists. */
  rowOf(platform: Platform, postingId: string): JobPosting | undefined;
  /** Seeds a row as if an earlier Scrape_Run had written it, and returns it. */
  seed(posting: SeedPosting): JobPosting;
  /** Makes the next `create` or `update` reject with `error`, to drive the write failure path. */
  failNextWrite(error: unknown): void;
  /**
   * Makes the next `findUnique` report no record, whatever is stored.
   *
   * Stands for a read that happened before a concurrent writer inserted the same unique key: the
   * repository then takes its insert branch, the `create` hits the conflict, and the recovery path
   * becomes reachable without real concurrency.
   */
  staleNextRead(): void;
}

/** A `P2002` rejection shaped like the one the generated client raises for the unique key. */
export const uniqueKeyConflict = (): Error & { code: string } =>
  Object.assign(new Error('Unique constraint failed on the fields: (`platform`,`postingId`)'), {
    code: 'P2002',
  });

/** The defaults `schema.prisma` declares for every column the repository does not write. */
const columnDefaults = (id: string): Omit<JobPosting, 'platform' | 'postingId'> => ({
  id,
  title: '',
  employer: null,
  workLocation: null,
  publishedAt: null,
  sourceUrl: '',
  descriptionText: null,
  firstSeenAt: new Date(0),
  lastSeenAt: new Date(0),
  firstSeenRunId: '',
  postingStatus: 'LISTED',
  interestFlag: 'UNMARKED',
  relevanceVerdict: 'NOT_ASSESSED',
  relevanceReason: null,
  relevanceModel: null,
  relevanceAssessedAt: null,
  relevanceSetManually: false,
  relevanceRank: 2,
  contentHash: '',
  relevanceContentHash: null,
  bicycleMinutes: null,
  transitMinutes: null,
  bestCommuteMinutes: null,
  bestCommuteMode: null,
  commutePrecision: 'UNKNOWN',
  commuteLocationInput: null,
  commuteCheckedAt: null,
});

/** Creates a stand-in `JobPosting` store, optionally seeded with previously stored postings. */
export const createPostingStore = (initial: readonly SeedPosting[] = []): PostingStoreFixture => {
  const rows = new Map<string, JobPosting>();
  const writes: { kind: WriteKind; id: string }[] = [];
  let nextId = 1;
  let pendingFailure: { error: unknown } | null = null;
  let staleRead = false;

  const rowOf = (platform: Platform, postingId: string): JobPosting | undefined =>
    [...rows.values()].find((row) => row.platform === platform && row.postingId === postingId);

  const takeFailure = (): void => {
    if (pendingFailure === null) {
      return;
    }

    const { error } = pendingFailure;

    pendingFailure = null;

    throw error;
  };

  const insert = (data: Partial<JobPosting> & Pick<JobPosting, 'platform' | 'postingId'>) => {
    const id = `posting-${nextId}`;

    nextId += 1;

    const row: JobPosting = {
      ...columnDefaults(id),
      ...data,
      id,
    };

    rows.set(id, row);

    return row;
  };

  const store: PostingStore = {
    jobPosting: {
      findUnique: ({
        where,
      }: {
        where: { platform_postingId: { platform: Platform; postingId: string } };
      }) => {
        if (staleRead) {
          staleRead = false;

          return Promise.resolve(null);
        }

        const { platform, postingId } = where.platform_postingId;

        return Promise.resolve(rowOf(platform, postingId) ?? null);
      },

      create: ({
        data,
      }: {
        data: Partial<JobPosting> & Pick<JobPosting, 'platform' | 'postingId'>;
      }) => {
        takeFailure();

        if (rowOf(data.platform, data.postingId) !== undefined) {
          throw uniqueKeyConflict();
        }

        const row = insert(data);

        writes.push({ kind: 'create', id: row.id });

        return Promise.resolve(row);
      },

      update: ({ where, data }: { where: { id: string }; data: Partial<JobPosting> }) => {
        takeFailure();

        const existing = rows.get(where.id);

        if (existing === undefined) {
          throw new Error(`No JobPosting with id ${where.id}`);
        }

        // Merge, so every column absent from `data` keeps its stored value — the "left unchanged"
        // of 9.3 and 11.8 is what these tests are about.
        const row: JobPosting = { ...existing, ...data };

        rows.set(row.id, row);
        writes.push({ kind: 'update', id: row.id });

        return Promise.resolve(row);
      },

      updateMany: ({
        where,
        data,
      }: {
        where: {
          platform?: Platform;
          postingStatus?: JobPosting['postingStatus'];
          postingId?: { notIn: readonly string[] };
        };
        data: Partial<JobPosting>;
      }) => {
        takeFailure();

        const matches = [...rows.values()].filter(
          (row) =>
            (where.platform === undefined || row.platform === where.platform) &&
            (where.postingStatus === undefined || row.postingStatus === where.postingStatus) &&
            (where.postingId === undefined || !where.postingId.notIn.includes(row.postingId)),
        );

        for (const existing of matches) {
          // Merge, as in `update` above: a bulk write that silently reset an untouched column would
          // be the exact failure 9.5 forbids, so the fixture must not hide it.
          const row: JobPosting = { ...existing, ...data };

          rows.set(row.id, row);
          writes.push({ kind: 'updateMany', id: row.id });
        }

        return Promise.resolve({ count: matches.length });
      },
      // The delegate carries far more methods than the repository calls; only the four above are
      // modelled, and the cast is what keeps the fixture to the surface actually under test.
    } as unknown as PostingStore['jobPosting'],
  };

  const fixture: PostingStoreFixture = {
    store,
    rows,
    writes,
    rowOf,
    seed: (posting) => insert(posting),
    failNextWrite: (error) => {
      pendingFailure = { error };
    },
    staleNextRead: () => {
      staleRead = true;
    },
  };

  for (const posting of initial) {
    insert(posting);
  }

  return fixture;
};
