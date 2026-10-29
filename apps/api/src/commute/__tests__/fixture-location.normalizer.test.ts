/**
 * What the fixture Location_Normalizer answers, and that it answers without a request (8.6, task
 * 21.1).
 *
 * The double exists so an E2E run can reach the 8.6 path at all: `pnpm test:e2e` makes no external
 * request, and an unbound token would silently put a fixture-mode run on the 8.5 branch instead.
 * These assertions pin the rule a seeded E2E expectation depends on — the last capitalised word, the
 * `UNRESOLVABLE` markers, and the one marker that answers `FAILED` so the outcome that records
 * nothing is reachable too.
 *
 * Requirements: 8.6, 8.7, 8.8.
 */

import { describe, expect, it } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import { FixtureModeViolationError } from '../../config/fixture-mode';
import { LOCATION_PLACE_NAME_MAX_LENGTH } from '../anthropic-location.schema';
import {
  FIXTURE_LOCATION_NORMALIZER_NAME,
  FIXTURE_NORMALIZATION_FAILURE_MARKER,
  FIXTURE_UNRESOLVABLE_LOCATION_MARKERS,
  FixtureLocationNormalizer,
  fixturePlaceNameOf,
} from '../fixture-location.normalizer';

/** The configuration of a fixture-mode process. */
const FIXTURE_ENV = { scraperFixtureMode: true } as unknown as EnvConfig;

const normalizer = (): FixtureLocationNormalizer => new FixtureLocationNormalizer(FIXTURE_ENV);

const signal = (): AbortSignal => new AbortController().signal;

describe('fixturePlaceNameOf', () => {
  it('takes the last capitalised word, where a German free-text value puts the place', () => {
    expect(fixturePlaceNameOf('Zentrale im Süden von München')).toBe('München');
    expect(fixturePlaceNameOf('unser Standort im Großraum Nürnberg')).toBe('Nürnberg');
  });

  it('ignores a short capitalised fragment, which is an abbreviation and not a town', () => {
    expect(fixturePlaceNameOf('Standort München, DE')).toBe('München');
  });

  it('answers null for a value with no capitalised word', () => {
    expect(fixturePlaceNameOf('irgendwo im süden')).toBeNull();
    expect(fixturePlaceNameOf('   ')).toBeNull();
  });

  it('never answers a name longer than the bound the schema and the store share', () => {
    const name = fixturePlaceNameOf(`Standort ${'M'.repeat(LOCATION_PLACE_NAME_MAX_LENGTH + 50)}`);

    expect(name).not.toBeNull();
    expect(name).toHaveLength(LOCATION_PLACE_NAME_MAX_LENGTH);
  });
});

describe('FixtureLocationNormalizer', () => {
  it('reports a recognisable name that is never an API key (14.9)', () => {
    expect(normalizer().name).toBe(FIXTURE_LOCATION_NORMALIZER_NAME);
  });

  it('normalizes a free-text work location to the place it names', async () => {
    await expect(
      normalizer().normalize('Zentrale im Süden von München', signal()),
    ).resolves.toEqual({ kind: 'NORMALIZED', placeName: 'München' });
  });

  it('answers UNRESOLVABLE for each marker, which is the recorded dead end of 8.6', async () => {
    for (const marker of FIXTURE_UNRESOLVABLE_LOCATION_MARKERS) {
      await expect(
        normalizer().normalize(`unser Team arbeitet ${marker}`, signal()),
      ).resolves.toEqual({ kind: 'UNRESOLVABLE' });
    }
  });

  it('answers UNRESOLVABLE for a value that names no place at all', async () => {
    await expect(normalizer().normalize('irgendwo im süden', signal())).resolves.toEqual({
      kind: 'UNRESOLVABLE',
    });
  });

  it('answers FAILED for the failure marker, so the recording-nothing path is reachable', async () => {
    await expect(
      normalizer().normalize(`Standort ${FIXTURE_NORMALIZATION_FAILURE_MARKER} München`, signal()),
    ).resolves.toEqual({ kind: 'FAILED' });
  });

  it('answers FAILED for a cancelled Scrape_Run, so nothing is recorded for the value', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      normalizer().normalize('Zentrale bei München', controller.signal),
    ).resolves.toEqual({ kind: 'FAILED' });
  });

  it('refuses to be constructed outside fixture mode', () => {
    const env = { scraperFixtureMode: false } as unknown as EnvConfig;

    expect(() => new FixtureLocationNormalizer(env)).toThrow(FixtureModeViolationError);
  });
});
