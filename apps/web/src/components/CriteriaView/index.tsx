import './criteria-view.css';

import { CombinedGraphQLErrors } from '@apollo/client/errors';

import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';
import { criterionFieldLabelOf } from './criterion-field-label';
import { type SearchCriteriaQuery, useSearchCriteriaQuery } from './search-criteria.generated';

/**
 * The read-only view of the search criteria: one block per supported Platform (4.11 to 4.13).
 *
 * Requirement 4.11 asks for the effective Search_Profile of *every* supported Platform with the
 * resolved value of every Criterion_Field that Platform supports, and for every Criterion_Field it
 * does not support to be omitted. Both halves are the server's answer rather than a decision here:
 * `searchCriteria` returns one entry per Platform and each entry carries exactly the supported
 * fields, so this component renders the list it is given and filters nothing. That is also what
 * keeps the view honest — a criterion missing from the screen is a criterion the Scrape_Run does not
 * apply.
 *
 * ## The three-second bound of 4.11
 *
 * One query, no variables, no second round trip, no edge resolved per row: the whole page is one
 * request whose answer the API_Service determined once at startup and holds in memory. Nothing here
 * waits for anything else, so what the user waits for is one local HTTP round trip. See
 * `./search-criteria.graphql` for the selection and why no reader of it needs a follow-up.
 *
 * ## Read-only, and why there is nothing to switch off (4.13)
 *
 * This view renders no `input`, no `select`, no `textarea`, no editable element and no control that
 * writes: the Default_Search_Profile, the Platform_Override and the activation flags are TypeScript
 * constants a developer edits, and the schema offers no mutation that would write any of them. The
 * sentence that says so, and the pointer to the Steering_Docs 4.13 asks for, stand once at the top
 * of the route rather than once per block.
 *
 * ## Exactly one provenance label per field (4.12)
 *
 * `de.criteria.provenance` is a map over the complete `FieldProvenance` vocabulary and the cell is a
 * single lookup in it. There is no condition that could render both labels and none that could
 * render neither: the schema types the field as the two-value enum, and the map is total over it by
 * a `satisfies` clause in `src/i18n/de.ts`. A third provenance would be a type error at this line
 * rather than an empty cell.
 *
 * ## Which German text comes from where
 *
 * The headings, the column titles, the two provenance labels and the Criterion_Field labels are the
 * Web_App's. The *value* of a criterion arrives as German text in `valueText` — "Festanstellung",
 * "50 km" — and so do the Platform_Status and the sentence explaining a deactivated or incompletely
 * configured Platform. All three are printed unchanged: they are the API_Service's wording, the
 * Log_View already shows the same sentences, and `src/i18n/de.ts` holds no copy of a Platform_Status
 * label to drift from them.
 *
 * ## Accessibility
 *
 * One named region per Platform, tied to its own `h2`, and inside it a description list for the
 * state and a captioned table for the criteria — so every value has a visible label that is
 * programmatically tied to it (2.3). The status, the provenance and the missing fields are text; no
 * state is carried by colour (2.4).
 *
 * Requirements: 2.1, 2.3, 2.4, 2.5, 4.7, 4.9, 4.10, 4.11, 4.12, 4.13.
 */
export function CriteriaView() {
  const { data, error } = useSearchCriteriaQuery();

  if (error !== undefined) {
    // The same split as everywhere else: no answer at all is almost always the API_Service not
    // running, and `de.errors.offline` names the Start_Script; an answer carrying GraphQL errors is
    // a different fault and points at the technical detail in the Log_View (2.5).
    return (
      <ErrorNotice
        message={CombinedGraphQLErrors.is(error) ? de.errors.unexpected : de.errors.offline}
      />
    );
  }

  if (data === undefined) {
    return <p className="criteria__loading">{de.common.loading}</p>;
  }

  return (
    <div className="criteria">
      {data.searchCriteria.map((platformCriteria) => (
        <PlatformCriteriaBlock criteria={platformCriteria} key={platformCriteria.platform} />
      ))}
    </div>
  );
}

/** One Platform block as `search-criteria.graphql` selected it. */
type PlatformCriteria = SearchCriteriaQuery['searchCriteria'][number];

/**
 * One Platform: its configuration state, and the criteria that resolved for it.
 *
 * The state stands above the criteria because it decides what they mean. A Platform with the
 * Platform_Status "disabled" resolves criteria that no Scrape_Run will ever send (4.7), and a
 * Platform with an incomplete configuration resolves none at all (4.9, 4.10) — reading either table
 * without having read the status first would be reading it wrong.
 *
 * An empty criteria list is therefore explained rather than left as an empty table:
 * `de.criteria.noCriteria` says that nothing resolved, and the sentence from the API_Service above
 * it says why.
 */
function PlatformCriteriaBlock({ criteria }: { readonly criteria: PlatformCriteria }) {
  const labels = de.criteria;
  const platformLabel = de.vocabulary.platform[criteria.platform];
  const headingId = `criteria-${criteria.platform}`;

  return (
    <section aria-labelledby={headingId} className="criteria-platform">
      <h2 className="criteria-platform__heading" id={headingId}>
        {labels.platformHeading(platformLabel)}
      </h2>

      <dl className="criteria-platform__state">
        <dt>{labels.statusLabel}</dt>
        <dd>{criteria.platformStatusLabelDe}</dd>

        {criteria.missingMandatoryFields.length === 0 ? null : (
          <>
            <dt>{labels.missingFieldsLabel}</dt>
            <dd>{criteria.missingMandatoryFields.map(criterionFieldLabelOf).join(', ')}</dd>
          </>
        )}
      </dl>

      {criteria.configurationHintDe === null ? null : (
        <p className="criteria-platform__hint">{criteria.configurationHintDe}</p>
      )}

      {criteria.criteria.length === 0 ? (
        <p className="criteria-platform__empty">{labels.noCriteria}</p>
      ) : (
        <table className="criteria-platform__table">
          <caption>{labels.tableLabel(platformLabel)}</caption>
          <thead>
            <tr>
              <th scope="col">{labels.fieldColumn}</th>
              <th scope="col">{labels.valueColumn}</th>
              <th scope="col">{labels.provenanceColumn}</th>
            </tr>
          </thead>
          <tbody>
            {criteria.criteria.map((criterion) => (
              <tr key={criterion.field}>
                <th scope="row">{criterionFieldLabelOf(criterion.field)}</th>
                <td>{criterion.valueText}</td>
                <td>{labels.provenance[criterion.provenance]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
