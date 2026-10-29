/**
 * The fixture tooling of task 9.2: capture once, serve and read forever.
 *
 * Three pieces, deliberately separable:
 *
 * - `capture.ts` writes a fixture. It performs a real Platform request and therefore never runs in a
 *   test or in CI; it is reached only through `pnpm fixtures:capture`;
 * - `fixture-server.ts` and `fixture-page.ts` serve a fixture to a Platform_Adapter through the same
 *   {@link AdapterPage} port the Playwright runtime implements, with no browser and no network;
 * - `fixture-files.ts`, `fixture-paths.ts`, `fixture-metadata.ts` and `fixture-expectations.ts`
 *   locate, read and describe the stored files, including the expected reading a parser test asserts
 *   against.
 *
 * Importing this module loads no browser and sends nothing: Playwright is reached through the
 * dynamic import of `../runtime/playwright-port.ts` and only when a capture actually launches.
 */

export * from './capture.js';
export * from './fixture-expectations.js';
export * from './fixture-files.js';
export * from './fixture-metadata.js';
export * from './fixture-page.js';
export * from './fixture-paths.js';
export * from './fixture-server.js';
export * from './sanitize-html.js';
