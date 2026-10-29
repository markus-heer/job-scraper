import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Vitest setup for every component test of the Web_App.
 *
 * Two things, both of which every test needs and none of which should be repeated per file:
 * - the `jest-dom` matchers (`toBeVisible`, `toHaveAccessibleName`, …), which is what lets the
 *   accessibility assertions of Requirement 2.3 read as assertions rather than as DOM archaeology;
 * - unmounting the rendered tree after each test. Testing Library registers this itself only when
 *   Vitest runs with `globals: true`, and this package keeps globals off, so it is wired explicitly.
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom has no layout, so it leaves `window.scrollTo` unimplemented and logs a warning whenever the
 * router restores a scroll position after a navigation. The stub removes that noise from the test
 * output; nothing in the Web_App depends on the scroll position.
 */
window.scrollTo = () => undefined;
