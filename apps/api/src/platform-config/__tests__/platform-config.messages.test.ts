/**
 * The German texts of the per-Platform configuration check (4.7, 4.9, 4.10, 14.9).
 *
 * Two things are pinned here. The label maps have to be total over the closed value lists, because
 * a missing entry would print `undefined` into a line the user reads. And the missing-fields line
 * has to name every unresolved field while naming no Criterion_Field *value*, which is what keeps
 * the configuration check unable to leak a configured value into the Log_Stream (14.9).
 */

import { type CriterionField, PLATFORMS } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  CRITERION_FIELD_LABELS_DE,
  criterionFieldListDe,
  PLATFORM_LABELS_DE,
  platformConfiguredMessageDe,
  platformDisabledMessageDe,
  platformIncompleteConfigurationMessageDe,
} from '../platform-config.messages';

const ALL_CRITERION_FIELDS: readonly CriterionField[] = [
  'jobTitle',
  'titleSynonyms',
  'industry',
  'searchLocation',
  'searchRadiusKm',
  'employmentType',
  'publicationPeriodDays',
];

describe('platform configuration messages', () => {
  it('labels every Platform and every Criterion_Field', () => {
    for (const platform of PLATFORMS) {
      expect(PLATFORM_LABELS_DE[platform]).toMatch(/\S/);
    }

    for (const field of ALL_CRITERION_FIELDS) {
      expect(CRITERION_FIELD_LABELS_DE[field]).toMatch(/\S/);
    }
  });

  it('names every missing field with its German label and its identifier (4.10)', () => {
    expect(criterionFieldListDe(['jobTitle', 'searchLocation'])).toBe(
      'Jobtitel (jobTitle), Suchort (searchLocation)',
    );
  });

  it('reports a deactivated Platform by its brand spelling (4.7)', () => {
    expect(platformDisabledMessageDe('JOBVECTOR')).toContain('Plattform Jobvector');
    expect(platformDisabledMessageDe('JOBVECTOR')).toContain('deaktiviert');
  });

  it('reports an incomplete configuration with the platform name and the fields (4.9)', () => {
    const message = platformIncompleteConfigurationMessageDe('STEPSTONE', ['searchLocation']);

    expect(message).toContain('Stepstone: Konfiguration unvollständig, fehlende Felder:');
    expect(message).toContain('Suchort (searchLocation)');
    expect(message).toContain('übrigen Plattformen werden weiterhin abgefragt');
  });

  it('prints no Criterion_Field value in any message (14.9)', () => {
    const messages = [
      platformDisabledMessageDe('INDEED'),
      platformIncompleteConfigurationMessageDe('INDEED', ALL_CRITERION_FIELDS),
      platformConfiguredMessageDe('INDEED', 6),
    ].join(' ');

    for (const value of ['Projektmanagerin', 'Pharma and Life Science', 'München']) {
      expect(messages).not.toContain(value);
    }
  });
});
