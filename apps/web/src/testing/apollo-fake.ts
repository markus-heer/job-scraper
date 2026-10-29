import { ApolloClient } from '@apollo/client';
import { ApolloLink } from '@apollo/client/link';
import { MockLink } from '@apollo/client/testing';

import { createApolloCache } from '../apollo/cache';
import {
  AppInfoDocument,
  type AppInfoQuery,
} from '../components/PrivateUseNotice/app-info.generated';
import { isLogStreamOperation } from './log-stream-link';

/**
 * An Apollo Client that answers from a list instead of from a server.
 *
 * Every component test that renders the shell needs one, because the shell asks for `appInfo`
 * (Requirement 14.8) and `ApolloProvider` deliberately lives in `src/main.tsx` rather than in
 * `__root.tsx` — a provider baked into the root route would force every test through the real HTTP
 * and WebSocket transports.
 *
 * The cache is the *real* one from `src/apollo/cache.ts`, not a bare `InMemoryCache`: the type
 * policies under test (the `LogMessage` key of `(runId, sequence)`) are what make a redelivered
 * message collapse into one entry, and a test that swapped them out would be testing a different
 * application.
 *
 * It lives in `src/testing/` rather than in a `__tests__/` folder so that tasks 16.6, 17.7, 18.4
 * and 19.2 can reuse it; the Vitest `include` pattern covers `__tests__/**` only, so this file is
 * never run as a suite.
 */
export function createFakeApolloClient(
  mocks: readonly MockLink.MockedResponse[] = [],
  logStream?: ApolloLink,
): ApolloClient {
  // `delay: 0` keeps the answer on the next microtask rather than on a timer, so a test awaits
  // `findBy…` instead of advancing fake timers. `showWarnings` stays on: an operation the test
  // forgot to mock should be loud, because the silent alternative is a component stuck in its
  // loading state for reasons nobody can see.
  const answers = new MockLink(mocks, { defaultOptions: { delay: 0 } });

  return new ApolloClient({
    // A test of the Log_View needs two transports at once: the Log_Stream under its own control
    // (`./log-stream-link.ts`), because *when* a message arrives is the subject there, and ordinary
    // mocked answers for everything around it — the summary of 12.10, the cancellation of 12.7, the
    // shell's `appInfo`. `MockLink` cannot play a subscription that a test breaks and resumes, and
    // the Log_Stream fake answers nothing else, so the two are split by operation rather than
    // merged.
    link:
      logStream === undefined
        ? answers
        : ApolloLink.split(isLogStreamOperation, logStream, answers),
    cache: createApolloCache(),
  });
}

/**
 * The `appInfo` answer a test gets unless it asks for another one.
 *
 * The values are the documented defaults of the Job_Tool: the Home_Address and the 60-minute
 * Commute_Threshold of Requirement 8.10, and an activated Relevance_Service. The notice sentence is
 * the API_Service's to word (14.8), so what stands here is a stand-in with the right shape, not a
 * copy of the real wording — a test that asserted the production sentence through this fixture
 * would be asserting the fixture.
 *
 * No `__typename`: the generated `AppInfoQuery` does not carry one, because the operation does not
 * select it and `AppInfo` is not a normalized entity — it is a single nested object under
 * `ROOT_QUERY` with no identifier to key by.
 */
export const DEFAULT_APP_INFO: AppInfoQuery['appInfo'] = {
  privateUseNoticeDe: 'Dieses Werkzeug wird ausschließlich privat genutzt.',
  relevanceServiceActivated: true,
  homeAddress: 'Hörkherstraße 1d, 80689 München',
  commuteThresholdMinutes: 60,
};

/**
 * One mocked answer to the shell's `appInfo` query, with the fields a test cares about overridden.
 *
 * `maxUsageCount` is unbounded because the number of times the shell asks is not the subject of any
 * test here: a re-render, a navigation between routes or a React remount may repeat the query, and
 * a test that failed for that reason would be reporting on Apollo Client's caching rather than on
 * the view.
 */
export function appInfoMock(
  appInfo: Partial<AppInfoQuery['appInfo']> = {},
): MockLink.MockedResponse {
  return {
    request: { query: AppInfoDocument },
    maxUsageCount: Number.POSITIVE_INFINITY,
    result: { data: { appInfo: { ...DEFAULT_APP_INFO, ...appInfo } } },
  };
}
