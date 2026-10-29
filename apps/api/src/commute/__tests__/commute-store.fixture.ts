/**
 * In-memory stand-ins for everything `CommuteService` depends on: the three Posting_Store delegates
 * of the cache chain, the Routing_Provider and the AI_Provider normalization.
 *
 * `CommuteService` narrows its store dependency to
 * `Pick<PrismaService, 'jobPosting' | 'commuteCacheEntry' | 'locationNormalization'>`, which is
 * what lets the whole attempt chain of 8.5 to 8.9 be driven without a database and without a
 * network: the decisions under test are the real ones, only the storage is a map and the providers
 * are functions.
 *
 * Three behaviours have to be faithful for the tests to mean anything:
 *
 * - **The compound cache key.** `commuteCacheEntry` is looked up by (Home_Address, latitude,
 *   longitude, mode), and the coordinates arrive as numbers that PostgreSQL would store as
 *   `Decimal(9, 4)`. The fixture keys on the four-decimal form, so a service that forgot to round
 *   misses the entry here exactly as it would against the real column.
 * - **Rows read back as `Decimal`.** `LocationNormalization.lat` and `.lon` come out of the client
 *   as `Prisma.Decimal`, not as numbers, so the fixture stores them that way. A service that treated
 *   them as numbers would pass against a sloppier stand-in and fail in production.
 * - **Counted provider calls.** The bounds the requirements state — at most three attempts per query
 *   (8.8), at most one AI_Provider request per distinct work location (8.7), no query at all on a
 *   cache hit (8.9) — are statements about call counts, so every call is recorded in order.
 *
 * - **Merging row updates.** The commute write of task 13.5 names seven columns; the fixture merges
 *   them into the stored row, so a column it must not touch — the Interest_Flag, the relevance
 *   assessment, the content fields of the retrieval — shows up as its old value and not as
 *   `undefined`.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern, so the unit suite of this
 * task and the fuller matrix of task 13.9 can share it.
 *
 * Requirements: 8.2, 8.5, 8.6, 8.7, 8.8, 8.9.
 */

import type { CommuteMode } from '@job-scraper/domain';

import type { PostingStore } from '../../posting/posting.repository';
import type {
  CommuteCacheEntry,
  JobPosting,
  LocationNormalization,
} from '../../prisma/prisma.types';
import { Prisma } from '../../prisma/prisma.types';
import type { CommuteStore } from '../commute.service';
import type { LocationNormalizationOutcome, LocationNormalizer } from '../location-normalizer.port';
import type {
  GeocodeResult,
  RoutingProvider,
  TravelDurationRequest,
} from '../routing-provider.port';

/** The columns a caller seeds on a Job_Posting; everything else takes its declared default. */
export type SeedPosting = Partial<JobPosting> & Pick<JobPosting, 'id'>;

/** A cache entry as a test states it: numbers in, `Decimal` out, expiry explicit (8.9). */
export interface SeedCacheEntry {
  readonly homeAddress: string;
  readonly lat: number;
  readonly lon: number;
  readonly mode: CommuteMode;
  readonly minutes: number | null;
  readonly precision?: CommuteCacheEntry['precision'];
  readonly expiresAt: Date;
}

/** A stored normalization as a test states it (8.6, 8.7). */
export interface SeedNormalization {
  readonly rawLocation: string;
  readonly normalizedName: string | null;
  readonly lat?: number;
  readonly lon?: number;
  readonly precision?: LocationNormalization['precision'];
  readonly source: LocationNormalization['source'];
}

/** One recorded write, so a test can assert what the chain persisted and what it did not. */
export interface RecordedWrite {
  readonly table: 'commuteCacheEntry' | 'locationNormalization' | 'jobPosting';
  readonly key: string;
}

/** A stand-in Posting_Store with its rows and its recorded writes. */
export interface CommuteStoreFixture {
  /**
   * The stand-in client.
   *
   * Typed as both narrowed dependencies, because the enrichment stage of task 13.5 drives the
   * Commute_Service and the `PostingRepository` against the same stored rows — which is the point:
   * a determination and the row it is written to cannot drift apart in a test either.
   */
  readonly store: CommuteStore & PostingStore;
  readonly cacheEntries: Map<string, CommuteCacheEntry>;
  readonly normalizations: Map<string, LocationNormalization>;
  readonly writes: readonly RecordedWrite[];
  seedPosting(posting: SeedPosting): JobPosting;
  seedCacheEntry(entry: SeedCacheEntry): void;
  seedNormalization(row: SeedNormalization): void;
  /** The stored Job_Posting row of one identifier, or `undefined`. */
  postingOf(id: string): JobPosting | undefined;
  /** Makes the next `JobPosting` update reject, to drive the contained-failure path of 9.9. */
  failNextPostingWrite(error: unknown): void;
  /** The stored normalization of one free-text work location, or `undefined`. */
  normalizationOf(rawLocation: string): LocationNormalization | undefined;
  /** The stored cache entry of one key, or `undefined`. */
  cacheEntryOf(
    homeAddress: string,
    lat: number,
    lon: number,
    mode: CommuteMode,
  ): CommuteCacheEntry | undefined;
}

/** The four-decimal key of a cache entry, mirroring `Decimal(9, 4)` in the schema. */
const cacheKeyOf = (homeAddress: string, lat: number, lon: number, mode: CommuteMode): string =>
  [homeAddress, lat.toFixed(4), lon.toFixed(4), mode].join('|');

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

/** A `Decimal` as the generated client hands one back, or `null`. */
const decimalOrNull = (value: number | undefined): Prisma.Decimal | null =>
  value === undefined ? null : new Prisma.Decimal(value.toFixed(4));

/** Applies the `orderBy` of the candidate query to the matched rows. */
const sortRows = (
  rows: readonly JobPosting[],
  orderBy: readonly Record<string, 'asc' | 'desc'>[] | undefined,
): readonly JobPosting[] => {
  const terms = (orderBy ?? []).flatMap((term) => Object.entries(term));

  return [...rows].sort((left, right) => {
    for (const [field, direction] of terms) {
      const a = String(left[field as keyof JobPosting]);
      const b = String(right[field as keyof JobPosting]);

      if (a !== b) {
        return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
    }

    return 0;
  });
};

/** Creates the stand-in Posting_Store of the Commute_Service. */
export const createCommuteStore = (): CommuteStoreFixture => {
  const postings = new Map<string, JobPosting>();
  const cacheEntries = new Map<string, CommuteCacheEntry>();
  const normalizations = new Map<string, LocationNormalization>();
  const writes: RecordedWrite[] = [];
  let pendingFailure: { readonly error: unknown } | null = null;

  /** Raises the rejection a test armed, once. */
  const takeFailure = (): void => {
    if (pendingFailure === null) {
      return;
    }

    const { error } = pendingFailure;

    pendingFailure = null;

    throw error;
  };

  interface CacheKeyWhere {
    readonly homeAddress_lat_lon_mode: {
      readonly homeAddress: string;
      readonly lat: number;
      readonly lon: number;
      readonly mode: CommuteMode;
    };
  }

  const keyOf = (where: CacheKeyWhere): string => {
    const { homeAddress, lat, lon, mode } = where.homeAddress_lat_lon_mode;

    return cacheKeyOf(homeAddress, lat, lon, mode);
  };

  const store: CommuteStore & PostingStore = {
    jobPosting: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(postings.get(where.id) ?? null),

      // The candidate query of the enrichment stage: the Job_Posting whose last sighting is the
      // start time of the running Scrape_Run (9.3), in the stage's deterministic order.
      findMany: ({
        where,
        orderBy,
      }: {
        where?: { lastSeenAt?: Date };
        orderBy?: readonly Record<string, 'asc' | 'desc'>[];
      } = {}) => {
        const matches = [...postings.values()].filter(
          (row) =>
            where?.lastSeenAt === undefined ||
            row.lastSeenAt.getTime() === where.lastSeenAt.getTime(),
        );

        return Promise.resolve(sortRows(matches, orderBy).map((row) => ({ id: row.id })));
      },

      // The commute write of task 13.5. Merges `data` into the stored row, so a column the write
      // does not mention is observably unchanged rather than `undefined`.
      update: ({ where, data }: { where: { id: string }; data: Partial<JobPosting> }) => {
        takeFailure();

        const existing = postings.get(where.id);

        if (existing === undefined) {
          throw new Error(`No JobPosting with id ${where.id}`);
        }

        const row: JobPosting = { ...existing, ...data };

        postings.set(row.id, row);
        writes.push({ table: 'jobPosting', key: row.id });

        return Promise.resolve(row);
      },
    } as unknown as CommuteStore['jobPosting'],

    commuteCacheEntry: {
      findUnique: ({ where }: { where: CacheKeyWhere }) =>
        Promise.resolve(cacheEntries.get(keyOf(where)) ?? null),

      upsert: ({
        where,
        create,
      }: {
        where: CacheKeyWhere;
        create: {
          homeAddress: string;
          lat: number;
          lon: number;
          mode: CommuteMode;
          minutes: number | null;
          precision: CommuteCacheEntry['precision'];
          createdAt: Date;
          expiresAt: Date;
        };
      }) => {
        const key = keyOf(where);
        const row: CommuteCacheEntry = {
          id: key,
          homeAddress: create.homeAddress,
          lat: new Prisma.Decimal(create.lat.toFixed(4)),
          lon: new Prisma.Decimal(create.lon.toFixed(4)),
          mode: create.mode,
          minutes: create.minutes,
          precision: create.precision,
          createdAt: create.createdAt,
          expiresAt: create.expiresAt,
        };

        cacheEntries.set(key, row);
        writes.push({ table: 'commuteCacheEntry', key });

        return Promise.resolve(row);
      },
    } as unknown as CommuteStore['commuteCacheEntry'],

    locationNormalization: {
      findUnique: ({ where }: { where: { rawLocation: string } }) =>
        Promise.resolve(normalizations.get(where.rawLocation) ?? null),

      upsert: ({
        where,
        create,
      }: {
        where: { rawLocation: string };
        create: {
          rawLocation: string;
          normalizedName: string | null;
          lat: number | null;
          lon: number | null;
          precision: LocationNormalization['precision'];
          source: LocationNormalization['source'];
        };
      }) => {
        const row: LocationNormalization = {
          rawLocation: create.rawLocation,
          normalizedName: create.normalizedName,
          lat: decimalOrNull(create.lat ?? undefined),
          lon: decimalOrNull(create.lon ?? undefined),
          precision: create.precision,
          source: create.source,
          createdAt: new Date(0),
        };

        normalizations.set(where.rawLocation, row);
        writes.push({ table: 'locationNormalization', key: where.rawLocation });

        return Promise.resolve(row);
      },
    } as unknown as CommuteStore['locationNormalization'],
  };

  return {
    store,
    cacheEntries,
    normalizations,
    writes,
    seedPosting: (posting) => {
      const row: JobPosting = { ...postingDefaults(posting.id), ...posting };

      postings.set(row.id, row);

      return row;
    },
    seedCacheEntry: (entry) => {
      const key = cacheKeyOf(entry.homeAddress, entry.lat, entry.lon, entry.mode);

      cacheEntries.set(key, {
        id: key,
        homeAddress: entry.homeAddress,
        lat: new Prisma.Decimal(entry.lat.toFixed(4)),
        lon: new Prisma.Decimal(entry.lon.toFixed(4)),
        mode: entry.mode,
        minutes: entry.minutes,
        precision: entry.precision ?? 'EXACT',
        createdAt: new Date(0),
        expiresAt: entry.expiresAt,
      });
    },
    seedNormalization: (row) => {
      normalizations.set(row.rawLocation, {
        rawLocation: row.rawLocation,
        normalizedName: row.normalizedName,
        lat: decimalOrNull(row.lat),
        lon: decimalOrNull(row.lon),
        precision: row.precision ?? (row.normalizedName === null ? 'UNKNOWN' : 'EXACT'),
        source: row.source,
        createdAt: new Date(0),
      });
    },
    normalizationOf: (rawLocation) => normalizations.get(rawLocation),
    cacheEntryOf: (homeAddress, lat, lon, mode) =>
      cacheEntries.get(cacheKeyOf(homeAddress, lat, lon, mode)),
    postingOf: (id) => postings.get(id),
    failNextPostingWrite: (error) => {
      pendingFailure = { error };
    },
  };
};

/** What a test wants the Routing_Provider to answer, and what it actually was asked. */
export interface RoutingStub {
  readonly provider: RoutingProvider;
  /** Every geocoding query in order (8.8 counts attempts). */
  readonly geocodeCalls: readonly string[];
  /** Every duration query in order, including its mode and arrival reference point (8.1). */
  readonly durationCalls: readonly TravelDurationRequest[];
}

/** The answers a {@link RoutingStub} gives. An omitted answer is `null`: "nothing determined". */
export interface RoutingAnswers {
  /** Answer per geocoding query; `attempt` is 1-based over all geocoding calls. */
  readonly geocode?: (query: string, attempt: number) => GeocodeResult | null;
  /** Answer per duration query; `attempt` is 1-based over all duration calls. */
  readonly duration?: (request: TravelDurationRequest, attempt: number) => number | null;
}

/** A Routing_Provider that answers from the given functions and records every query. */
export const stubRouting = (answers: RoutingAnswers = {}): RoutingStub => {
  const geocodeCalls: string[] = [];
  const durationCalls: TravelDurationRequest[] = [];

  const provider: RoutingProvider = {
    name: 'stub',
    geocode: (freeTextLocation) => {
      geocodeCalls.push(freeTextLocation);

      return Promise.resolve(answers.geocode?.(freeTextLocation, geocodeCalls.length) ?? null);
    },
    travelDurationMinutes: (request) => {
      durationCalls.push(request);

      return Promise.resolve(answers.duration?.(request, durationCalls.length) ?? null);
    },
  };

  return { provider, geocodeCalls, durationCalls };
};

/** A geocoding answer, for the stub above. */
export const geocoded = (
  lat: number,
  lon: number,
  precision: GeocodeResult['precision'] = 'EXACT',
  resolvedName = 'Stub, München, Deutschland',
): GeocodeResult => ({ coordinate: { lat, lon }, precision, resolvedName });

/** What a test wants the AI_Provider normalization to answer, and how often it was asked (8.7). */
export interface NormalizerStub {
  readonly normalizer: LocationNormalizer;
  readonly calls: readonly string[];
}

/** A {@link LocationNormalizer} that answers from the given function and records every request. */
export const stubNormalizer = (
  answer: (rawLocation: string, call: number) => LocationNormalizationOutcome,
): NormalizerStub => {
  const calls: string[] = [];

  return {
    normalizer: {
      name: 'stub',
      normalize: (rawLocation) => {
        calls.push(rawLocation);

        return Promise.resolve(answer(rawLocation, calls.length));
      },
    },
    calls,
  };
};
