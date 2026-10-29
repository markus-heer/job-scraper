/**
 * That one incompletely configured Platform costs exactly that Platform (4.9, 4.10).
 *
 * The status mapping itself is covered next to the pure determination and the German wording next
 * to the service. What this suite is about is the *scope* of the defect, which is the half of 4.9
 * that is easy to implement by accident and easy to lose later: the API_Service keeps serving the
 * remaining Platform. Three properties carry that promise, and none of them is visible from a
 * single-Platform case —
 *
 * - each Platform is judged against its own mandatory Criterion_Field, so the missing-field list of
 *   one Platform says nothing about another's status;
 * - a Platform_Override can close the gap for its own Platform only (4.3);
 * - the determination stays total over `PLATFORMS`, so an incomplete Platform never shortens the
 *   list the Scraper_Service and the criteria view read (4.8, 4.11).
 *
 * Requirements: 4.3, 4.8, 4.9, 4.10, 5.8.
 */

import { PLATFORM_CAPABILITIES, PLATFORMS } from '@job-scraper/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePlatformConfigurations } from '../platform-config.resolve';
import {
  ALL_ACTIVATED,
  defaultsWithout,
  inputs,
  platformsWithStatus,
  startWith,
  stateOf,
} from './platform-config.fixture';

/** Every Platform declares `jobTitle` as mandatory, so removing it breaks all four at once. */
const WITHOUT_JOB_TITLE = defaultsWithout('jobTitle');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('an incomplete configuration of one Platform', () => {
  it('is judged against the own mandatory fields of that Platform (4.9, 4.10)', () => {
    // Jobvector requires `jobTitle` only; the other three additionally require `searchLocation`.
    const states = resolvePlatformConfigurations(
      inputs({ defaults: defaultsWithout('jobTitle', 'searchLocation') }),
    );

    expect(stateOf(states, 'JOBVECTOR').missingMandatoryFields).toEqual(['jobTitle']);

    for (const platform of ['GLASSDOOR', 'INDEED', 'STEPSTONE'] as const) {
      expect(stateOf(states, platform).missingMandatoryFields).toEqual([
        'jobTitle',
        'searchLocation',
      ]);
    }
  });

  it('names every missing field of that Platform in the German line (4.9)', () => {
    const { errorLines } = startWith(
      inputs({ defaults: defaultsWithout('jobTitle', 'searchLocation') }),
    );
    const stepstone = errorLines.find((line) => line.includes('Stepstone')) ?? '';

    expect(stepstone).toContain('Konfiguration unvollständig');
    expect(stepstone).toContain('Jobtitel (jobTitle)');
    expect(stepstone).toContain('Suchort (searchLocation)');
    expect(stepstone).toContain('die übrigen Plattformen werden weiterhin abgefragt.');
  });

  it('reports one line per affected Platform, naming each of them (4.9)', () => {
    const { errorLines } = startWith(inputs({ defaults: WITHOUT_JOB_TITLE }));

    expect(errorLines).toHaveLength(PLATFORMS.length);

    for (const label of ['Glassdoor', 'Jobvector', 'Indeed', 'Stepstone']) {
      expect(errorLines.filter((line) => line.includes(label))).toHaveLength(1);
    }
  });

  it('leaves the remaining Platform served with complete criteria (4.9)', () => {
    // Only Stepstone gets the mandatory job title back, and only through its own override (4.3).
    const states = resolvePlatformConfigurations(
      inputs({
        defaults: WITHOUT_JOB_TITLE,
        overrides: { STEPSTONE: { jobTitle: 'Projektmanagerin' } },
      }),
    );

    expect(platformsWithStatus(states, 'NOT_YET_RUN')).toEqual(['STEPSTONE']);
    expect(platformsWithStatus(states, 'INCOMPLETE_CONFIGURATION')).toEqual([
      'GLASSDOOR',
      'JOBVECTOR',
      'INDEED',
    ]);

    const stepstone = stateOf(states, 'STEPSTONE');

    expect(stepstone.effectiveProfile?.criteria.map((criterion) => criterion.field)).toEqual(
      PLATFORM_CAPABILITIES.STEPSTONE.supportedFields,
    );
    expect(stepstone.missingMandatoryFields).toEqual([]);
  });

  it('keeps a state for every Platform, so no reader sees a shortened list (4.8, 4.11)', () => {
    const { service } = startWith(
      inputs({
        defaults: WITHOUT_JOB_TITLE,
        overrides: { STEPSTONE: { jobTitle: 'Projektmanagerin' } },
        activation: { ...ALL_ACTIVATED, GLASSDOOR: false },
      }),
    );

    expect(service.states().map((state) => state.platform)).toEqual([...PLATFORMS]);
    expect(service.scrapablePlatforms().map((state) => state.platform)).toEqual(['STEPSTONE']);
    expect(service.incompletePlatforms().map((state) => state.platform)).toEqual([
      'JOBVECTOR',
      'INDEED',
    ]);
    expect(service.stateOf('GLASSDOOR').platformStatus).toBe('DISABLED');
  });

  it('does not stop the startup, unlike an invalid Default_Search_Profile (4.9 vs 3.6)', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const { service } = startWith(inputs({ defaults: WITHOUT_JOB_TITLE }));

    expect(exit).not.toHaveBeenCalled();
    expect(service.incompletePlatforms()).toHaveLength(PLATFORMS.length);
  });

  it('hands the Scraper_Service the missing field names it has to report in the run result (4.10)', () => {
    const { service } = startWith(inputs({ defaults: WITHOUT_JOB_TITLE }));

    expect(service.effectiveProfileOf('INDEED')).toBeNull();
    expect(service.missingMandatoryFieldsOf('INDEED')).toEqual(['jobTitle']);
  });
});
