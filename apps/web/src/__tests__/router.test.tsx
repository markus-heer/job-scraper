import { ApolloProvider } from '@apollo/client/react';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createAppRouter } from '../router';
import { appInfoMock, createFakeApolloClient } from '../testing/apollo-fake';

/**
 * Scaffold tests for the router wiring (task 16.1).
 *
 * They assert the two things the scaffold has to get right before any view is built: the generated
 * route tree really is the one mounted, and an unknown path does not render the landing page. The
 * views themselves are tested in task 16.6.
 *
 * The `ApolloProvider` is not decoration. Since task 16.5 the shell asks for `appInfo` to state the
 * activation state of the Relevance_Service (14.8), and `ApolloProvider` deliberately lives in
 * `src/main.tsx` rather than in `__root.tsx` — so every test that mounts the router brings its own
 * client. This is the pattern tasks 16.6 to 19.2 follow.
 */
function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));

  render(
    <ApolloProvider client={createFakeApolloClient([appInfoMock()])}>
      <RouterProvider router={router} />
    </ApolloProvider>,
  );

  return router;
}

describe('application router', () => {
  it('renders the landing route at /', async () => {
    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Job-Tool' })).toBeVisible();
  });

  it('does not render the landing route for an unknown path', async () => {
    const router = renderAt('/gibt-es-nicht');

    await router.load();

    expect(screen.queryByRole('heading', { name: 'Job-Tool' })).toBeNull();
  });
});
