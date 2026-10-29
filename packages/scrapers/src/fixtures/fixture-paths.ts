/**
 * Where a captured Platform fixture lives, and what a fixture case may be called.
 *
 * The layout is the one the design fixes: `src/adapters/<platform>/__fixtures__/<case>.html` next to
 * the Platform_Adapter that parses it, plus a `<case>.capture.json` sidecar holding the `captured-at`
 * date and the provenance of that file. Two consumers read these paths — the capture script, which
 * writes a fixture, and the adapter parser tests, which serve one — so the layout is declared once
 * here rather than spelled out in both.
 *
 * Why the captured HTML gets a sidecar rather than an injected comment: the repository-wide
 * `.prettierignore` keeps every `__fixtures__` folder unformatted so a fixture stays byte-identical
 * to what the Platform served, and a header comment written into the document would break that. The
 * metadata therefore sits beside the HTML, where a reviewer sees the capture date in the diff without
 * the page itself being edited.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Platform, PLATFORMS } from '@job-scraper/domain';

/** The directory name the design fixes for captured Platform fixtures. */
export const FIXTURE_DIR_NAME = '__fixtures__';

/** Extension of the captured document. */
export const FIXTURE_HTML_SUFFIX = '.html';

/** Extension of the sidecar carrying the `captured-at` date and the capture provenance. */
export const FIXTURE_METADATA_SUFFIX = '.capture.json';

/** Extension of the file holding the expected reading of a fixture (design, Testing Strategy). */
export const FIXTURE_EXPECTED_SUFFIX = '.expected.json';

/**
 * The fixture cases every Platform_Adapter is expected to have (design, Testing Strategy).
 *
 * A capture may write any validly named case, so this list is a checklist rather than a constraint:
 * it tells a developer which situations the parser tests of a Platform have to cover, and it is what
 * {@link missingFixtureCases} compares an existing fixture folder against.
 */
export const REQUIRED_FIXTURE_CASES = [
  'result-list-page-1',
  'result-list-page-2',
  'result-list-empty',
  'layout-changed',
  'sign-in-wall',
  'captcha',
  'rate-limited',
  'relative-dates',
] as const;

/** One of the fixture cases of {@link REQUIRED_FIXTURE_CASES}. */
export type RequiredFixtureCase = (typeof REQUIRED_FIXTURE_CASES)[number];

/**
 * The shape a fixture case name has to have: lowercase kebab-case.
 *
 * Besides being the naming convention, this is the containment check on a value that arrives from the
 * command line and ends up in a file path: no dot, no slash and no separator can pass, so
 * `--case ../../../etc/passwd` is rejected at the argument instead of resolved against the fixture
 * folder.
 */
export const FIXTURE_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a string may be used as a fixture case name. */
export function isFixtureCaseName(value: string): boolean {
  return FIXTURE_CASE_PATTERN.test(value);
}

/**
 * The Platform a `--platform` argument names.
 *
 * @param value The argument, in any capitalisation: `stepstone`, `Stepstone` and `STEPSTONE` all
 *   resolve, because the CLI spelling of the design is lowercase while the domain value is not.
 * @returns The Platform, or `undefined` when the value names none.
 */
export function parsePlatformName(value: string): Platform | undefined {
  const normalized = value.trim().toUpperCase();

  return PLATFORMS.find((platform) => platform === normalized);
}

/** The directory segment a Platform uses in the source tree: its lowercased domain value. */
export function platformDirName(platform: Platform): string {
  return platform.toLowerCase();
}

/**
 * The root of this package, derived from the location of this module.
 *
 * Both layouts this file is loaded from — `src/fixtures/` when Vitest runs the sources and
 * `dist/fixtures/` when the capture script runs the built package — sit exactly two levels below the
 * package root, so one expression covers both.
 */
export function scrapersPackageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/**
 * The fixture folder of one Platform.
 *
 * @param platform The Platform whose fixtures are addressed.
 * @param packageRoot The package root to resolve against. Defaults to this package; a test passes a
 *   temporary directory so it never writes into the source tree.
 */
export function platformFixtureDir(
  platform: Platform,
  packageRoot: string = scrapersPackageRoot(),
): string {
  return path.join(packageRoot, 'src', 'adapters', platformDirName(platform), FIXTURE_DIR_NAME);
}

/** The captured document of one fixture case. */
export function fixtureHtmlPath(fixtureDir: string, fixtureCase: string): string {
  return path.join(fixtureDir, `${fixtureCase}${FIXTURE_HTML_SUFFIX}`);
}

/** The metadata sidecar of one fixture case. */
export function fixtureMetadataPath(fixtureDir: string, fixtureCase: string): string {
  return path.join(fixtureDir, `${fixtureCase}${FIXTURE_METADATA_SUFFIX}`);
}

/** The expected reading of one fixture case; see `./fixture-expectations.ts`. */
export function fixtureExpectedPath(fixtureDir: string, fixtureCase: string): string {
  return path.join(fixtureDir, `${fixtureCase}${FIXTURE_EXPECTED_SUFFIX}`);
}

/** The case name a captured document's file name carries, or `undefined` for any other file. */
export function fixtureCaseFromFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(FIXTURE_HTML_SUFFIX)) {
    return undefined;
  }

  const fixtureCase = fileName.slice(0, -FIXTURE_HTML_SUFFIX.length);

  return isFixtureCaseName(fixtureCase) ? fixtureCase : undefined;
}

/**
 * The cases of {@link REQUIRED_FIXTURE_CASES} a fixture folder does not contain yet.
 *
 * @param presentCases The case names found in the folder, for example from `readdir`.
 */
export function missingFixtureCases(presentCases: readonly string[]): readonly string[] {
  const present = new Set(presentCases);

  return REQUIRED_FIXTURE_CASES.filter((fixtureCase) => !present.has(fixtureCase));
}
