/**
 * The Platform_Adapter registry (6.1, 6.6).
 *
 * Two things are checked: the registry stays usable while the four adapters are still being built
 * (tasks 9.1, 10.1, 23.1, 24.1), and registration alone is enough — the derived list the
 * Scraper_Service consumes follows the registry without a second place to edit.
 */

import { type Platform, PLATFORM_CAPABILITIES, PLATFORMS } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { buildAdapterResult } from '../adapter/types.js';
import {
  adapterFor,
  type AdapterRegistry,
  ADAPTERS,
  ALL_PLATFORM_ADAPTERS,
  type PlatformAdapterFor,
  platformAdapters,
  platformsWithoutAdapter,
  registeredPlatforms,
} from '../registry.js';

/** A Platform_Adapter that registers and answers, with no retrieval behind it. */
function fakeAdapter<P extends Platform>(platform: P): PlatformAdapterFor<P> {
  return {
    capability: PLATFORM_CAPABILITIES[platform],
    resultListUrl: (_profile, pageNumber) =>
      `https://example.test/${platform}?page=${String(pageNumber)}`,
    fetch: () =>
      Promise.resolve(
        buildAdapterResult({
          platform,
          postings: [],
          platformStatus: 'COMPLETED',
          pagesFetched: 0,
        }),
      ),
  };
}

describe('the registry as it ships today', () => {
  it('is readable while the adapters are still being added', () => {
    expect(ALL_PLATFORM_ADAPTERS).toHaveLength(registeredPlatforms().length);
    expect([...registeredPlatforms(), ...platformsWithoutAdapter()].sort()).toEqual(
      [...PLATFORMS].sort(),
    );
  });

  it('registers every Platform at most once, under its own Platform key (6.1)', () => {
    for (const platform of registeredPlatforms()) {
      expect(adapterFor(platform)?.capability.platform).toBe(platform);
    }

    expect(new Set(ALL_PLATFORM_ADAPTERS).size).toBe(ALL_PLATFORM_ADAPTERS.length);
    expect(Object.keys(ADAPTERS).every((key) => PLATFORMS.includes(key as Platform))).toBe(true);
  });
});

describe('an empty registry', () => {
  it('yields no adapter and names every Platform as unserved', () => {
    expect(platformAdapters({})).toEqual([]);
    expect(registeredPlatforms({})).toEqual([]);
    expect(platformsWithoutAdapter({})).toEqual([...PLATFORMS]);
    expect(adapterFor('STEPSTONE', {})).toBeUndefined();
  });
});

describe('a partially filled registry', () => {
  const registry: AdapterRegistry = {
    // Written in an order that differs from PLATFORMS on purpose.
    STEPSTONE: fakeAdapter('STEPSTONE'),
    JOBVECTOR: fakeAdapter('JOBVECTOR'),
  };

  it('serves the registered Platform and reports the rest', () => {
    expect(registeredPlatforms(registry)).toEqual(['JOBVECTOR', 'STEPSTONE']);
    expect(platformsWithoutAdapter(registry)).toEqual(['GLASSDOOR', 'INDEED']);
  });

  it('derives the adapter list in PLATFORMS order, each adapter exactly once', () => {
    const adapters = platformAdapters(registry);

    expect(adapters.map((adapter) => adapter.capability.platform)).toEqual([
      'JOBVECTOR',
      'STEPSTONE',
    ]);
    expect(new Set(adapters).size).toBe(adapters.length);
  });

  it('hands out the adapter of one Platform', async () => {
    const adapter = adapterFor('STEPSTONE', registry);

    expect(adapter).toBe(registry.STEPSTONE);

    const result = await adapter?.fetch({
      runId: 'run-1',
      runStartedAt: new Date('2026-03-02T08:00:00.000Z'),
      profile: { platform: 'STEPSTONE', criteria: [] },
      openPage: () => Promise.reject(new Error('The fake adapter opens no page.')),
      pageBudget: 10,
      pageTimeoutMs: 30_000,
      log: () => {},
      signal: new AbortController().signal,
    });

    expect(result?.platformStatus).toBe('COMPLETED');
    expect(result?.partialResult).toBe(false);
  });
});
