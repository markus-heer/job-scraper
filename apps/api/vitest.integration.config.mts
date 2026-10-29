import { defineConfig } from 'vitest/config';

import { graphqlCommonJsAlias, INTEGRATION_TEST_GLOB } from './vitest.shared.mts';

// `.mts` rather than `.ts`: see the note in `vitest.config.mts`.

/**
 * The PostgreSQL suite, run by `pnpm test:integration`.
 *
 * Every file here starts its own throwaway `postgres:16-alpine` container through
 * `src/testing/postgres-harness.ts` and applies `prisma migrate deploy` to it. A missing Docker
 * daemon fails these tests with an explicit message; there is no fallback engine, because the
 * subject under test is PostgreSQL behaviour (9.6).
 *
 * Two deliberate settings:
 *
 * - `fileParallelism: false` — the files would otherwise start their containers at the same time,
 *   so a run would need as many PostgreSQL instances as there are files. Sequential files keep it
 *   at one, which matters on a developer machine and is the reason the per-file container is
 *   affordable at all.
 * - the long `testTimeout` and `hookTimeout` — a container start, an image pull on the first run
 *   and a `prisma migrate deploy` happen inside hooks, and the property tests of tasks 11.4 – 11.6
 *   run their iterations against real SQL.
 */
export default defineConfig({
  resolve: {
    alias: graphqlCommonJsAlias,
  },
  test: {
    include: [INTEGRATION_TEST_GLOB],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // The integration files arrive with tasks 11.4 – 11.7 and 15.10; an empty run must not fail.
    passWithNoTests: true,
  },
});
