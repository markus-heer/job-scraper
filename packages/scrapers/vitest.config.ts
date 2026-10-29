import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit and property tests live next to the source tree they cover, under src/**/__tests__.
    // The __tests__ folder at the package root is kept in the pattern for cross-cutting tests
    // that span several modules.
    include: ['__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
