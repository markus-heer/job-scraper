/**
 * The `test` every E2E spec imports (task 21.1).
 *
 * ```ts
 * import { expect, test } from '../fixtures/test';
 *
 * test('shows the stored postings', async ({ seed, postings }) => {
 *   await seed('posting-overview');
 *   await postings.goto();
 *
 *   await expect(postings.rows).toHaveCount(25);
 * });
 * ```
 *
 * Playwright's own `test` extended with one fixture per page object and one for the seeding, so a
 * spec declares what it needs in its argument list and nothing is constructed it does not use. The
 * page objects are per-test, like `page` itself; `seed` is a function rather than a value because
 * the scenario is the spec's decision and several specs in a file may want different ones.
 *
 * ## Why the seeding is a fixture and not a `beforeEach`
 *
 * A `beforeEach` in a shared file would have to pick one scenario for every spec in it, and the
 * three spec files of tasks 21.2 to 21.4 need different Posting_Store states — sometimes within one
 * file. A fixture leaves the choice at the call site while keeping the mechanism in one place. Every
 * call truncates first, so a spec never inherits what the previous one wrote.
 *
 * ## Why the specs run one at a time
 *
 * `workers: 1` in `../../playwright.config.ts`, because there is one Posting_Store and one
 * API_Service: two specs seeding in parallel would truncate each other's rows, and a Scrape_Run is
 * a singleton by 12.1 and 12.5 — a second spec starting one while the first watches it would be
 * answered with "a Scrape_Run is already running", which is the behaviour 12.5 specifies rather than
 * a race the harness should hide. The run-control specs of task 21.2 depend on that serialisation.
 */

import { expect, test as base } from '@playwright/test';

import { CriteriaPage } from '../pages/criteria.page';
import { LandingPage } from '../pages/landing.page';
import { LogViewPage } from '../pages/log-view.page';
import { PostingDetailPage } from '../pages/posting-detail.page';
import { PostingsPage } from '../pages/postings.page';
import { type E2eScenario, type SeededScenario, seedPostingStore } from './posting-store';

/** What a spec may ask for in its argument list. */
export interface JobToolFixtures {
  /**
   * Truncates the Posting_Store and writes one known state into it.
   *
   * @returns The Scrape_Run identifiers and the posting count of the scenario, so a spec builds its
   *   URLs and its expected counts from what was written rather than from a second copy of them.
   */
  readonly seed: (scenario: E2eScenario) => Promise<SeededScenario>;
  readonly landing: LandingPage;
  readonly postings: PostingsPage;
  readonly postingDetail: PostingDetailPage;
  readonly logView: LogViewPage;
  readonly criteria: CriteriaPage;
}

/**
 * Playwright's `test`, extended with the Job_Tool page objects and the seeding helper.
 *
 * The second parameter of each fixture is Playwright's own "hand this to the test and tear it down
 * afterwards" callback, which its documentation calls `use`. It is named `provide` here because this
 * package lints with the React rules, and `react-hooks/rules-of-hooks` reads a call to `use` outside
 * a component as a misplaced React hook. The parameter is positional, so the rename changes nothing
 * but the reading.
 */
export const test = base.extend<JobToolFixtures>({
  // Playwright requires the first parameter of a fixture to be a destructuring pattern, because that
  // is how it works out which other fixtures the fixture depends on. This one depends on none — the
  // seeding talks to the Posting_Store and never to the browser — so the pattern is empty, which
  // `no-empty-pattern` objects to and which Playwright insists on.
  // eslint-disable-next-line no-empty-pattern
  seed: async ({}, provide) => {
    await provide(seedPostingStore);
  },
  landing: async ({ page }, provide) => {
    await provide(new LandingPage(page));
  },
  postings: async ({ page }, provide) => {
    await provide(new PostingsPage(page));
  },
  postingDetail: async ({ page }, provide) => {
    await provide(new PostingDetailPage(page));
  },
  logView: async ({ page }, provide) => {
    await provide(new LogViewPage(page));
  },
  criteria: async ({ page }, provide) => {
    await provide(new CriteriaPage(page));
  },
});

export { expect };
