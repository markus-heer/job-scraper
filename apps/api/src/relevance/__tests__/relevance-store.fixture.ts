/**
 * An in-memory stand-in for the `JobPosting` delegate the relevance enrichment stage reads and
 * writes through.
 *
 * The stage narrows its store dependency to `Pick<PrismaService, 'jobPosting'>` and writes through
 * the real `PostingRepository`, which is what lets the content hash gate of 15.5 and 15.6 and the
 * six-column write of 15.1 be driven without a database: the decisions under test are the real
 * ones, only the storage is a map.
 *
 * Three behaviours have to be faithful for the tests to mean anything:
 *
 * - **The candidate query.** `findMany` applies the `lastSeenAt` and `relevanceSetManually` filters
 *   and the `orderBy` the stage sends, so a wrong filter shows up as a wrong candidate set rather
 *   than as a silent pass.
 * - **Column defaults.** A row starts out with the defaults `schema.prisma` declares — verdict
 *   `NOT_ASSESSED`, rank 2, no `relevanceContentHash` — so a Job_Posting the stage never writes is
 *   observably at its default instead of `undefined`.
 * - **Merging updates.** `update` merges `data` into the stored row, so a column the relevance write
 *   must not touch — the Interest_Flag, the commute result, `relevanceSetManually`, the content
 *   fields of the retrieval — shows up as its old value and not as `undefined`.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern, so the unit suite of task
 * 14.4 and the fuller matrix of tasks 14.9 and 14.10 can share it.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.15.
 */

import type { PostingStore } from '../../posting/posting.repository';
import type { JobPosting } from '../../prisma/prisma.types';

/** The columns a caller seeds on a Job_Posting; everything else takes its declared default. */
export type SeedPosting = Partial<JobPosting> & Pick<JobPosting, 'id'>;

/** The `where` of the candidate query, as the stage sends it. */
interface CandidateWhere {
  readonly lastSeenAt?: Date;
  readonly relevanceSetManually?: boolean;
}

/** A stand-in `JobPosting` store with its rows and its recorded writes. */
export interface RelevanceStoreFixture {
  readonly store: PostingStore;
  /** Every `JobPosting.id` that was written, in order. */
  readonly writes: readonly string[];
  /** Seeds a row as if the retrieval phase of this Scrape_Run had written it. */
  seedPosting(posting: SeedPosting): JobPosting;
  /** The stored row of one identifier, or `undefined`. */
  postingOf(id: string): JobPosting | undefined;
  /** Makes the next `update` reject, to drive the contained write failure of the stage. */
  failNextWrite(error: unknown): void;
  /** Makes every `findMany` reject, to drive the rejected candidate query. */
  failReads(error: unknown): void;
}

/** The column defaults `schema.prisma` declares for a Job_Posting. */
const postingDefaults = (id: string): JobPosting => ({
  id,
  platform: 'STEPSTONE',
  postingId: `posting-${id}`,
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

/** Applies the `orderBy` of the candidate query to the matched rows. */
const sortRows = (
  rows: readonly JobPosting[],
  orderBy: readonly Record<string, 'asc' | 'desc'>[] | undefined,
): readonly JobPosting[] => {
  const terms = (orderBy ?? []).flatMap((term) => Object.entries(term));

  return [...rows].sort((left, right) => {
    for (const [field, direction] of terms) {
      const leftValue = left[field as keyof JobPosting];
      const rightValue = right[field as keyof JobPosting];
      const a = leftValue instanceof Date ? leftValue.toISOString() : String(leftValue);
      const b = rightValue instanceof Date ? rightValue.toISOString() : String(rightValue);

      if (a !== b) {
        return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
    }

    return 0;
  });
};

/** Creates the stand-in `JobPosting` store of the relevance enrichment stage. */
export const createRelevanceStore = (): RelevanceStoreFixture => {
  const postings = new Map<string, JobPosting>();
  const writes: string[] = [];
  let pendingWriteFailure: { readonly error: unknown } | null = null;
  let readFailure: { readonly error: unknown } | null = null;

  const takeWriteFailure = (): void => {
    if (pendingWriteFailure === null) {
      return;
    }

    const { error } = pendingWriteFailure;

    pendingWriteFailure = null;

    throw error;
  };

  const store: PostingStore = {
    jobPosting: {
      findMany: ({
        where,
        orderBy,
      }: {
        where?: CandidateWhere;
        orderBy?: readonly Record<string, 'asc' | 'desc'>[];
      } = {}) => {
        if (readFailure !== null) {
          return Promise.reject(readFailure.error);
        }

        const matches = [...postings.values()].filter(
          (row) =>
            (where?.lastSeenAt === undefined ||
              row.lastSeenAt.getTime() === where.lastSeenAt.getTime()) &&
            (where?.relevanceSetManually === undefined ||
              row.relevanceSetManually === where.relevanceSetManually),
        );

        return Promise.resolve(sortRows(matches, orderBy));
      },

      update: ({ where, data }: { where: { id: string }; data: Partial<JobPosting> }) => {
        takeWriteFailure();

        const existing = postings.get(where.id);

        if (existing === undefined) {
          throw new Error(`No JobPosting with id ${where.id}`);
        }

        const row: JobPosting = { ...existing, ...data };

        postings.set(row.id, row);
        writes.push(row.id);

        return Promise.resolve(row);
      },
      // The delegate carries far more methods than the stage and the repository call; only the two
      // above are modelled, and the cast is what keeps the fixture to the surface under test.
    } as unknown as PostingStore['jobPosting'],
  };

  return {
    store,
    writes,
    seedPosting: (posting) => {
      const row: JobPosting = { ...postingDefaults(posting.id), ...posting };

      postings.set(row.id, row);

      return row;
    },
    postingOf: (id) => postings.get(id),
    failNextWrite: (error) => {
      pendingWriteFailure = { error };
    },
    failReads: (error) => {
      readFailure = { error };
    },
  };
};
