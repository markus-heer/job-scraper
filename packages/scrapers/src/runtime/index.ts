/**
 * The Playwright runtime of a Scrape_Run (task 8.4).
 *
 * `browser.ts` owns the three lifetimes (browser, context per Platform, page per Result_Page),
 * `playwright-port.ts` the narrow Playwright surface the runtime is allowed to use, and
 * `user-agent.ts` the single user agent string of 14.5.
 */

export * from './browser.js';
export * from './playwright-port.js';
export * from './user-agent.js';
