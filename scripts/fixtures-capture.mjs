#!/usr/bin/env node
/**
 * Entry point of `pnpm fixtures:capture` (task 9.2).
 *
 * Deliberately manual: one invocation performs exactly one real Result_Page retrieval against a job
 * platform, with the production user agent (Requirement 14.5) and after evaluating that platform's
 * robots.txt (Requirement 14.1). It therefore never runs in a test and never in CI — the capture
 * function refuses to start when it finds a test runner or a CI variable in the environment.
 *
 * All of the logic lives in `@job-scraper/scrapers` (`src/fixtures/capture.ts`), where it is unit
 * tested without a browser and without a network. This file only wires the process to it: arguments
 * in, exit code out.
 *
 * Usage:
 *   pnpm fixtures:capture --platform stepstone
 *   pnpm fixtures:capture --platform stepstone --case result-list-page-2 --page 2
 *   pnpm fixtures:capture --platform jobvector --url 'https://...' --case sign-in-wall --force
 *
 * Requires USER_AGENT_CONTACT in the environment or in .env, and a built package plus the Playwright
 * Chromium binary.
 */

const packageEntry = new URL('../packages/scrapers/dist/index.js', import.meta.url);

let fixtures;

try {
  fixtures = await import(packageEntry.href);
} catch (error) {
  console.error(
    'Could not load @job-scraper/scrapers from packages/scrapers/dist. Run "pnpm build" first.',
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const controller = new AbortController();

process.once('SIGINT', () => {
  console.error('Cancelled; closing the browser.');
  controller.abort(new Error('The fixture capture was cancelled.'));
});

try {
  const outcome = await fixtures.runFixtureCapture({
    argv: process.argv.slice(2),
    env: process.env,
    signal: controller.signal,
  });

  console.log(`Captured at ${outcome.metadata.capturedAt}`);
  console.log(outcome.htmlPath);
  console.log(outcome.metadataPath);
  console.log(
    'Review the captured file in the diff before committing it: it is stored unformatted and must stay byte-identical to what the platform served.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));

  if (error instanceof Error && error.name === 'FixtureCaptureUsageError') {
    console.error(`\n${fixtures.FIXTURE_CAPTURE_USAGE}`);
  }

  process.exit(1);
}
