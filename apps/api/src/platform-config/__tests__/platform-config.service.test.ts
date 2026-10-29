/**
 * What the API_Service logs and holds after the per-Platform determination (4.6 - 4.10).
 *
 * The determination itself is covered next to the pure function; what matters here is the part the
 * user and the later readers see: one German line per Platform, a deactivated Platform reported as
 * `disabled` and an incompletely configured one reported with the missing field names, plus a
 * singleton the Scraper_Service and the `searchCriteria` query can read the same answer from
 * (4.10, 4.11).
 *
 * Requirements: 4.6, 4.7, 4.9, 4.10, 14.9.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DOMAIN_PLATFORM_CONFIGURATION_INPUTS } from '../platform-config.module';
import { PlatformConfigurationService } from '../platform-config.service';
import { ALL_ACTIVATED, defaultsWithout, inputs, startWith } from './platform-config.fixture';

const withoutSearchLocation = () => defaultsWithout('searchLocation');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('PlatformConfigurationService', () => {
  it('holds one state per Platform before the lifecycle hook ran (4.8)', () => {
    const service = new PlatformConfigurationService(inputs());

    expect(service.states()).toHaveLength(4);
    expect(service.stateOf('STEPSTONE').platformStatus).toBe('NOT_YET_RUN');
  });

  it('logs a deactivated Platform in German as not being queried (4.6, 4.7)', () => {
    const { service, logLines } = startWith(
      inputs({ activation: { ...ALL_ACTIVATED, GLASSDOOR: false } }),
    );

    expect(service.stateOf('GLASSDOOR').platformStatus).toBe('DISABLED');
    expect(logLines).toContainEqual(
      'platform.disabled: Plattform Glassdoor ist im Quellcode deaktiviert und wird in einem ' +
        'Suchlauf nicht abgefragt.',
    );
  });

  it('logs an incomplete configuration in German with the missing field names (4.9, 4.10)', () => {
    const { service, errorLines } = startWith(inputs({ defaults: withoutSearchLocation() }));

    expect(service.stateOf('STEPSTONE').platformStatus).toBe('INCOMPLETE_CONFIGURATION');
    expect(errorLines).toContainEqual(
      'platform.incompleteConfiguration: Stepstone: Konfiguration unvollständig, fehlende Felder: ' +
        'Suchort (searchLocation). Diese Plattform wird in einem Suchlauf übersprungen, die ' +
        'übrigen Plattformen werden weiterhin abgefragt.',
    );
  });

  it('writes exactly one line per Platform (4.8)', () => {
    const { logLines, errorLines } = startWith(
      inputs({
        defaults: withoutSearchLocation(),
        activation: { ...ALL_ACTIVATED, GLASSDOOR: false },
      }),
    );

    // GLASSDOOR disabled and JOBVECTOR configured on the info channel, INDEED and STEPSTONE
    // incomplete on the error channel.
    expect(logLines).toHaveLength(2);
    expect(errorLines).toHaveLength(2);
  });

  it('offers only the activated and completely configured Platform for a Scrape_Run (4.7, 4.10)', () => {
    const { service } = startWith(
      inputs({
        defaults: withoutSearchLocation(),
        activation: { ...ALL_ACTIVATED, GLASSDOOR: false },
      }),
    );

    expect(service.scrapablePlatforms().map((state) => state.platform)).toEqual(['JOBVECTOR']);
    expect(service.incompletePlatforms().map((state) => state.platform)).toEqual([
      'INDEED',
      'STEPSTONE',
    ]);
  });

  it('hands the Scraper_Service the profile and the missing fields it has to report (4.10)', () => {
    const service = new PlatformConfigurationService(inputs({ defaults: withoutSearchLocation() }));

    expect(service.effectiveProfileOf('STEPSTONE')).toBeNull();
    expect(service.missingMandatoryFieldsOf('STEPSTONE')).toEqual(['searchLocation']);
    expect(service.effectiveProfileOf('JOBVECTOR')?.platform).toBe('JOBVECTOR');
    expect(service.missingMandatoryFieldsOf('JOBVECTOR')).toEqual([]);
  });

  it('determines the delivered constants as completely configured, with Indeed deactivated', () => {
    const { service, errorLines } = startWith(DOMAIN_PLATFORM_CONFIGURATION_INPUTS);

    // Every Platform resolves: no Platform is incompletely configured, so nothing reaches the error
    // channel (4.9, 4.10).
    expect(errorLines).toEqual([]);
    expect(service.incompletePlatforms()).toEqual([]);

    // Three of the four are offered for a Scrape_Run. `PLATFORM_ACTIVATION.INDEED` is `false` since
    // task 25.2, because de.indeed.com answers the honest user agent with HTTP 403 and a Cloudflare
    // check, so an activated Indeed would cost every run a request and a `PLATFORM_BLOCKED` warning
    // for a result it does not get. The constant carries the full reasoning and
    // `docs/adapters/indeed.md` records the decision; this assertion is what keeps it deliberate.
    expect(service.scrapablePlatforms().map((state) => state.platform)).toEqual([
      'GLASSDOOR',
      'JOBVECTOR',
      'STEPSTONE',
    ]);
  });
});
