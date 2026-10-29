/**
 * The read-only criteria view of 4.11 to 4.13.
 *
 * Two questions: is every supported Platform in the answer, whatever its state, and is each resolved
 * value rendered as one legible German line with the source it came from? The resolution itself is
 * asserted in `./platform-config.resolve.test.ts`; this view adds the rendering and nothing else.
 *
 * "German" is the part that needs its own suite below: a `SearchProfile` holds `PERMANENT` and `50`,
 * and the user reads neither an English enum literal nor a radius without a unit. The texts are
 * asserted against the label tables rather than retyped, so a reworded label stays one edit.
 *
 * Requirements: 4.7, 4.9, 4.10, 4.11, 4.12, 4.13.
 */

import { EMPLOYMENT_TYPES, type EmploymentType, type FieldProvenance } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { PLATFORM_STATUS_LABELS_DE } from '../../common/error-mapping';
import {
  CRITERION_VALUE_EMPTY_DE,
  criterionValueTextDe,
  EMPLOYMENT_TYPE_LABELS_DE,
} from '../criterion-value-text';
import { FIELD_PROVENANCES } from '../models/field-provenance.enum';
import {
  platformDisabledMessageDe,
  platformIncompleteConfigurationMessageDe,
} from '../platform-config.messages';
import type { PlatformConfigurationState } from '../platform-config.resolve';
import { platformCriteriaViewOf, platformCriteriaViewsOf } from '../platform-criteria-view';

const readyState: PlatformConfigurationState = {
  platform: 'STEPSTONE',
  activated: true,
  platformStatus: 'NOT_YET_RUN',
  missingMandatoryFields: [],
  effectiveProfile: {
    platform: 'STEPSTONE',
    criteria: [
      { field: 'jobTitle', value: 'Projektmanagerin', provenance: 'DEFAULT' },
      {
        field: 'titleSynonyms',
        value: ['Projektleiterin', 'Program Manager'],
        provenance: 'OVERRIDE',
      },
      { field: 'searchRadiusKm', value: 30, provenance: 'DEFAULT' },
      { field: 'employmentType', value: 'PERMANENT', provenance: 'DEFAULT' },
      { field: 'publicationPeriodDays', value: 30, provenance: 'OVERRIDE' },
    ],
  },
};

const incompleteState: PlatformConfigurationState = {
  platform: 'INDEED',
  activated: true,
  platformStatus: 'INCOMPLETE_CONFIGURATION',
  missingMandatoryFields: ['searchLocation'],
  effectiveProfile: null,
};

const disabledState: PlatformConfigurationState = {
  platform: 'GLASSDOOR',
  activated: false,
  platformStatus: 'DISABLED',
  missingMandatoryFields: [],
  effectiveProfile: null,
};

describe('platformCriteriaViewOf', () => {
  it('renders every resolved value as one German line with its source (4.11, 4.12)', () => {
    expect(platformCriteriaViewOf(readyState)).toEqual({
      platform: 'STEPSTONE',
      activated: true,
      platformStatus: 'NOT_YET_RUN',
      platformStatusLabelDe: PLATFORM_STATUS_LABELS_DE.NOT_YET_RUN,
      configurationHintDe: null,
      missingMandatoryFields: [],
      criteria: [
        { field: 'jobTitle', valueText: 'Projektmanagerin', provenance: 'DEFAULT' },
        {
          field: 'titleSynonyms',
          valueText: 'Projektleiterin, Program Manager',
          provenance: 'OVERRIDE',
        },
        // The two values that are not simply what the constant holds: a number without its unit and
        // an English enum literal are both unreadable in a German view.
        { field: 'searchRadiusKm', valueText: '30 km', provenance: 'DEFAULT' },
        {
          field: 'employmentType',
          valueText: EMPLOYMENT_TYPE_LABELS_DE.PERMANENT,
          provenance: 'DEFAULT',
        },
        { field: 'publicationPeriodDays', valueText: '30 Tage', provenance: 'OVERRIDE' },
      ],
    });
  });

  it('answers an incomplete configuration with the missing field names and no criteria (4.9, 4.10)', () => {
    const view = platformCriteriaViewOf(incompleteState);

    expect(view.criteria).toEqual([]);
    expect(view.missingMandatoryFields).toEqual(['searchLocation']);
    expect(view.platformStatus).toBe('INCOMPLETE_CONFIGURATION');
    expect(view.platformStatusLabelDe).toBe(PLATFORM_STATUS_LABELS_DE.INCOMPLETE_CONFIGURATION);
    // The sentence the Log_View already shows for this state, including the missing field names, so
    // the criteria view does not word a second one (4.9).
    expect(view.configurationHintDe).toBe(
      platformIncompleteConfigurationMessageDe('INDEED', ['searchLocation']),
    );
  });

  it('keeps a deactivated Platform in the view with its status (4.7, 4.11)', () => {
    const view = platformCriteriaViewOf(disabledState);

    expect(view.activated).toBe(false);
    expect(view.platformStatus).toBe('DISABLED');
    expect(view.platformStatusLabelDe).toBe(PLATFORM_STATUS_LABELS_DE.DISABLED);
    expect(view.configurationHintDe).toBe(platformDisabledMessageDe('GLASSDOOR'));
  });
});

describe('criterionValueTextDe', () => {
  it('labels every employment type in German (2.1, 4.11)', () => {
    const texts = EMPLOYMENT_TYPES.map((employmentType) =>
      criterionValueTextDe({
        field: 'employmentType',
        value: employmentType,
        provenance: 'DEFAULT',
      }),
    );

    // No English literal survives: every label differs from its enum value, and all four are there.
    expect(texts).toEqual(EMPLOYMENT_TYPES.map((type) => EMPLOYMENT_TYPE_LABELS_DE[type]));
    expect(texts.some((text) => EMPLOYMENT_TYPES.includes(text as EmploymentType))).toBe(false);
  });

  it('carries the unit of a numeric criterion (4.11)', () => {
    const radius = criterionValueTextDe({
      field: 'searchRadiusKm',
      value: 50,
      provenance: 'DEFAULT',
    });
    const oneDay = criterionValueTextDe({
      field: 'publicationPeriodDays',
      value: 1,
      provenance: 'DEFAULT',
    });

    expect(radius).toBe('50 km');
    expect(oneDay).toBe('1 Tag');
  });

  it('names an empty list rather than rendering a blank value', () => {
    const empty = criterionValueTextDe({
      field: 'titleSynonyms',
      value: [],
      provenance: 'OVERRIDE',
    });

    expect(empty).toBe(CRITERION_VALUE_EMPTY_DE);
  });

  it('passes a free-text criterion through unchanged', () => {
    const location = criterionValueTextDe({
      field: 'searchLocation',
      value: 'München',
      provenance: 'OVERRIDE',
    });

    expect(location).toBe('München');
  });
});

describe('platformCriteriaViewsOf', () => {
  it('keeps every Platform and its order (4.11)', () => {
    const views = platformCriteriaViewsOf([readyState, incompleteState, disabledState]);

    expect(views.map((view) => view.platform)).toEqual(['STEPSTONE', 'INDEED', 'GLASSDOOR']);
  });
});

describe('the published provenance value list (4.12)', () => {
  it('carries every value the Profile_Resolver can produce', () => {
    // The compile-time half is the `satisfies` clause on the tuple: a value published here that the
    // resolution cannot produce fails `pnpm check-types`. This is the other direction — a provenance
    // the resolution produces and the list omits, which no type can catch.
    const everyProvenance: readonly FieldProvenance[] = ['DEFAULT', 'OVERRIDE'];

    expect([...FIELD_PROVENANCES].sort()).toEqual([...everyProvenance].sort());
  });
});
