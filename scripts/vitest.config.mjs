import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The decision logic of the Start_Script lives in `lib/` and its tests next to it, the same layout
    // the workspace packages use. The entry points themselves (`start.mjs`, `fixtures-capture.mjs`)
    // hold no logic to test: they wire the real runner and the real filesystem into these modules.
    include: ['lib/__tests__/**/*.test.mjs'],
  },
});
