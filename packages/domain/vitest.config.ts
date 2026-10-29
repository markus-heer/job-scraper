import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The vocabulary, typing and content hash tests live in __tests__ at the package root, next to
    // the source tree they cover. Later tasks add tests under src/**/__tests__ as well, which the
    // default include pattern already picks up.
    include: ['__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
