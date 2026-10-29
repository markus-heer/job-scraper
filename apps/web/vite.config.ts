import { fileURLToPath } from 'node:url';

import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Vite configuration of the Web_App, and at the same time its Vitest configuration.
 *
 * One file rather than two, unlike `apps/api`: this package is ESM and plain React, so the test run
 * needs exactly the same transform pipeline as the dev server (the JSX transform of
 * `@vitejs/plugin-react`, and the generated route tree the router plugin writes). A second
 * configuration file would have to repeat both and could drift from them.
 *
 * The repository root — not this package — holds the single environment file of Requirement 1.12,
 * so `envDir` points there. `envPrefix` stays at its default `VITE_`, which is what keeps
 * `ANTHROPIC_API_KEY`, `ROUTING_API_KEY` and `DATABASE_URL` out of the browser bundle even though
 * `loadEnv` below reads the whole file: only `VITE_`-prefixed values are ever injected into
 * `import.meta.env`, and none exist today.
 */

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Where the file-based routes live, and where the generated route tree is written. */
const ROUTES_DIRECTORY = './src/routes';
const GENERATED_ROUTE_TREE = './src/routeTree.gen.ts';

export default defineConfig(({ mode }) => {
  // Prefix '' reads every key, including the unprefixed `WEB_PORT` and `API_PORT` of `.env.example`.
  // These two values are used by this configuration file in Node, never handed to the browser.
  const env = loadEnv(mode, repositoryRoot, '');
  const webPort = Number(env.WEB_PORT ?? '5173');
  const apiPort = Number(env.API_PORT ?? '4000');

  return {
    envDir: repositoryRoot,

    plugins: [
      // Must come before the React plugin: it generates `routeTree.gen.ts`, which the React
      // transform then processes like any other source file.
      tanstackRouter({
        target: 'react',
        routesDirectory: ROUTES_DIRECTORY,
        generatedRouteTree: GENERATED_ROUTE_TREE,

        // Colocated tests live in `src/routes/**/__tests__/`. Without this pattern the generator
        // would read `__tests__/landing.test.tsx` as the route `/__tests__/landing.test`.
        routeFileIgnorePattern: '__tests__|\\.test\\.',

        // Match the repository Prettier settings, so the generated file stays readable even though
        // it is excluded from formatting and from linting.
        quoteStyle: 'single',
        semicolons: true,
      }),
      react(),
    ],

    server: {
      // The Job_Tool runs on one developer machine without a deployment target (1.16), so the dev
      // server stays on the loopback interface like the API_Service does.
      host: '127.0.0.1',
      port: webPort,

      // No silent fallback to the next free port: the Start_Script reports the configured URL
      // (1.9) and must be able to detect an occupied port as such (1.11).
      strictPort: true,

      proxy: {
        // Queries, mutations and the Log_Stream subscription all travel over `/graphql`
        // (`GRAPHQL_PATH` in `apps/api/src/graphql/schema-options.ts`). Proxying it keeps the
        // browser on one origin, so the API_Service needs no CORS allowance and no second port is
        // exposed. `ws: true` carries the `graphql-ws` upgrade through the same path.
        '/graphql': {
          target: `http://127.0.0.1:${apiPort}`,
          ws: true,
        },
      },
    },

    preview: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
    },

    build: {
      /**
       * The single bundle is deliberate, and so is not warning about its size.
       *
       * Vite warns above 500 kB because that size costs a visitor on a mobile connection real
       * seconds. The Job_Tool has no visitor: it serves one user from `127.0.0.1` on the machine the
       * bundle was built on (1.16), so the transfer is a memory copy and the only cost that remains
       * is parsing, which is milliseconds. Code splitting would buy nothing measurable here and
       * would add a loading state to every route for it.
       *
       * The limit is raised rather than the warning silenced, so a bundle that grows by another
       * factor still says so. 1,024 kB is roughly twice the current 585 kB.
       */
      chunkSizeWarningLimit: 1_024,
    },

    test: {
      // Component tests of the design's Component layer run against a DOM.
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/testing/setup.ts'],

      // Only colocated component tests. The Playwright specs of `apps/web/e2e` are `.spec.ts` and
      // are run by `pnpm test:e2e`, never by this suite.
      include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    },
  };
});
