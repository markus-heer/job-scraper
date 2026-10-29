/**
 * The search criteria constants.
 *
 * The Default_Search_Profile is exactly one typed constant (3.1) and is available to every
 * Scrape_Run without user input and independently of the Posting_Store content (3.3). A developer
 * edits this file and restarts the API_Service; the change takes effect from the next start (3.9).
 */

import type { Platform } from '../enums.js';
import type { PlatformOverrideMap } from './capabilities.js';
import type { SearchProfile } from './types.js';

/**
 * The Default_Search_Profile: project manager in the pharmaceutical field in and around Munich
 * (3.1, 3.2). The value ranges are enforced by `validateDefaultSearchProfile` at API_Service
 * startup: job title, industry and search location at most 100 characters each, search radius an
 * integer from 1 to 200 kilometres, 4 to 20 title synonyms of 2 to 100 characters each.
 */
export const DEFAULT_SEARCH_PROFILE: SearchProfile = {
  jobTitle: 'Projektmanagerin',
  titleSynonyms: [
    'Projektmanager',
    'Project Manager',
    'Projektleiterin',
    'Projektleiter',
    'Project Lead',
    'Teilprojektleiterin',
  ],
  industry: 'Pharma and Life Science',
  searchLocation: 'München',
  searchRadiusKm: 50,
  employmentType: 'PERMANENT',
  publicationPeriodDays: 30,
};

/** Activation per Platform (4.6). A deactivated Platform yields Platform_Status "disabled" (4.7). */
export const PLATFORM_ACTIVATION: Readonly<Record<Platform, boolean>> = {
  STEPSTONE: true,
  JOBVECTOR: true,
  /**
   * Deactivated since task 25.2, and this is a decision rather than an oversight.
   *
   * de.indeed.com answers the honest Job_Tool user agent with HTTP 403 and a Cloudflare security
   * check — three attempts on 2026-10-29, and the one `CAPTURED` fixture of that Platform is the
   * challenge page itself. An activated Indeed therefore costs every Scrape_Run a robots.txt
   * retrieval, a page request, a browser page and a `PLATFORM_BLOCKED` warning in the Log_View, for
   * a result it does not get.
   *
   * The warning is what settles it. A warning on every single run is a warning the user learns to
   * scroll past, and the Log_View has real warnings in it. Recovery is detected by running the
   * opt-in live smoke suite (`pnpm test:live`), which asks the Platform once on purpose, not by
   * paying for a 403 on every run. `docs/adapters/indeed.md` records both sides.
   *
   * Nothing else changes: the adapter stays registered, its fixtures and its tests stay, and
   * flipping this back to `true` is the whole of reactivating the Platform. A deactivated Platform
   * yields Platform_Status "disabled" (4.7), which the Scrape_Run summary states as such.
   */
  INDEED: false,
  GLASSDOOR: true,
};

/**
 * At most one Platform_Override per Platform (4.1). Each override sets only those Criterion_Field
 * that replace the Default_Search_Profile value; every unset field is taken from the
 * Default_Search_Profile by the Profile_Resolver (4.3).
 */
export const PLATFORM_OVERRIDES: PlatformOverrideMap = {
  // Stepstone's radius selector offers discrete steps; 30 km keeps the result list focused on Munich.
  STEPSTONE: { searchRadiusKm: 30 },
  // Jobvector is an industry-specific board, so the industry filter is redundant there.
  JOBVECTOR: { searchLocation: 'München', searchRadiusKm: 50 },
  // Compile error on purpose if uncommented: GLASSDOOR does not declare `employmentType` as supported.
  // GLASSDOOR: { employmentType: 'PERMANENT' },
  // Compile error on purpose if uncommented as well: INDEED no longer declares `searchRadiusKm`,
  // because its robots.txt forbids a result list URL that states a radius (14.2). See the capability
  // declaration in `./capabilities.ts`.
  // INDEED: { searchRadiusKm: 50 },
};
