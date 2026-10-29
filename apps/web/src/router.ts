import { createRouter, type RouterHistory } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen';

/**
 * Builds the application router.
 *
 * A factory rather than a module-level singleton, so that a component test can create its own
 * instance per test instead of sharing navigation state across test files. The optional `history`
 * is how a test starts on a route other than `/`: it passes a memory history, while the browser
 * entry point passes nothing and gets the default browser history.
 *
 * The route tree comes from `routeTree.gen.ts`, which the TanStack Router Vite plugin writes from
 * the files under `src/routes`. That file is generated and must never be hand-edited; it is
 * excluded from Prettier and from ESLint.
 */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history });
}

/** The router type, used by the type registry below and available to tests. */
export type AppRouter = ReturnType<typeof createAppRouter>;

/**
 * Registers the route tree with the library's type registry, which is what makes `Link`, `useParams`
 * and `navigate` typed against the real routes: an unknown path is a compile error.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
