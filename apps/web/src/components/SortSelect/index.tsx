import { type ChangeEvent, useId } from 'react';

import type { JobPostingSortField, SortDirection } from '../../graphql/schema.generated';
import { de } from '../../i18n/de';
import type { PostingSortSelection } from './sort-selection';

/**
 * The sort selection of the posting overview (10.7).
 *
 * Requirement 10.7 asks for four sort keys — recording time, publication date, Best_Commute_Time
 * and Relevance_Verdict — each available ascending and descending, with recording time descending
 * preselected. That is a key *and* a direction, so it is two controls rather than eight combined
 * options: eight captions would have to spell "Fahrzeit aufsteigend" and seven siblings, and the
 * user who only wants to flip the direction would have to find the matching half of a compound
 * label. Two `select` elements keep each choice at one place, and the pair they produce is one
 * {@link PostingSortSelection}.
 *
 * Both lists are rendered from the label maps of `de.sort`, keyed by the generated schema enums, so
 * neither the four keys nor the two directions are written out here. A sort key added to the
 * published schema has no caption and fails `check-types` in `src/i18n/de.ts`; a caption without a
 * schema value cannot be sent.
 *
 * ## What the component does not decide
 *
 * It holds no state. The selection comes in as `value` and every change leaves through `onChange`,
 * because the same value is also a query variable: the page read of task 17.5 owns it, sends it as
 * `sort` (see `sortInputOf`) and returns to page 1 when it changes — a user who re-sorts the list is
 * asking a new question, and page 7 of the old answer is not part of it (10.9).
 *
 * Where the three sort keys other than recording time place a Job_Posting whose value is unknown,
 * and in which order the Relevance_Verdict values are sorted, is decided by the API_Service
 * (`postingOrderByOf`), not here. This component names the order; it does not compute it.
 *
 * ## Accessibility
 *
 * A `fieldset` with a `legend`, because the two controls are one setting and a screen reader should
 * announce "Sortierung" around them (2.3). Each `select` carries a visible `label` associated
 * through `htmlFor`, with the identifiers from `useId` so that two instances on one page cannot
 * collide. Native `select` elements are operable with the keyboard alone and carry the shell's focus
 * ring; nothing here listens for a key.
 *
 * Requirements: 2.1, 2.3, 10.7, 11.3.
 */

/**
 * The two option lists, enumerated from the German labels rather than written out.
 *
 * Each pair of lines does two different jobs. The annotation is the completeness check: a label map
 * that misses one value of the generated enum is not assignable to the `Record` and fails
 * `check-types` here, so a sort key added to the published schema cannot reach the user without a
 * caption. The assertion on `Object.keys` is the enumeration, which the type system cannot express
 * — `Object.keys` returns `string[]` for every object — and it is sound against the line above it.
 */
const SORT_FIELD_LABELS: Readonly<Record<JobPostingSortField, string>> = de.sort.fields;
const SORT_FIELDS = Object.keys(SORT_FIELD_LABELS) as readonly JobPostingSortField[];

const SORT_DIRECTION_LABELS: Readonly<Record<SortDirection, string>> = de.sort.directions;
const SORT_DIRECTIONS = Object.keys(SORT_DIRECTION_LABELS) as readonly SortDirection[];

export interface SortSelectProps {
  /** The sorting in force, preselected in both controls. */
  readonly value: PostingSortSelection;

  /** Called with the complete new pair whenever either control changes. */
  readonly onChange: (value: PostingSortSelection) => void;
}

export function SortSelect({ value, onChange }: SortSelectProps) {
  const fieldSelectId = useId();
  const directionSelectId = useId();

  // The `value` of a `select` is a string. Looking the choice up in the option list rather than
  // asserting it is what keeps the enum narrowing honest: a value that is not one of the rendered
  // options — which only a tampered DOM can produce — changes nothing.
  const handleFieldChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const field = SORT_FIELDS.find((candidate) => candidate === event.target.value);

    if (field !== undefined) {
      onChange({ field, direction: value.direction });
    }
  };

  const handleDirectionChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const direction = SORT_DIRECTIONS.find((candidate) => candidate === event.target.value);

    if (direction !== undefined) {
      onChange({ field: value.field, direction });
    }
  };

  return (
    <fieldset className="sort-select">
      <legend className="sort-select__legend">{de.sort.label}</legend>

      <div className="sort-select__control">
        <label className="sort-select__label" htmlFor={fieldSelectId}>
          {de.sort.fieldLabel}
        </label>
        <select
          className="sort-select__select"
          id={fieldSelectId}
          onChange={handleFieldChange}
          value={value.field}
        >
          {SORT_FIELDS.map((field) => (
            <option key={field} value={field}>
              {SORT_FIELD_LABELS[field]}
            </option>
          ))}
        </select>
      </div>

      <div className="sort-select__control">
        <label className="sort-select__label" htmlFor={directionSelectId}>
          {de.sort.directionLabel}
        </label>
        <select
          className="sort-select__select"
          id={directionSelectId}
          onChange={handleDirectionChange}
          value={value.direction}
        >
          {SORT_DIRECTIONS.map((direction) => (
            <option key={direction} value={direction}>
              {SORT_DIRECTION_LABELS[direction]}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}
