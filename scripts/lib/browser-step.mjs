/**
 * Step 3: check the Playwright browser files and install the missing ones (1.1, 1.2, 1.7).
 *
 * ## Which browser, and why only one
 *
 * Chromium, and nothing else. `packages/scrapers/src/runtime/playwright-port.ts` resolves exactly one
 * launcher — `chromium` — and the design pins it ("Playwright (Chromium)", "Scraping ... Required by
 * 6.2"). Firefox and WebKit are never launched by the Job_Tool, so downloading them would cost the user
 * several hundred megabytes on a machine that will never open them. When the Web_App E2E suite arrives
 * (task 21.1) it runs on the same Chromium.
 *
 * ## What "the browser files" means
 *
 * Asking for `chromium` makes Playwright place three directories, not one: the browser itself, the
 * headless shell that `chromium.launch({ headless: true })` actually starts, and the FFmpeg helper. The
 * check therefore does not guess the paths — it asks Playwright for its own install plan
 * (`playwright install --dry-run chromium`) and verifies every location that plan names. That keeps the
 * check correct across Playwright versions, which change the revision numbers in those paths with every
 * release.
 *
 * Presence is decided by Playwright's own completion marker inside the directory, not by the directory
 * existing: an interrupted download leaves the directory behind, and a start that accepted it would hand
 * the user a broken browser in step 7 instead of a German sentence in step 3.
 *
 * ## Installing only what is missing
 *
 * The install command runs only when at least one location is missing, and it is the same install
 * Playwright offers: one target, `chromium`. There is no finer granularity for the FFmpeg helper, and
 * Playwright skips every file it already finds, so a missing headless shell downloads the headless shell
 * and not the whole set. After the install the same check runs again over the previously missing
 * locations, because an installer that reports success while a file stays missing must not count as
 * "confirmed ready" under 1.1.
 *
 * A failure of either the check or the install is fatal (1.7): without a browser no Scrape_Run can ever
 * retrieve a Job_Posting, which is the entire purpose of the Job_Tool.
 *
 * Requirements: 1.1, 1.2, 1.7.
 */

import { join } from 'node:path';

import { extractFailureDetail } from './command-runner.mjs';
import { EXIT_CODES, StartStepError } from './errors.mjs';
import { BROWSER_BINARY_OUTCOMES } from './outcomes.mjs';
import {
  browserCheckFailedError,
  browserInstallFailedError,
  browserStillMissingError,
} from './start.messages.mjs';
import { START_STEPS } from './steps.mjs';

/** The only browser the Job_Tool launches (6.2, design: "Playwright (Chromium)"). */
export const REQUIRED_BROWSER = 'chromium';

/** The workspace package that owns the Playwright dependency, so its binary is the one invoked. */
export const PLAYWRIGHT_OWNER_PACKAGE = '@job-scraper/scrapers';

/**
 * The file Playwright writes into a browser directory once the download is complete. Its absence means
 * the directory is a leftover, not an installation.
 */
export const INSTALLATION_MARKER_FILE = 'INSTALLATION_COMPLETE';

/** Asks Playwright which files `chromium` consists of and where they belong. Downloads nothing. */
export const PLAYWRIGHT_PLAN_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze([
    '--filter',
    PLAYWRIGHT_OWNER_PACKAGE,
    'exec',
    'playwright',
    'install',
    '--dry-run',
    REQUIRED_BROWSER,
  ]),
});

/** Installs what is missing; Playwright keeps every file it already finds. */
export const PLAYWRIGHT_INSTALL_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze([
    '--filter',
    PLAYWRIGHT_OWNER_PACKAGE,
    'exec',
    'playwright',
    'install',
    REQUIRED_BROWSER,
  ]),
});

/** Matches the install location of a plan entry. */
const INSTALL_LOCATION_PATTERN = /^\s+Install location:\s*(.+?)\s*$/;

/**
 * One file set of the install plan.
 *
 * @typedef {object} PlannedBinary
 * @property {string} title The heading Playwright printed, for example
 *   `Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248)`. Used verbatim in
 *   the German error of 1.7, because it names the browser *and* the version.
 * @property {string} location Absolute directory the file set belongs in.
 */

/**
 * Parses `playwright install --dry-run chromium` into its planned file sets.
 *
 * The output is a flat list of blocks: an unindented heading, then indented `Install location:` and
 * `Download url:` lines. Only the heading and the location are read; a block without a location is
 * skipped, and a location before any heading is attributed to {@link REQUIRED_BROWSER} so that a
 * changed output format degrades into a vaguer message rather than into a crash.
 *
 * @param {string} stdout
 * @returns {readonly PlannedBinary[]}
 */
export function parseInstallPlan(stdout) {
  /** @type {PlannedBinary[]} */
  const planned = [];
  let title = REQUIRED_BROWSER;

  for (const rawLine of stdout.split('\n')) {
    if (rawLine.trim() === '') {
      continue;
    }

    if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t')) {
      title = rawLine.trim();

      continue;
    }

    const location = INSTALL_LOCATION_PATTERN.exec(rawLine);

    if (location !== null) {
      planned.push({ title, location: location[1] });
    }
  }

  return planned;
}

/**
 * The planned file sets that are not installed.
 *
 * @param {readonly PlannedBinary[]} planned
 * @param {{ exists: (path: string) => boolean }} dependencies Injection point of the tests; in
 *   production this is `existsSync`.
 * @returns {readonly PlannedBinary[]}
 */
export function selectMissingBinaries(planned, { exists }) {
  return planned.filter((binary) => !exists(join(binary.location, INSTALLATION_MARKER_FILE)));
}

/**
 * Runs step 3: one progress line, one plan read, and an install only if something is missing.
 *
 * @param {object} dependencies
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @param {(path: string) => boolean} dependencies.exists
 * @returns {Promise<{ outcome: string, installed: readonly PlannedBinary[] }>}
 * @throws {StartStepError} When the check or the install fails (1.7).
 */
export async function runBrowserBinaryStep({ run, reporter, exists }) {
  reporter.progress(START_STEPS.BROWSER_BINARIES);

  const plan = await run(PLAYWRIGHT_PLAN_COMMAND);

  if (!plan.ok) {
    throw new StartStepError({
      message:
        'The Playwright install plan could not be read, so the browser state is unknown (1.7).',
      messageDe: browserCheckFailedError({
        detail: extractFailureDetail(plan),
        exitCode: plan.code,
      }),
      code: 'BROWSER_BINARY_CHECK_FAILED',
      exitCode: EXIT_CODES.BROWSER_BINARY_CHECK_FAILED,
    });
  }

  const planned = parseInstallPlan(plan.stdout);

  if (planned.length === 0) {
    throw new StartStepError({
      message:
        'The Playwright install plan named no browser file, so the check confirms nothing (1.7).',
      messageDe: browserCheckFailedError({ detail: null, exitCode: plan.code }),
      code: 'BROWSER_BINARY_CHECK_FAILED',
      exitCode: EXIT_CODES.BROWSER_BINARY_CHECK_FAILED,
    });
  }

  const missing = selectMissingBinaries(planned, { exists });

  if (missing.length === 0) {
    return { outcome: BROWSER_BINARY_OUTCOMES.ALREADY_COMPLETE, installed: [] };
  }

  const install = await run(PLAYWRIGHT_INSTALL_COMMAND);
  const missingTitles = missing.map((binary) => binary.title);

  if (!install.ok) {
    throw new StartStepError({
      message: `Installing the Playwright browser files failed: ${missingTitles.join(', ')} (1.7).`,
      messageDe: browserInstallFailedError({
        titles: missingTitles,
        detail: extractFailureDetail(install),
        exitCode: install.code,
      }),
      code: 'BROWSER_BINARY_INSTALL_FAILED',
      exitCode: EXIT_CODES.BROWSER_BINARY_INSTALL_FAILED,
    });
  }

  const stillMissing = selectMissingBinaries(missing, { exists });

  if (stillMissing.length > 0) {
    const stillMissingTitles = stillMissing.map((binary) => binary.title);

    throw new StartStepError({
      message: `The Playwright install reported success but left files missing: ${stillMissingTitles.join(', ')} (1.7).`,
      messageDe: browserStillMissingError(stillMissingTitles),
      code: 'BROWSER_BINARY_INSTALL_FAILED',
      exitCode: EXIT_CODES.BROWSER_BINARY_INSTALL_FAILED,
    });
  }

  return { outcome: BROWSER_BINARY_OUTCOMES.INSTALLED, installed: missing };
}
