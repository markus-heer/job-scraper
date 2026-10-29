import type { ApolloLink } from '@apollo/client/link';
import { ApolloProvider } from '@apollo/client/react';
import type { MockLink } from '@apollo/client/testing';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';

import { type AppRouter, createAppRouter } from '../router';
import { appInfoMock, createFakeApolloClient } from './apollo-fake';
import { activeScrapeRunMock, latestScrapeRunMock } from './run-mocks';

/**
 * Renders the whole application — shell plus the view of one route — under a mocked Apollo Client.
 *
 * Every component test of a route needs these three pieces together, and they have to be assembled
 * in this order: a memory history so the test starts on the route it is about, a router built from
 * the generated route tree so the shell of `__root.tsx` is really the shell under test, and an
 * `ApolloProvider` around both because `ApolloProvider` deliberately lives in `src/main.tsx` and
 * not in the root route (see `src/testing/apollo-fake.ts`).
 *
 * The default mock list answers the three queries a view does not ask for itself: the shell's
 * `appInfo` (14.8), `activeScrapeRun`, which "Suchlauf starten" reads wherever it stands — the
 * landing page of 2.2 and the empty state of 10.12 — and `latestScrapeRun`, which "Log öffnen"
 * falls back to while no Scrape_Run is running. All three default to the quiet state: the documented
 * configuration, no Scrape_Run running and none completed. Without them every test of a view would
 * have to know what the shell and the run controls ask for, which is their business and not the
 * view's. A test that is *about* one of those answers passes its own list and replaces the default.
 *
 * Returns the router, so a test can await `router.load()` or assert the location after a
 * navigation.
 *
 * `options` carries the two things only the Log_View needs: its own transport for the Log_Stream,
 * and history entries before the route under test. See {@link RenderAppOptions}.
 */
export function renderAppAt(
  path: string,
  mocks: readonly MockLink.MockedResponse[] = [
    appInfoMock(),
    activeScrapeRunMock(null),
    latestScrapeRunMock(null),
  ],
  options: RenderAppOptions = {},
): AppRouter {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [...(options.previousPaths ?? []), path] }),
  );

  render(
    <ApolloProvider client={createFakeApolloClient(mocks, options.logStream)}>
      <RouterProvider router={router} />
    </ApolloProvider>,
  );

  return router;
}

/** The two things a test of the Log_View needs that no other view does. */
export interface RenderAppOptions {
  /**
   * The Log_Stream transport, for a test that drives the two halves of it itself.
   *
   * `MockLink` cannot play a subscription a test breaks and resumes, so the Log_Stream goes through
   * `FakeLogStreamLink` while everything else keeps answering from the mock list — see
   * `createFakeApolloClient`.
   */
  readonly logStream?: ApolloLink;

  /**
   * Entries to put into the history *before* `path`, so the route under test was navigated to
   * rather than entered directly.
   *
   * The difference matters for exactly one view: the Log_View overlay closes by going back where
   * there is somewhere to go back to, and leads to the posting overview where there is not (12.8).
   * Both cases are real — a pasted URL is the second one — and `useCanGoBack` tells them apart from
   * the history, which is why the history has to be set up rather than asserted around.
   */
  readonly previousPaths?: readonly string[];
}
