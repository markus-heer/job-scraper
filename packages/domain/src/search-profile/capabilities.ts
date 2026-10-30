/**
 * The per-Platform capability declaration (4.2).
 *
 * Each Platform declares the Criterion_Field it can express in its result list query and the subset
 * it requires as mandatory. `definePlatformCapability` keeps both tuples as literals, which is what
 * makes `PlatformOverrideMap` precise enough to satisfy Requirement 4.5: a Platform_Override that
 * sets a Criterion_Field its Platform does not support fails the type check.
 */

import type { Platform } from '../enums.js';
import {
  definePlatformCapability,
  type PlatformCapability,
  type PlatformOverrideFor,
} from './types.js';

/** What each of the four Platform supports and requires (4.2). */
export const PLATFORM_CAPABILITIES = {
  GLASSDOOR: definePlatformCapability({
    platform: 'GLASSDOOR',
    supportedFields: ['jobTitle', 'titleSynonyms', 'searchLocation', 'searchRadiusKm'],
    mandatoryFields: ['jobTitle', 'searchLocation'],
  }),
  JOBVECTOR: definePlatformCapability({
    platform: 'JOBVECTOR',
    supportedFields: ['jobTitle', 'titleSynonyms', 'industry', 'searchLocation', 'searchRadiusKm'],
    mandatoryFields: ['jobTitle'],
  }),
  // `searchRadiusKm` is deliberately absent although Indeed's result list offers a radius selector:
  // the `User-agent: *` group of https://de.indeed.com/robots.txt carries `Disallow: /*radius=`, so a
  // URL stating a radius is one the Job_Tool may not request (14.2). A Criterion_Field that is declared
  // but never reaches the query would make the read-only criteria view of 4.11 claim a filter the
  // retrieval did not apply, so the declaration follows the URL builder. See
  // `packages/scrapers/src/adapters/indeed/result-list-url.ts` and `docs/adapters/indeed.md`.
  INDEED: definePlatformCapability({
    platform: 'INDEED',
    supportedFields: [
      'jobTitle',
      'titleSynonyms',
      'searchLocation',
      'employmentType',
      'publicationPeriodDays',
    ],
    mandatoryFields: ['jobTitle', 'searchLocation'],
  }),
  // `searchRadiusKm`, `employmentType` and `publicationPeriodDays` are deliberately absent although
  // Stepstone's search form offers all three. Its robots.txt permits the result list path with
  // **exactly one** query parameter — `Allow: /jobs/*?q=*` against `Disallow: /jobs/*?*` and
  // `Disallow: /jobs/*?q*&*` — so a URL stating a second one is a URL the Job_Tool may not request
  // (14.2). Measured on 2026-10-29; the full decision table is in
  // `packages/scrapers/src/adapters/stepstone/result-list-url.ts`. A Criterion_Field that is declared
  // but never reaches the query would make the read-only criteria view of 4.11 claim a filter the
  // retrieval did not apply, so the declaration follows the URL builder. Same shape, same reason as
  // the `INDEED` entry above.
  STEPSTONE: definePlatformCapability({
    platform: 'STEPSTONE',
    supportedFields: ['jobTitle', 'titleSynonyms', 'searchLocation'],
    mandatoryFields: ['jobTitle', 'searchLocation'],
  }),
} as const satisfies { readonly [P in Platform]: PlatformCapability };

export type PlatformCapabilityMap = typeof PLATFORM_CAPABILITIES;

/** At most one Platform_Override per Platform, at most four in total (4.1). */
export type PlatformOverrideMap = {
  readonly [P in Platform]?: PlatformOverrideFor<PlatformCapabilityMap[P]>;
};
