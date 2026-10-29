/**
 * How the E2E suite learns which Posting_Store it is testing against (task 21.1).
 *
 * The throwaway PostgreSQL container is started by `./start-api.mjs`, the process that boots the
 * API_Service, and its connection string is written to {@link HANDOFF_PATH}. The spec workers are
 * separate processes, so a file is the only way the connection string reaches them — and they need
 * it, because the seeding helper connects to the same database the API_Service reads.
 *
 * ## Why the container belongs to the API starter and not to `globalSetup`
 *
 * It is the natural place in any case — the Posting_Store exists for exactly as long as the
 * API_Service that uses it — but it is also the only place that works. Playwright starts the
 * processes of `webServer` *before* it runs `globalSetup`, and the ordering of the two is not
 * guaranteed in the other direction, so a container started in `globalSetup` would not exist yet
 * when the API_Service tried to connect to it. See
 * [playwright#19571](https://github.com/microsoft/playwright/issues/19571).
 *
 * That is also why this suite has no `globalSetup` at all: there is nothing left for one to do.
 *
 * ## Why the path is declared here
 *
 * Here, in TypeScript, and from here it reaches both sides: `../../playwright.config.ts` passes it to
 * the API starter as a command-line argument, and the seeding helper reads it below. One declaration
 * rather than one per side, so the writer and the reader of the file cannot disagree about where it
 * is — a disagreement that would surface as "the API_Service has no Posting_Store" on a run where
 * everything else was correct.
 *
 * The file holds no credential worth protecting: the container lives for one test run, and it is
 * written inside the Playwright output directory, which `.gitignore` excludes.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { repositoryRoot } from './ports';

/** Where the connection string is handed from the API starter to the spec workers. */
export const HANDOFF_PATH = join(repositoryRoot, 'apps', 'web', 'test-results', 'e2e-harness.json');

/**
 * The compiled seeding command of `apps/api/src/testing/e2e-seed.ts`.
 *
 * Build output, which is why the `test:e2e` task of `turbo.json` depends on the build of every
 * package: a stale or missing `dist` is a confusing failure in the middle of a spec otherwise.
 */
export const SEED_COMMAND_PATH = join(
  repositoryRoot,
  'apps',
  'api',
  'dist',
  'testing',
  'e2e-seed.js',
);

/** What the hand-off file carries. */
export interface E2eHarnessHandoff {
  /** Connection string of the throwaway Posting_Store, with `schema=public`. */
  readonly databaseUrl: string;
}

/**
 * The connection string of the Posting_Store the API_Service under test is using.
 *
 * @throws An `Error` naming the cause when the file cannot be read, which means the API_Service was
 *   not started by this harness — a `playwright test` run with a different configuration file, or a
 *   reused server from an earlier session.
 */
export const harnessDatabaseUrl = async (): Promise<string> => {
  try {
    const handoff = JSON.parse(await readFile(HANDOFF_PATH, 'utf8')) as E2eHarnessHandoff;

    if (typeof handoff.databaseUrl !== 'string' || handoff.databaseUrl === '') {
      throw new Error('The hand-off file carries no usable databaseUrl.');
    }

    return handoff.databaseUrl;
  } catch (cause) {
    throw new Error(
      `The E2E harness hand-off file ${HANDOFF_PATH} could not be read, so there is no ` +
        'Posting_Store to seed. It is written by apps/web/e2e/harness/start-api.mjs when the suite ' +
        'starts the API_Service; run the suite through `pnpm test:e2e`.',
      { cause },
    );
  }
};
