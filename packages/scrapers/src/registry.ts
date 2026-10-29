/**
 * The Platform_Adapter registry (6.1, 6.6).
 *
 * Adding a Platform_Adapter means adding one entry to {@link ADAPTERS}. Nothing else: the
 * Scraper_Service reads the registry through {@link ALL_PLATFORM_ADAPTERS} and never names a Platform
 * itself, which is what 6.6 asks for.
 *
 * Why a record keyed by Platform rather than the flat array the design sketches: the key *is* the
 * "exactly once per Platform" rule of 6.1. A second entry for the same Platform is a duplicate object
 * key and therefore a compile error, whereas in an array it would be two silently competing adapters.
 * The array the Scraper_Service consumes is derived from the record, so there is still exactly one
 * place to edit.
 *
 * Why the record is partial: the four adapters land in separate tasks (Stepstone 9.1, Jobvector 10.1,
 * Glassdoor 23.1, Indeed 24.1) and Glassdoor and Indeed are best-effort work. The registry therefore
 * has to be usable while empty or partially filled, so a missing Platform is a value-level fact that
 * {@link platformsWithoutAdapter} reports rather than a build failure — the Scraper_Service and its
 * tests still rely on that, and a caller may hand in a partially filled registry of its own.
 *
 * With task 24.1 the fourth adapter is registered, so {@link ADAPTERS} now additionally
 * `satisfies CompleteAdapterRegistry`: 6.1 is from here on a compile-time check as well, and removing
 * an adapter — or adding a Platform without one — fails the type check instead of quietly producing a
 * Scrape_Run that skips a Platform.
 */

import { type Platform, type PlatformCapabilityMap, PLATFORMS } from '@job-scraper/domain';

import type { PlatformAdapter } from './adapter/types.js';
import { GlassdoorAdapter } from './adapters/glassdoor/index.js';
import { IndeedAdapter } from './adapters/indeed/index.js';
import { JobvectorAdapter } from './adapters/jobvector/index.js';
import { StepstoneAdapter } from './adapters/stepstone/index.js';

/**
 * The adapter type of exactly one Platform: a {@link PlatformAdapter} over the capability declaration
 * of that Platform, so `resultListUrl` sees the Criterion_Field this Platform actually supports (4.2).
 */
export type PlatformAdapterFor<P extends Platform> = PlatformAdapter<PlatformCapabilityMap[P]>;

/** At most one Platform_Adapter per Platform, keyed by Platform (6.1). */
export type AdapterRegistry = {
  readonly [P in Platform]?: PlatformAdapterFor<P>;
};

/** A registry that covers every Platform; the target state of 6.1. See the file comment. */
export type CompleteAdapterRegistry = {
  readonly [P in Platform]: PlatformAdapterFor<P>;
};

/**
 * Every registered Platform_Adapter. One entry per Platform_Adapter, and the only place that changes
 * when one is added (6.6). Complete since task 24.1; see the file comment for what the `satisfies`
 * adds over the declared type.
 */
export const ADAPTERS: AdapterRegistry = {
  STEPSTONE: new StepstoneAdapter(),
  JOBVECTOR: new JobvectorAdapter(),
  GLASSDOOR: new GlassdoorAdapter(),
  INDEED: new IndeedAdapter(),
} satisfies CompleteAdapterRegistry;

/**
 * The Platform_Adapter of one Platform.
 *
 * @param platform The Platform to look up.
 * @param registry The registry to read; injectable so tests can register fake adapters.
 * @returns The adapter, or `undefined` while no adapter is registered for that Platform.
 */
export function adapterFor<P extends Platform>(
  platform: P,
  registry: AdapterRegistry = ADAPTERS,
): PlatformAdapterFor<P> | undefined {
  return registry[platform];
}

/**
 * Every registered Platform_Adapter, in `PLATFORMS` order.
 *
 * Iterating the Platform list rather than the registry keys makes the order independent of the order
 * the entries happen to be written in, which keeps the adapter sequence of a Scrape_Run deterministic.
 */
export function platformAdapters(registry: AdapterRegistry = ADAPTERS): readonly PlatformAdapter[] {
  return PLATFORMS.flatMap((platform) => registry[platform] ?? []);
}

/** The Platform that have an adapter, in `PLATFORMS` order. */
export function registeredPlatforms(registry: AdapterRegistry = ADAPTERS): readonly Platform[] {
  return PLATFORMS.filter((platform) => registry[platform] !== undefined);
}

/**
 * The Platform that have no adapter yet, in `PLATFORMS` order. Empty once 6.1 is met; until then the
 * Scraper_Service reports these Platform instead of silently omitting them.
 */
export function platformsWithoutAdapter(registry: AdapterRegistry = ADAPTERS): readonly Platform[] {
  return PLATFORMS.filter((platform) => registry[platform] === undefined);
}

/**
 * The registered adapters as the Scraper_Service consumes them: a plain list, injected through the
 * Nest provider of the API_Service, so that the service never knows which Platform exist (6.6).
 */
export const ALL_PLATFORM_ADAPTERS: readonly PlatformAdapter[] = platformAdapters();
