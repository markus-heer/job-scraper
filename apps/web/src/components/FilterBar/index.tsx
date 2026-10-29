import type { InterestFlag, Platform, PostingStatus, RelevanceVerdict } from '@job-scraper/domain';
import { useId } from 'react';
import { useForm } from 'react-hook-form';

import type { Reachability } from '../../graphql/schema.generated';
import { de } from '../../i18n/de';
import { CheckboxGroupFilter } from './CheckboxGroupFilter';
import {
  DEFAULT_FILTER_VALUES,
  filterOptionsOf,
  type PostingFilterValues,
} from './posting-filter-values';
import { SelectFilter } from './SelectFilter';

/**
 * The filter bar of the posting overview: the six filters of Requirement 10.5 as one labelled form.
 *
 * Platform, reachability and Posting_Status are checkbox groups, the marking and the
 * Relevance_Verdict filter are selects with a default-view option, and the recording period is a
 * pair of date fields. Which control carries which filter and why is explained at
 * `CheckboxGroupFilter` and `SelectFilter`; what the form state *means* over the wire is explained
 * at `postingFilterInputOf` in `./posting-filter-values.ts`, which is also where the difference
 * between "Alle" and "not set" lives.
 *
 * The six filters are conjunctive (10.5), and nothing in this component combines them: each one
 * contributes its own member of `JobPostingFilterInput` and the API_Service ANDs them. The marking
 * and the Relevance_Verdict filter likewise need no special handling against the Posting_Status
 * filter — they are separate members over separate columns, which is what "take effect
 * independently" amounts to.
 *
 * ## Applied values live outside this component
 *
 * `values` is the filter set in force and `onChange` reports a new one. The posting overview route
 * holds it, for two reasons: it is the route that sends the `jobPostings` query, and 10.13 asks for
 * an empty filter result to offer "Filter zurücksetzen" *outside* this bar, in the empty state, with
 * the filters left set until the user presses it. With the state one level up, that call to action
 * is one `onChange(DEFAULT_FILTER_VALUES)` and this component follows along; a bar that owned its
 * own filters would have to be reset through a ref.
 *
 * react-hook-form's `values` option is what keeps the form in step with that: when the applied
 * filters change from the outside, the form is updated to them. The reset button below calls
 * `reset` locally *as well*, because an external reset while the applied filters already are the
 * default would otherwise change nothing — and the user may well have pending, unapplied edits to
 * clear.
 *
 * ## Why react-hook-form at all
 *
 * The design names it for this bar, and the fit is real rather than nominal: seven fields across
 * three control types, two of which write arrays collected from several DOM nodes, plus an apply
 * step and a reset step. `register` gives the checkbox-group collection for free, `handleSubmit`
 * is the apply step, `reset` is the reset step, and no field needs a `useState` or a change handler
 * of its own. The alternative — seven controlled fields with their own state and a hand-written
 * array toggle — is more code for the same behaviour and puts the list-collection bug back in
 * reach. No validation rules are declared: a `select` cannot hold a value outside its options, and
 * a date field cannot hold a partial date, so there is nothing left for a resolver to reject.
 *
 * ## Applying rather than filtering on every keystroke
 *
 * A submit button, not a live filter. Six filters that each re-ran the query on every tick would
 * send a request per checkbox while the user is still assembling a combination, and 10.1 gives the
 * overview 3 seconds to answer — the user should spend it once, on the combination they meant.
 * `de.filters.apply` exists for exactly this control.
 *
 * Requirements: 2.1, 2.3, 8.11, 10.5, 10.6, 10.11, 10.13.
 */
export interface FilterBarProps {
  /** The filters in force. The form mirrors them, so an external reset reaches the controls. */
  readonly values: PostingFilterValues;
  /** Called with the filters the user applied, or with the defaults when they reset them. */
  readonly onChange: (values: PostingFilterValues) => void;
}

/** The options of each filter, read from the German label maps. See `filterOptionsOf`. */
const PLATFORM_OPTIONS = filterOptionsOf<Platform>(de.filters.platform.options);
const REACHABILITY_OPTIONS = filterOptionsOf<Reachability>(de.filters.reachability.options);
const POSTING_STATUS_OPTIONS = filterOptionsOf<PostingStatus>(de.filters.postingStatus.options);
const INTEREST_FLAG_OPTIONS = filterOptionsOf<InterestFlag>(de.filters.marking.options);
const RELEVANCE_VERDICT_OPTIONS = filterOptionsOf<RelevanceVerdict>(
  de.filters.relevanceVerdict.options,
);

export function FilterBar({ values, onChange }: FilterBarProps) {
  const idPrefix = useId();
  const headingId = `${idPrefix}-heading`;
  const periodHintId = `${idPrefix}-period-hint`;
  const fromId = `${idPrefix}-from`;
  const toId = `${idPrefix}-to`;

  const { register, handleSubmit, reset } = useForm<PostingFilterValues>({
    defaultValues: DEFAULT_FILTER_VALUES,
    values,
  });

  const applyFilters = handleSubmit((applied) => {
    onChange(applied);
  });

  // Both halves are needed: `reset` clears edits the user has not applied, `onChange` puts the
  // route back to the default view so the next query is the unfiltered one (10.13).
  const resetFilters = () => {
    reset(DEFAULT_FILTER_VALUES);
    onChange(DEFAULT_FILTER_VALUES);
  };

  return (
    <form aria-labelledby={headingId} className="filter-bar" onSubmit={applyFilters}>
      <h2 className="filter-bar__heading" id={headingId}>
        {de.filters.heading}
      </h2>

      <div className="filter-bar__fields">
        <CheckboxGroupFilter
          hint={de.filters.noSelectionHint}
          legend={de.filters.platform.label}
          options={PLATFORM_OPTIONS}
          registration={register('platforms')}
        />
        <CheckboxGroupFilter
          hint={de.filters.noSelectionHint}
          legend={de.filters.reachability.label}
          options={REACHABILITY_OPTIONS}
          registration={register('reachability')}
        />
        <CheckboxGroupFilter
          hint={de.filters.noSelectionHint}
          legend={de.filters.postingStatus.label}
          options={POSTING_STATUS_OPTIONS}
          registration={register('postingStatuses')}
        />

        <SelectFilter
          defaultViewLabel={de.filters.marking.defaultOption}
          label={de.filters.marking.label}
          options={INTEREST_FLAG_OPTIONS}
          registration={register('marking')}
        />
        <SelectFilter
          defaultViewLabel={de.filters.relevanceVerdict.defaultOption}
          label={de.filters.relevanceVerdict.label}
          options={RELEVANCE_VERDICT_OPTIONS}
          registration={register('relevanceVerdict')}
        />

        {/*
         * The recording period of 10.5. One fieldset, because the two dates are the two ends of a
         * single filter, and both bounds count — the hint says so rather than leaving the user to
         * test it. Each bound is sendable on its own, so neither field is required.
         */}
        <fieldset aria-describedby={periodHintId} className="filter-bar__group">
          <legend className="filter-bar__legend">{de.filters.firstSeenPeriod.label}</legend>
          <p className="filter-bar__hint" id={periodHintId}>
            {de.filters.firstSeenPeriod.hint}
          </p>
          <div className="filter-bar__option">
            <label htmlFor={fromId}>{de.filters.firstSeenPeriod.from}</label>
            <input
              className="filter-bar__date"
              id={fromId}
              type="date"
              {...register('firstSeenFrom')}
            />
          </div>
          <div className="filter-bar__option">
            <label htmlFor={toId}>{de.filters.firstSeenPeriod.to}</label>
            <input
              className="filter-bar__date"
              id={toId}
              type="date"
              {...register('firstSeenTo')}
            />
          </div>
        </fieldset>
      </div>

      <div className="filter-bar__actions">
        <button className="control control--primary" type="submit">
          {de.filters.apply}
        </button>
        <button className="control" onClick={resetFilters} type="button">
          {de.filters.reset}
        </button>
      </div>
    </form>
  );
}
