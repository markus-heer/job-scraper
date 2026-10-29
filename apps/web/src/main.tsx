import { ApolloProvider } from '@apollo/client/react';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createApolloClient } from './apollo/client';
import { createAppRouter } from './router';

/**
 * Browser entry point. It mounts the router and the GraphQL client and nothing else: the shell, the
 * skip link and the global error boundary belong to `src/routes/__root.tsx`, so that a component
 * test can render the same tree without this file.
 *
 * `ApolloProvider` sits here and not in `__root.tsx` because it carries no markup and because a
 * component test has to supply its own client anyway — a provider baked into the root route would
 * force every test to go through the real transports.
 *
 * The message below is a developer-facing crash, not user-facing output, and therefore stays
 * English like the rest of the source code.
 */
const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('index.html is missing the #root mount point.');
}

createRoot(rootElement).render(
  <StrictMode>
    <ApolloProvider client={createApolloClient()}>
      <RouterProvider router={createAppRouter()} />
    </ApolloProvider>
  </StrictMode>,
);
