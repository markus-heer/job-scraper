/**
 * Property 25 of the job-search-tool design: sorting is a total order and places unknown values and
 * new postings correctly.
 *
 * The subject is `postingOrderByOf` of `../posting-page-query`, the one place the order of 10.7 is
 * decided, together with `newFirstGroupingFor` of `../new-marking` for the default grouping of 11.3.
 * Both are pure, and both answer in Prisma's vocabulary rather than with a sorted list — so this
 * property needs two things the example tests of `./posting-page-query.test.ts` do not have:
 * something that *runs* an emitted `orderBy`, and an independent comparator to run it against.
 *
 * **How the order is evaluated.** In memory, by an interpreter of the emitted `orderBy` terms that
 * models the `ORDER BY` semantics of PostgreSQL: a term names a column with a direction, `nulls`
 * places missing values at the end or at the head of the output regardless of that direction, an
 * absent `nulls` takes the engine's own default (last ascending, first descending), equal keys fall
 * through to the next term, and the terms are applied left to right. The interpreter knows nothing
 * about which column means what — it reads whatever the subject emitted, and it refuses a column
 * outside the sortable set, so an order by the `relevanceVerdict` enum instead of by `relevanceRank`
 * fails loudly here rather than passing quietly.
 *
 * The alternative was to drive `PostingRepository.findPage` against real PostgreSQL in
 * `pnpm test:integration`. Not taken, for a reason rather than for convenience: the engine half of
 * these claims is already pinned there by `./posting.repository.find-page.integration.test.ts` —
 * unknown values last in both directions, the verdict order out of the stored rank, and the
 * agreement of `relevanceRank` with the rank table for every verdict value, all against real SQL.
 * What that file cannot do is quantify. It starts a container per file and runs its files
 * sequentially, while this property sorts a hundred generated row sets under eight orders, and the
 * quality gate runs `pnpm test`, which has to stay offline and fast. So the engine's behaviour is
 * asserted once against the engine, and the order is quantified here against a model of it. The
 * residual risk is named rather than hidden: if PostgreSQL disagreed with the model, this file would
 * not notice it — the integration file is what notices.
 *
 * **What it is compared against.** A reference comparator written from the sentence of 10.7 and from
 * nothing else: the chosen key, the chosen direction, a row whose value is unknown last in *both*
 * directions, the verdict positions spelled out as "relevant before uncertain before not assessed
 * before not relevant", and the identifier ascending as the last resort. The reference deliberately
 * does not read `RELEVANCE_RANK`: that table is how the subject implements the verdict order, so a
 * reference reading it could not tell a wrong table from a right one.
 *
 * Two deviations from the design's generator, both towards more coverage. The four sort fields and
 * the two directions are enumerated rather than drawn, because that quantifier ranges over exactly
 * eight values and exhausting it is stronger than sampling it. And the returned order is compared
 * against the reference order in full, which implies the "non-decreasing" the design's oracle asks
 * for; the positional clauses about unknown values, the verdict order and the grouping are asserted
 * separately anyway, so a failure says which clause broke.
 *
 * Requirements: 10.7, 11.3.
 */

// Feature: job-search-tool, Property 25 - Sorting is a total order and places unknown values and new postings correctly

import { RELEVANCE_RANK, RELEVANCE_VERDICTS, type RelevanceVerdict } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JobPosting, Prisma } from '../../prisma/prisma.types';
import { newFirstGroupingFor } from '../new-marking';
import { postingOrderByOf, type PostingSort, type PostingSortField } from '../posting-page-query';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The columns the order of 10.7 and the grouping of 11.3 read, and nothing else. */
type SortableRow = Pick<
  JobPosting,
  | 'id'
  | 'firstSeenAt'
  | 'publishedAt'
  | 'bestCommuteMinutes'
  | 'relevanceVerdict'
  | 'relevanceRank'
  | 'firstSeenRunId'
>;

/** The four sort keys of 10.7. */
const SORT_FIELDS: readonly PostingSortField[] = [
  'FIRST_SEEN_AT',
  'PUBLISHED_AT',
  'BEST_COMMUTE_MINUTES',
  'RELEVANCE',
];

/** The eight orders 10.7 offers: every key in both directions. */
const SORTS: readonly PostingSort[] = SORT_FIELDS.flatMap((field) =>
  (['ASC', 'DESC'] as const).map((direction) => ({ field, direction })),
);

/** The sorting in force when the user chose none, read from 10.7: recording time descending. */
const REQUIRED_DEFAULT_SORT: PostingSort = { field: 'FIRST_SEEN_AT', direction: 'DESC' };

/** Whether a sorting is the default one, which is the "no deviating sorting" of 11.3. */
const isDefaultSort = (sort: PostingSort): boolean =>
  sort.field === REQUIRED_DEFAULT_SORT.field && sort.direction === REQUIRED_DEFAULT_SORT.direction;

/**
 * The verdict order of 10.7, written from the requirement and not read from `RELEVANCE_RANK`.
 *
 * "relevant before uncertain before not assessed before not relevant" — the rank table is the
 * subject's implementation of this order, so the oracle has to state it independently.
 */
const VERDICT_POSITION: Readonly<Record<RelevanceVerdict, number>> = {
  RELEVANT: 0,
  UNCERTAIN: 1,
  NOT_ASSESSED: 2,
  NOT_RELEVANT: 3,
};

/* -------------------------------------------------------------------------- *
 * Running an emitted `orderBy`
 * -------------------------------------------------------------------------- */

/** The columns an emitted `orderBy` term may name. */
const SORTABLE_COLUMNS = [
  'id',
  'firstSeenAt',
  'publishedAt',
  'bestCommuteMinutes',
  'relevanceRank',
] as const;

type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

const isSortableColumn = (value: string): value is SortableColumn =>
  (SORTABLE_COLUMNS as readonly string[]).includes(value);

/** A sort direction in Prisma's and SQL's spelling. */
type SqlDirection = 'asc' | 'desc';

/** Where missing values end up in the output, which is what `nulls` names. */
type NullPlacement = 'first' | 'last';

/** Where PostgreSQL puts missing values when the order names no placement. */
const ENGINE_DEFAULT_NULLS: Readonly<Record<SqlDirection, NullPlacement>> = {
  asc: 'last',
  desc: 'first',
};

/** One emitted `orderBy` term, read into the three things it says. */
interface OrderTerm {
  readonly column: SortableColumn;
  readonly direction: SqlDirection;
  readonly nulls: NullPlacement;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const asDirection = (value: unknown): SqlDirection | null =>
  value === 'asc' || value === 'desc' ? value : null;

const asNullPlacement = (value: unknown): NullPlacement | null =>
  value === 'first' || value === 'last' ? value : null;

/**
 * Reads one emitted `orderBy` term.
 *
 * Throws on everything the read path must not emit — a term naming no column or two, a column
 * outside the sortable set, a term without a direction. A thrown error fails the property with the
 * offending term in its message, which is the point: an order this interpreter cannot run is an
 * order whose meaning nobody has stated.
 */
const orderTermOf = (term: Prisma.JobPostingOrderByWithRelationInput): OrderTerm => {
  const entries = Object.entries(term as Record<string, unknown>);
  const only = entries.at(0);

  if (entries.length !== 1 || only === undefined) {
    throw new Error(`An orderBy term must name exactly one column: ${JSON.stringify(term)}`);
  }

  const [column, condition] = only;

  if (!isSortableColumn(column)) {
    throw new Error(`The posting overview must not sort by the column ${column}`);
  }

  const bare = asDirection(condition);

  if (bare !== null) {
    return { column, direction: bare, nulls: ENGINE_DEFAULT_NULLS[bare] };
  }

  const nested = asRecord(condition);
  const direction = asDirection(nested?.sort);

  if (nested === null || direction === null) {
    throw new Error(`The orderBy term for ${column} carries no direction: ${JSON.stringify(term)}`);
  }

  return {
    column,
    direction,
    nulls: asNullPlacement(nested.nulls) ?? ENGINE_DEFAULT_NULLS[direction],
  };
};

/** The stored value of one sortable column, or `null` where the row carries none. */
type ColumnValue = Date | number | string | null;

const columnValueOf = (row: SortableRow, column: SortableColumn): ColumnValue => {
  switch (column) {
    case 'id':
      return row.id;
    case 'firstSeenAt':
      return row.firstSeenAt;
    case 'publishedAt':
      return row.publishedAt;
    case 'bestCommuteMinutes':
      return row.bestCommuteMinutes;
    case 'relevanceRank':
      return row.relevanceRank;
  }
};

/** Compares two present values of one column, by type, as the engine compares them. */
const compareColumnValues = (
  left: Exclude<ColumnValue, null>,
  right: Exclude<ColumnValue, null>,
): number => {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  throw new Error('Two values of one column must share one type');
};

/** A strict order over rows: negative, zero or positive as the left row sorts before, with or after. */
type RowComparator = (left: SortableRow, right: SortableRow) => number;

/**
 * The emitted `orderBy` as a comparator, modelling PostgreSQL's `ORDER BY`.
 *
 * The terms are read once, so a comparison costs no parsing: this runs over every triple of the
 * generated set for every one of the eight orders.
 */
const comparatorOf = (
  orderBy: readonly Prisma.JobPostingOrderByWithRelationInput[],
): RowComparator => {
  const terms = orderBy.map(orderTermOf);

  return (left, right) => {
    for (const term of terms) {
      const leftValue = columnValueOf(left, term.column);
      const rightValue = columnValueOf(right, term.column);

      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) {
          // Equal keys: the next term decides, as in SQL.
          continue;
        }

        // `nulls` is a statement about the output position, so the direction does not flip it.
        const missingGoes = term.nulls === 'last' ? 1 : -1;

        return leftValue === null ? missingGoes : -missingGoes;
      }

      const ordered = compareColumnValues(leftValue, rightValue);

      if (ordered !== 0) {
        return term.direction === 'asc' ? ordered : -ordered;
      }
    }

    return 0;
  };
};

/* -------------------------------------------------------------------------- *
 * The order 10.7 asks for
 * -------------------------------------------------------------------------- */

/** The "at the end of the list" of 10.7: an unknown value sorts last whichever direction is asked for. */
const compareUnknownLast = (left: number | null, right: number | null, sign: number): number => {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return sign * (left - right);
};

const millisOf = (value: Date | null): number | null => (value === null ? null : value.getTime());

/**
 * The order 10.7 prescribes, derived from the requirement rather than from the subject.
 *
 * The one clause not in 10.7 is the publication date: the requirement is silent about a Job_Posting
 * without a readable one, and the read path places it like the unknown commute times, at the end in
 * both directions. That decision is documented at `postingOrderByOf`; the reference restates it so
 * that a change of mind shows up here as a failing property rather than as a silently accepted
 * order. The identifier is the last resort, which is what makes the order total.
 */
const referenceComparatorOf = (sort: PostingSort): RowComparator => {
  const sign = sort.direction === 'ASC' ? 1 : -1;

  return (left, right) => {
    const keyed = ((): number => {
      switch (sort.field) {
        case 'FIRST_SEEN_AT':
          return sign * (left.firstSeenAt.getTime() - right.firstSeenAt.getTime());
        case 'PUBLISHED_AT':
          return compareUnknownLast(millisOf(left.publishedAt), millisOf(right.publishedAt), sign);
        case 'BEST_COMMUTE_MINUTES':
          return compareUnknownLast(left.bestCommuteMinutes, right.bestCommuteMinutes, sign);
        case 'RELEVANCE':
          return (
            sign *
            (VERDICT_POSITION[left.relevanceVerdict] - VERDICT_POSITION[right.relevanceVerdict])
          );
      }
    })();

    return keyed !== 0 ? keyed : compareColumnValues(left.id, right.id);
  };
};

/**
 * Whether a row falls into one of the two groups of the default grouping (11.3, 11.6).
 *
 * Only the filter shapes `newFirstGroups` can produce are understood: an equality on
 * `firstSeenRunId`, its negation, the empty `{ id: { in: [] } }` and the unrestricted `{}`. Anything
 * else throws instead of being guessed at, so a grouping that started filtering on something else
 * fails the property rather than being evaluated by a charitable reading.
 */
const matchesGroup = (where: Prisma.JobPostingWhereInput, row: SortableRow): boolean =>
  Object.entries(where as Record<string, unknown>).every(([column, condition]) => {
    if (column === 'firstSeenRunId') {
      if (typeof condition === 'string') {
        return row.firstSeenRunId === condition;
      }

      const negated = asRecord(condition)?.not;

      if (typeof negated === 'string') {
        return row.firstSeenRunId !== negated;
      }

      throw new Error(`Unreadable group filter on firstSeenRunId: ${JSON.stringify(condition)}`);
    }

    if (column === 'id') {
      const members = asRecord(condition)?.in;

      if (Array.isArray(members)) {
        return members.includes(row.id);
      }

      throw new Error(`Unreadable group filter on id: ${JSON.stringify(condition)}`);
    }

    throw new Error(`The default grouping must not filter on ${column}`);
  });

/* -------------------------------------------------------------------------- *
 * Generators
 * -------------------------------------------------------------------------- */

/** The instant every generated recording and publication time is an offset from. */
const BASE_INSTANT = new Date('2026-03-01T06:00:00.000Z');

/** Minutes after {@link BASE_INSTANT}, drawn from four values so both time keys have ties. */
const instantArbitrary = fc
  .nat({ max: 3 })
  .map((offsetMinutes) => new Date(BASE_INSTANT.getTime() + offsetMinutes * 60_000));

/** The Scrape_Run of first recording, drawn from three so both groups of 11.3 are populated. */
const RUN_IDS = ['run-1', 'run-2', 'run-3'] as const;

/**
 * One stored Job_Posting, reduced to the columns the order reads.
 *
 * Every key is drawn from a small pool, which is what produces the ties the design's generator asks
 * for: without ties the tiebreaker is never reached and a non-total order would pass. The commute
 * minutes and the publication date are missing part of the time — the "unknown" of 8.13 and the
 * unreadable publication date of 6.4 — and `relevanceRank` is derived from the verdict through the
 * rank table, which is how both relevance writers write it.
 */
const rowArbitrary = (id: string): fc.Arbitrary<SortableRow> =>
  fc
    .record({
      firstSeenAt: instantArbitrary,
      publishedAt: fc.option(instantArbitrary, { nil: null }),
      bestCommuteMinutes: fc.option(fc.constantFrom(15, 30, 60, 61), { nil: null }),
      relevanceVerdict: fc.constantFrom(...RELEVANCE_VERDICTS),
      firstSeenRunId: fc.constantFrom(...RUN_IDS),
    })
    .map((columns) => ({
      ...columns,
      id,
      relevanceRank: RELEVANCE_RANK[columns.relevanceVerdict],
    }));

/**
 * One to six stored Job_Posting with distinct identifiers.
 *
 * The identifiers are drawn independently of the position a row has in the generated list, so the
 * order the subject produces cannot coincide with the order the rows were generated in. Six rows
 * keep every triple of the set checkable without sampling.
 */
const rowsArbitrary: fc.Arbitrary<readonly SortableRow[]> = fc
  .uniqueArray(fc.nat({ max: 99 }), { minLength: 1, maxLength: 6 })
  .chain((numbers) =>
    fc.tuple(
      ...numbers.map((number) => rowArbitrary(`posting-${String(number).padStart(2, '0')}`)),
    ),
  );

/** The most recently completed Scrape_Run: one of the generated ones, one without postings, or none (11.6). */
const latestCompletedRunIdArbitrary = fc.constantFrom<string | null>(
  ...RUN_IDS,
  'run-without-postings',
  null,
);

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

const sortRows = (rows: readonly SortableRow[], compare: RowComparator): readonly SortableRow[] =>
  [...rows].sort(compare);

const idsOf = (rows: readonly SortableRow[]): readonly string[] => rows.map((row) => row.id);

/** The identifiers of a list in a canonical order, for comparing two lists as sets. */
const idSetOf = (rows: readonly SortableRow[]): readonly string[] => [...idsOf(rows)].sort();

/** The consecutive pairs of an ordered list, so a positional check needs no index arithmetic. */
const consecutivePairs = (
  rows: readonly SortableRow[],
): readonly { readonly left: SortableRow; readonly right: SortableRow }[] => {
  const pairs: { readonly left: SortableRow; readonly right: SortableRow }[] = [];
  let left: SortableRow | null = null;

  for (const right of rows) {
    if (left !== null) {
      pairs.push({ left, right });
    }

    left = right;
  }

  return pairs;
};

/** Asserts that every row the predicate holds for precedes every row it does not. */
const expectLeadingGroup = (
  rows: readonly SortableRow[],
  holds: (row: SortableRow) => boolean,
): void => {
  const flags = rows.map(holds);
  const leading = flags.filter(Boolean).length;

  expect(flags).toEqual(flags.map((_flag, index) => index < leading));
};

describe('Property 25: Sorting is a total order and places unknown values and new postings correctly', () => {
  /**
   * **Validates: Requirements 10.7**
   *
   * For all sets of Job_Posting, for all four sort fields and for all two directions, the returned
   * list is sorted by the comparator 10.7 describes: the chosen key in the chosen direction, a
   * Job_Posting with an unknown Best_Commute_Time at the end in both directions, the
   * Relevance_Verdict as relevant before uncertain before not assessed before not relevant, and the
   * identifier as the last resort.
   *
   * Six statements per order. The returned order equals the reference order and is a permutation of
   * the input, so nothing is lost or duplicated on the way. It is *strictly* increasing under its
   * own comparator, which is the total order the pagination of 10.9 rests on — without the
   * tiebreaker two rows with equal keys would compare equal and a page boundary could fall between
   * two rows nothing distinguishes. The comparator satisfies the three order laws over every triple
   * of the generated set. And the two positional clauses 10.7 is explicit about hold where they
   * apply.
   */
  it('returns every order of 10.7 as the total order the requirement describes', () => {
    fc.assert(
      fc.property(rowsArbitrary, (rows) => {
        // The generated rows carry the sort key the way both relevance writers write it; the whole
        // verdict order of 10.7 rests on that coupling (10.7).
        for (const row of rows) {
          expect(row.relevanceRank).toBe(RELEVANCE_RANK[row.relevanceVerdict]);
        }

        for (const sort of SORTS) {
          const compare = comparatorOf(postingOrderByOf(sort));
          const order = sortRows(rows, compare);

          // The order 10.7 asks for, entry for entry.
          expect(idsOf(order)).toEqual(idsOf(sortRows(rows, referenceComparatorOf(sort))));

          // Every generated Job_Posting, exactly once.
          expect(idSetOf(order)).toEqual(idSetOf(rows));

          // Strictly increasing: non-decreasing, and total because no adjacent pair compares equal.
          expect(
            consecutivePairs(order).filter(({ left, right }) => compare(left, right) >= 0),
          ).toEqual([]);

          // Antisymmetric, transitive, and equal only for one and the same Job_Posting.
          const lawViolations: string[] = [];

          for (const first of rows) {
            for (const second of rows) {
              const forward = Math.sign(compare(first, second));

              if (forward !== -Math.sign(compare(second, first))) {
                lawViolations.push(`not antisymmetric: ${first.id} / ${second.id}`);
              }

              if ((forward === 0) !== (first.id === second.id)) {
                lawViolations.push(`not a total order: ${first.id} / ${second.id}`);
              }

              for (const third of rows) {
                if (forward < 0 && compare(second, third) < 0 && compare(first, third) >= 0) {
                  lawViolations.push(`not transitive: ${first.id} / ${second.id} / ${third.id}`);
                }
              }
            }
          }

          expect(lawViolations).toEqual([]);

          // An unknown Best_Commute_Time at the end of the list, in both directions (10.7); the
          // same for a missing publication date, which is the decision documented at
          // `postingOrderByOf`.
          if (sort.field === 'BEST_COMMUTE_MINUTES') {
            expectLeadingGroup(order, (row) => row.bestCommuteMinutes !== null);
          }

          if (sort.field === 'PUBLISHED_AT') {
            expectLeadingGroup(order, (row) => row.publishedAt !== null);
          }

          // relevant before uncertain before not assessed before not relevant, reversed when the
          // user asks for the descending direction (10.7).
          if (sort.field === 'RELEVANCE') {
            const sign = sort.direction === 'ASC' ? 1 : -1;

            expect(
              consecutivePairs(order).filter(
                ({ left, right }) =>
                  sign *
                    (VERDICT_POSITION[left.relevanceVerdict] -
                      VERDICT_POSITION[right.relevanceVerdict]) >
                  0,
              ),
            ).toEqual([]);
          }
        }
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 11.3**
   *
   * For all sets of Job_Posting and for all identifiers of the most recently completed Scrape_Run,
   * under the default sorting every Job_Posting marked "neu" appears above every unmarked one, with
   * recording time descending inside both groups. Under any deviating sorting, and while no
   * Scrape_Run has completed (11.6), the list is the plain order of 10.7 — 11.3 scopes the grouping
   * to the case where the user chose no deviating sorting, so a read sorted by anything else must
   * not be regrouped behind the user's back.
   *
   * The grouped list is assembled the way the repository assembles it: the two group filters of
   * `newFirstGroupingFor`, each read in the emitted order, concatenated marked first. Whether a
   * grouping applies at all is the subject's decision; which rows the two filters hold for is
   * evaluated here. The page of that list is Property 26 (task 15.7); this property is about its
   * order.
   */
  it('places every posting marked "neu" above every unmarked one under the default sorting', () => {
    fc.assert(
      fc.property(rowsArbitrary, latestCompletedRunIdArbitrary, (rows, latestCompletedRunId) => {
        for (const sort of SORTS) {
          const compare = comparatorOf(postingOrderByOf(sort));
          const groups = newFirstGroupingFor(sort, latestCompletedRunId);
          const order =
            groups === null
              ? sortRows(rows, compare)
              : [
                  ...sortRows(
                    rows.filter((row) => matchesGroup(groups.marked, row)),
                    compare,
                  ),
                  ...sortRows(
                    rows.filter((row) => matchesGroup(groups.unmarked, row)),
                    compare,
                  ),
                ];

          // The two groups are a partition of the set: the grouping reorders the result, it never
          // changes which Job_Posting are in it.
          expect(idSetOf(order)).toEqual(idSetOf(rows));

          if (!isDefaultSort(sort) || latestCompletedRunId === null) {
            expect(idsOf(order)).toEqual(idsOf(sortRows(rows, referenceComparatorOf(sort))));
            continue;
          }

          const isMarked = (row: SortableRow): boolean =>
            row.firstSeenRunId === latestCompletedRunId;

          // Marked above unmarked (11.3).
          expectLeadingGroup(order, isMarked);

          // Recording time descending inside both groups (11.3), and the concatenation of the two
          // groups in that order.
          const reference = [
            ...sortRows(rows.filter(isMarked), referenceComparatorOf(REQUIRED_DEFAULT_SORT)),
            ...sortRows(
              rows.filter((row) => !isMarked(row)),
              referenceComparatorOf(REQUIRED_DEFAULT_SORT),
            ),
          ];

          expect(idsOf(order)).toEqual(idsOf(reference));

          expect(
            consecutivePairs(order).filter(
              ({ left, right }) =>
                isMarked(left) === isMarked(right) &&
                left.firstSeenAt.getTime() < right.firstSeenAt.getTime(),
            ),
          ).toEqual([]);
        }
      }),
      PROPERTY_RUNS,
    );
  });
});
