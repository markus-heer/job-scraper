import { useId } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { de } from '../../../i18n/de';
import { ALL_VALUES, DEFAULT_VIEW, type FilterOption } from '../posting-filter-values';

/**
 * The marking and the Relevance_Verdict filter of 10.5: one choice out of the default view, "Alle",
 * and each single value.
 *
 * These two filters are the ones that cannot be a group of checkboxes, and the reason is the
 * default view. The API_Service reads an unset marking or verdict filter as the default view of
 * 10.11 and 10.6 — "not interesting" and "not relevant" hidden — rather than as "no restriction",
 * so the control needs *three* kinds of state where the other filters need two: the default view,
 * the complete value list that 10.5 names "all", and one picked value. An empty checkbox group can
 * express only the first, and a fully ticked one would be indistinguishable from "all" only by
 * counting boxes.
 *
 * So the options are, in this order:
 *
 * 1. the default view, which sends nothing and is what the overview opens in;
 * 2. `de.filters.allOption` — "Alle" — which sends the complete value list and is what makes a
 *    hidden Job_Posting visible again (10.6, 10.11);
 * 3. one option per value of the vocabulary, each sending exactly that value.
 *
 * 10.5 asks for the single values "and the value 'all'", which is items 2 and 3; item 1 is the
 * state the view starts in and is named as an option so the user can return to it after picking
 * another one.
 *
 * A single `select` is the right control for one-out-of-many: it is one tab stop, it is operable
 * with the arrow keys, and the `label` with `htmlFor` is the visible, programmatically associated
 * label of 2.3.
 *
 * Requirements: 2.3, 10.5, 10.6, 10.11.
 */
export interface SelectFilterProps {
  /** The visible, programmatically associated field label (2.3). */
  readonly label: string;
  /** Caption of the default-view option, which names the value that stays hidden. */
  readonly defaultViewLabel: string;
  /** One entry per value of the vocabulary, in the order the German label map declares them. */
  readonly options: readonly FilterOption<string>[];
  /** The `register(name)` result of the form field this select writes to. */
  readonly registration: UseFormRegisterReturn;
}

export function SelectFilter({
  label,
  defaultViewLabel,
  options,
  registration,
}: SelectFilterProps) {
  const fieldId = useId();

  return (
    <div className="filter-bar__field">
      <label className="filter-bar__label" htmlFor={fieldId}>
        {label}
      </label>
      <select className="filter-bar__select" id={fieldId} {...registration}>
        <option value={DEFAULT_VIEW}>{defaultViewLabel}</option>
        <option value={ALL_VALUES}>{de.filters.allOption}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
