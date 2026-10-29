import { configDefaults, defineConfig } from 'vitest/config';

import { graphqlCommonJsAlias, INTEGRATION_TEST_GLOB } from './vitest.shared.mts';

// `.mts` rather than `.ts`: the API_Service package is CommonJS, because that is what Nest's
// dependency injection and the GraphQL code-first decorators need. The extension tells Vite to load
// this one file as ESM anyway.

/**
 * The unit, property and parser suite: everything that runs without a network and without Docker.
 *
 * `*.integration.test.ts` is excluded here and run by `pnpm test:integration` instead
 * (`vitest.integration.config.mts`). Those files start a PostgreSQL container, which would make
 * this suite — the one the quality gate runs on every change — depend on a running Docker daemon
 * and pay a container start per file. Keeping them apart also keeps the failure modes apart: a red
 * run of this configuration is a statement about the code, never about the environment.
 */
export default defineConfig({
  resolve: {
    alias: graphqlCommonJsAlias,
  },
  test: {
    exclude: [...configDefaults.exclude, INTEGRATION_TEST_GLOB],
    // The API_Service is built up over several tasks; the service tests arrive with the later ones,
    // so an empty run must not fail the quality gate.
    passWithNoTests: true,
  },
});
