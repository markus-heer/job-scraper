import { useId } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import type { FilterOption } from '../posting-filter-values';

/**
 * One filter of 10.5 whose values are independent alternatives: a group of checkboxes.
 *
 * Used by the Platform, the reachability and the Posting_Status filter — the three for which "all"
 * and "nothing ticked" mean the same thing, so the group needs no extra option to express it. The
 * marking and the Relevance_Verdict filter use `SelectFilter` instead, because for them an unticked
 * filter is the default view of 10.6 and 10.11 and therefore a choice of its own.
 *
 * ## Why checkboxes and not a multiple select
 *
 * 10.5 asks for every Platform to be "individually selectable", and the API_Service takes a list
 * per filter, so the control has to carry more than one value. A `select[multiple]` does that in
 * markup but not in practice: selecting a second entry needs Ctrl or Shift with a click on most
 * platforms, which is a mouse gesture, and the keyboard equivalent is undiscoverable — both at odds
 * with 2.3, which asks for every function to be operable without a mouse. A checkbox is one tab
 * stop and one Space press per value, and a `fieldset` with a `legend` is the association that
 * names the group for a screen reader. The legend is also the visible label 2.3 asks for.
 *
 * All five list filters are combined conjunctively by the API_Service, while the values *inside*
 * one group are alternatives to each other (`in` on one column). The markup says exactly that: one
 * fieldset per column, several boxes within it.
 *
 * ## The registration is shared
 *
 * Every checkbox of the group gets the same `register(name)` result and its own `value`, which is
 * how react-hook-form collects a list: the field value is the array of ticked `value` attributes.
 * The `id` is set before the spread, because the registration carries `name`, `ref`, `onChange` and
 * `onBlur` and must not be able to overwrite the attribute the label points at.
 *
 * Requirements: 2.3, 8.11, 10.5.
 */
export interface CheckboxGroupFilterProps {
  /** The visible, programmatically associated group label (2.3). */
  readonly legend: string;
  /** What an empty group means, stated rather than left to be guessed (10.5). */
  readonly hint: string;
  /** One entry per selectable value, in the order the German label map declares them. */
  readonly options: readonly FilterOption<string>[];
  /** The `register(name)` result of the form field this group writes to. */
  readonly registration: UseFormRegisterReturn;
}

export function CheckboxGroupFilter({
  legend,
  hint,
  options,
  registration,
}: CheckboxGroupFilterProps) {
  const idPrefix = useId();
  const hintId = `${idPrefix}-hint`;

  return (
    <fieldset className="filter-bar__group" aria-describedby={hintId}>
      <legend className="filter-bar__legend">{legend}</legend>
      <p className="filter-bar__hint" id={hintId}>
        {hint}
      </p>
      {options.map((option) => {
        const optionId = `${idPrefix}-${option.value}`;

        return (
          <div className="filter-bar__option" key={option.value}>
            <input
              className="filter-bar__checkbox"
              id={optionId}
              type="checkbox"
              value={option.value}
              {...registration}
            />
            <label htmlFor={optionId}>{option.label}</label>
          </div>
        );
      })}
    </fieldset>
  );
}
