/**
 * What the filter bar holds, and the one translation from it into `JobPostingFilterInput` (10.5).
 *
 * Separated from the component on purpose. The interesting part of the filter bar is not its
 * markup, it is the decision which filter member is *sent* and which is *omitted* — and that
 * decision is the difference between a hidden Job_Posting staying hidden and becoming visible
 * again (10.6, 10.11). Here it is a pure function over plain data, so it can be asserted without a
 * DOM, and the route can call it to build the `filter` argument of the `jobPostings` query without
 * reaching into form state.
 *
 * ## "Alle" is not the same as "not set"
 *
 * The read path on the API_Service side (`postingWhereOf` in
 * `apps/api/src/posting/posting-page-query.ts`) reads an absent member and an empty array as "this
 * filter is not set", and for the marking and the Relevance_Verdict filter an unset filter is *not*
 * "everything": it is the default view of 10.6 and 10.11, which hides the Interest_Flag
 * "not interesting" and the Relevance_Verdict "not relevant". An explicit value replaces that
 * exclusion instead of being added to it, which is the whole mechanism behind "keep it displayable
 * again through the filter".
 *
 * Three consequences this module encodes:
 *
 * - For Platform, reachability and Posting_Status, "Alle" and "not set" really do mean the same
 *   thing, so an empty selection omits the member. That is what "default all Platform" (10.5) is.
 * - For marking and Relevance_Verdict they do not. "Alle" sends the **complete** value list, so
 *   {@link DEFAULT_VIEW} — the state the overview opens in — stays reachable as a separate choice.
 *   Sending nothing for them would show the default view while the user had asked for everything.
 * - No member is ever sent as `null`. `postingReadInput` on the API_Service side collapses `null`
 *   into "not set", so a `null` would be read as the default view rather than as "no restriction";
 *   every member here is either present with a value or absent.
 *
 * ## The value lists come from the label maps
 *
 * `de.filters.marking.options` and `de.filters.relevanceVerdict.options` carry
 * `satisfies Readonly<Record<InterestFlag, string>>` and `…<RelevanceVerdict, string>>` in
 * `src/i18n/de.ts`, so their keys are exactly the closed vocabulary — a missing or an extra value
 * fails `check-types` there. Reading the keys is therefore a complete value list *and* the list the
 * options are rendered from, so "Alle" cannot drift from what the user sees. The alternative, a
 * second tuple in this file, would compile while being incomplete, which is the one mistake that
 * matters for "Alle": an incomplete list silently keeps a Job_Posting hidden.
 *
 * A value import from `@job-scraper/domain` is not an option: that package reaches `node:crypto`
 * and `fast-check`, both of which would land in the browser bundle (see the note in
 * `src/i18n/de.ts`). The imports below are type-only.
 *
 * Requirements: 8.11, 10.5, 10.6, 10.11.
 */

import type { InterestFlag, Platform, PostingStatus, RelevanceVerdict } from '@job-scraper/domain';

import type { JobPostingFilterInput, Reachability } from '../../graphql/schema.generated';
import { de } from '../../i18n/de';

/**
 * The choice that sends no value and therefore leaves the default view of 10.6 and 10.11 in force.
 *
 * A sentinel rather than an empty string, so the rendered `option` has a real value and the form
 * value reads as what it is wherever it is logged or asserted. Neither `InterestFlag` nor
 * `RelevanceVerdict` contains it.
 */
export const DEFAULT_VIEW = 'DEFAULT_VIEW';

/** The choice that sends the complete value list: the "Alle" of 10.5. */
export const ALL_VALUES = 'ALL_VALUES';

/** What the marking filter can be set to (10.5, 10.11). */
export type MarkingChoice = typeof DEFAULT_VIEW | typeof ALL_VALUES | InterestFlag;

/** What the Relevance_Verdict filter can be set to (10.5, 10.6). */
export type RelevanceVerdictChoice = typeof DEFAULT_VIEW | typeof ALL_VALUES | RelevanceVerdict;

/**
 * The six filters of 10.5 as the form holds them.
 *
 * Deliberately *not* `JobPostingFilterInput`. A form field has a value for every state, including
 * the state "nothing chosen" — an empty checkbox group, an empty date field, the default-view
 * option — while the GraphQL input expresses that state by leaving a member out. Keeping the two
 * shapes apart is what lets {@link postingFilterInputOf} be the single place where "nothing chosen"
 * is turned into either an omitted member or a complete value list.
 *
 * The two dates are the strings an `input[type="date"]` holds: `''` or `YYYY-MM-DD`.
 */
export interface PostingFilterValues {
  /** Ticked Platform; empty means every Platform (10.5). */
  readonly platforms: readonly Platform[];
  /** Ticked reachability classes, read against the Commute_Threshold (8.11, 10.5). */
  readonly reachability: readonly Reachability[];
  /** Ticked Posting_Status; independent of the two filters below (10.5). */
  readonly postingStatuses: readonly PostingStatus[];
  /** The marking filter; {@link DEFAULT_VIEW} is the state the overview opens in (10.11). */
  readonly marking: MarkingChoice;
  /** The Relevance_Verdict filter; {@link DEFAULT_VIEW} is the opening state (10.6). */
  readonly relevanceVerdict: RelevanceVerdictChoice;
  /** Start of the recording period as `YYYY-MM-DD`, or `''` where the user set no bound. */
  readonly firstSeenFrom: string;
  /** End of the recording period as `YYYY-MM-DD`, or `''` where the user set no bound. */
  readonly firstSeenTo: string;
}

/**
 * The filter state the posting overview opens in, and the state "Filter zurücksetzen" restores
 * (10.13).
 *
 * Every list empty and both verdict-bearing filters on {@link DEFAULT_VIEW}: no restriction on
 * Platform, reachability or Posting_Status, and the default view of 10.6 and 10.11 on the other
 * two. {@link postingFilterInputOf} turns this into the empty filter input, which is the request
 * the design describes as "without arguments … the first page of the default view".
 */
export const DEFAULT_FILTER_VALUES: PostingFilterValues = {
  platforms: [],
  reachability: [],
  postingStatuses: [],
  marking: DEFAULT_VIEW,
  relevanceVerdict: DEFAULT_VIEW,
  firstSeenFrom: '',
  firstSeenTo: '',
};

/** One option of a filter: the value sent, and the German label rendered next to it. */
export interface FilterOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
}

/**
 * The options of one filter, in the order its label map declares them.
 *
 * `Object.keys` loses the key type, which is the one cast in this module. It is sound because the
 * parameter type demands a label for every `TValue`, and the maps in `src/i18n/de.ts` carry a
 * `satisfies` clause against the closed vocabulary that makes that demand checkable there rather
 * than here.
 */
export const filterOptionsOf = <TValue extends string>(
  labels: Readonly<Record<TValue, string>>,
): readonly FilterOption<TValue>[] =>
  (Object.keys(labels) as TValue[]).map((value) => ({ value, label: labels[value] }));

/** Every Interest_Flag, which is what the marking filter sends for "Alle" (10.5). */
const ALL_INTEREST_FLAGS: readonly InterestFlag[] = filterOptionsOf<InterestFlag>(
  de.filters.marking.options,
).map((option) => option.value);

/** Every Relevance_Verdict, which is what the verdict filter sends for "Alle" (10.5). */
const ALL_RELEVANCE_VERDICTS: readonly RelevanceVerdict[] = filterOptionsOf<RelevanceVerdict>(
  de.filters.relevanceVerdict.options,
).map((option) => option.value);

/**
 * What an `input[type="date"]` holds once it holds anything: a full calendar date.
 *
 * A browser date field never hands over a partial date — it reports `''` until the value is
 * complete — so this guard is about the value arriving from anywhere else (a restored form state,
 * a test). A value that is not a full date is treated as no bound rather than sent as a
 * timestamp the API_Service would have to reject.
 */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One bound of the recording period as the `DateTime` scalar takes it, or nothing (10.5).
 *
 * The period is inclusive at both ends, and the stored time of first recording is a timestamp while
 * the user picks a day. So the `from` bound becomes the first instant of that day and the `to`
 * bound the last: picking the same day for both has to match everything recorded on it, which a
 * bare `YYYY-MM-DDT00:00:00Z` for both ends would not.
 *
 * In UTC, because that is how the Posting_Store holds the time of first recording (9.1) and because
 * a local-time bound would make the same picked day mean different instants on two machines — and
 * the same test pass or fail depending on the machine's time zone. The practical cost is the edge
 * of the day: on Central European Time a Job_Posting recorded shortly before midnight UTC belongs
 * to the next local day, and the filter counts it on the UTC one.
 *
 * @param isoDate The picked day as `YYYY-MM-DD`, or `''`.
 * @param instant Which end of that day to take.
 */
const periodBoundOf = (isoDate: string, instant: 'START' | 'END'): string | undefined =>
  CALENDAR_DATE.test(isoDate)
    ? `${isoDate}T${instant === 'START' ? '00:00:00.000Z' : '23:59:59.999Z'}`
    : undefined;

/** A list filter contributes a member only where something is ticked (10.5). */
const selectionOf = <TValue>(values: readonly TValue[]): TValue[] | undefined =>
  values.length === 0 ? undefined : [...values];

/**
 * The marking filter as a sent value list, or nothing for the default view of 10.11.
 *
 * Three branches and not one: "Alle" is the complete list, a single Interest_Flag is that one
 * value, and the default view sends nothing at all. Collapsing the first and the last would make
 * "Alle" show the default view, which is the only way a Job_Posting the user marked
 * "nicht interessant" could stay invisible after they asked to see everything.
 */
const interestFlagsOf = (marking: MarkingChoice): InterestFlag[] | undefined => {
  switch (marking) {
    case DEFAULT_VIEW:
      return undefined;
    case ALL_VALUES:
      return [...ALL_INTEREST_FLAGS];
    default:
      return [marking];
  }
};

/** The Relevance_Verdict filter as a sent value list, or nothing for the default view of 10.6. */
const relevanceVerdictsOf = (choice: RelevanceVerdictChoice): RelevanceVerdict[] | undefined => {
  switch (choice) {
    case DEFAULT_VIEW:
      return undefined;
    case ALL_VALUES:
      return [...ALL_RELEVANCE_VERDICTS];
    default:
      return [choice];
  }
};

/**
 * The form state as the `filter` argument of the `jobPostings` query (8.11, 10.5, 10.6, 10.11).
 *
 * Every member is spread in conditionally, so a filter the user did not set is **absent** rather
 * than `null` or `[]`. All six filters are conjunctive on the API_Service side, so there is nothing
 * to combine here — each one contributes its own member and the read path ANDs them.
 *
 * {@link DEFAULT_FILTER_VALUES} maps to `{}`, the unfiltered request.
 */
export const postingFilterInputOf = (values: PostingFilterValues): JobPostingFilterInput => {
  const platforms = selectionOf(values.platforms);
  const reachability = selectionOf(values.reachability);
  const postingStatuses = selectionOf(values.postingStatuses);
  const interestFlags = interestFlagsOf(values.marking);
  const relevanceVerdicts = relevanceVerdictsOf(values.relevanceVerdict);
  const firstSeenFrom = periodBoundOf(values.firstSeenFrom, 'START');
  const firstSeenTo = periodBoundOf(values.firstSeenTo, 'END');

  return {
    ...(platforms === undefined ? {} : { platforms }),
    ...(reachability === undefined ? {} : { reachability }),
    ...(postingStatuses === undefined ? {} : { postingStatuses }),
    ...(interestFlags === undefined ? {} : { interestFlags }),
    ...(relevanceVerdicts === undefined ? {} : { relevanceVerdicts }),
    ...(firstSeenFrom === undefined ? {} : { firstSeenFrom }),
    ...(firstSeenTo === undefined ? {} : { firstSeenTo }),
  };
};

/**
 * Whether the user has set any filter at all, i.e. whether the view deviates from the default view.
 *
 * The one input the two empty states of 10.12 and 10.13 are told apart by: an empty result with no
 * filter set is the empty Posting_Store, and an empty result with a filter set is the empty filter
 * result that keeps its filters and offers "Filter zurücksetzen". Task 17.5 renders both; this is
 * the question it asks.
 */
export const hasSetFilter = (values: PostingFilterValues): boolean =>
  Object.keys(postingFilterInputOf(values)).length > 0;
