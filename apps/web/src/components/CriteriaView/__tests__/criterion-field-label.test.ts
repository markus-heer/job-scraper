import { DEFAULT_SEARCH_PROFILE } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { de } from '../../../i18n/de';
import { criterionFieldLabelOf } from '../criterion-field-label';

/**
 * The Criterion_Field label lookup of the read-only criteria view (4.10, 4.11).
 *
 * Two cases, and the second one is the reason the function exists: the schema publishes a
 * Criterion_Field name as `String`, so the value that arrives is not typed to the seven the Web_App
 * has labels for, and what happens with an eighth decides whether a criterion that is really in
 * force can disappear from the view.
 *
 * Requirements: 4.10, 4.11.
 */
describe('criterionFieldLabelOf', () => {
  it('labels every Criterion_Field the Job_Tool has', () => {
    // The Default_Search_Profile is the runtime view of `keyof SearchProfile`, so its keys are
    // exactly the Criterion_Field the criteria view can be sent.
    for (const field of Object.keys(DEFAULT_SEARCH_PROFILE)) {
      const label = criterionFieldLabelOf(field);

      expect(label).not.toBe(field);
      expect(label.length).toBeGreaterThan(0);
    }

    expect(criterionFieldLabelOf('searchRadiusKm')).toBe(de.criteria.fields.searchRadiusKm);
  });

  it('shows an unknown identifier rather than dropping it', () => {
    // An API_Service one version ahead sends a Criterion_Field this Web_App has no label for. The
    // criterion is in force, so it is shown under its identifier instead of being hidden.
    expect(criterionFieldLabelOf('contractHoursPerWeek')).toBe('contractHoursPerWeek');
  });
});
