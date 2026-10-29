import type { MockLink } from '@apollo/client/testing';
import { PLATFORMS } from '@job-scraper/domain';

import {
  SearchCriteriaDocument,
  type SearchCriteriaQuery,
} from '../components/CriteriaView/search-criteria.generated';
import type { Platform } from '../graphql/schema.generated';

/**
 * Mocked answers to `searchCriteria`, for the read-only criteria view of 4.11 to 4.13.
 *
 * In `src/testing/` rather than in a `__tests__/` folder because three suites need them: the view's
 * own tests, the landing-page test that navigates to `/criteria`, and the broader suite of task
 * 19.2. The Vitest `include` pattern covers `__tests__/**` only, so this file is never run as a
 * suite.
 *
 * The German texts below are the *API_Service's* — a Platform_Status label, the sentence explaining a
 * configuration state, and each resolved value. They are stand-ins with the right shape rather than
 * copies of the production wording, the same way `DEFAULT_APP_INFO` handles the notice of 14.8: a
 * test that asserted the real sentence through this fixture would be asserting the fixture. A test
 * that is about one of those texts reads it back from the mock it passed.
 */

/** One resolved criterion as `search-criteria.graphql` selects it, plus its `__typename`. */
export type MockedCriterion = SearchCriteriaQuery['searchCriteria'][number]['criteria'][number] & {
  readonly __typename: 'EffectiveCriterion';
};

/** One Platform block as `search-criteria.graphql` selects it, plus its `__typename`. */
export type MockedPlatformCriteria = Omit<
  SearchCriteriaQuery['searchCriteria'][number],
  'criteria' | '__typename'
> & {
  readonly __typename: 'PlatformSearchCriteria';
  readonly criteria: readonly MockedCriterion[];
};

/**
 * The criteria of a Platform that resolved completely: one value from each of the two sources.
 *
 * Two entries are enough for every assertion about a row — a field, its German value and exactly
 * one provenance label — and both sources appear, so a block built from this default can carry the
 * mutual exclusivity of 4.12 on its own.
 */
export const DEFAULT_MOCKED_CRITERIA: readonly MockedCriterion[] = [
  {
    __typename: 'EffectiveCriterion',
    field: 'jobTitle',
    valueText: 'Projektmanagerin',
    provenance: 'DEFAULT',
  },
  {
    __typename: 'EffectiveCriterion',
    field: 'searchRadiusKm',
    valueText: '30 km',
    provenance: 'OVERRIDE',
  },
];

/** One Platform block, with the fields of a test overridden. */
export function platformCriteria(
  platform: Platform,
  overrides: Partial<Omit<MockedPlatformCriteria, '__typename' | 'platform'>> = {},
): MockedPlatformCriteria {
  return {
    __typename: 'PlatformSearchCriteria',
    platform,
    platformStatusLabelDe: 'noch nicht abgefragt',
    configurationHintDe: null,
    missingMandatoryFields: [],
    criteria: DEFAULT_MOCKED_CRITERIA,
    ...overrides,
  };
}

/**
 * One mocked answer to the `searchCriteria` query of the criteria view.
 *
 * Defaults to all four Platform configured and ready, the delivered state of the Job_Tool. A test
 * that is about a deactivated Platform or an incomplete configuration passes the blocks it means.
 *
 * `maxUsageCount` is unbounded because the number of times the view asks is not the subject of any
 * test: a re-render or a navigation back to the route may repeat the query, and a test that failed
 * for that reason would be reporting on Apollo Client's caching rather than on the view.
 *
 * `delay` exists for one case: `Number.POSITIVE_INFINITY` makes this answer never arrive, which is
 * how a test holds the view in its loading state long enough to assert on it. A finite delay would
 * leave a timer running past the end of the test.
 *
 * The block order is the caller's and is passed through unchanged, because the API_Service answers
 * in `PLATFORMS` order and the view has to show what it was given rather than a sorting of its own.
 */
export function searchCriteriaMock(
  blocks: readonly MockedPlatformCriteria[] = PLATFORMS.map((platform) =>
    platformCriteria(platform),
  ),
  options: { readonly delay?: number } = {},
): MockLink.MockedResponse {
  return {
    request: { query: SearchCriteriaDocument },
    delay: options.delay ?? 0,
    maxUsageCount: Number.POSITIVE_INFINITY,
    result: { data: { searchCriteria: blocks } },
  };
}
