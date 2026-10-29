/**
 * Reading a frozen fixture from disk.
 *
 * This is the half of the fixture tooling the parser tests of 9.3 and 10.3 use: give it a Platform and
 * a case name and it hands back the captured document plus, when the sidecar exists, the capture
 * provenance. No network, no browser, no Playwright — which is the whole reason the fixtures exist.
 *
 * The sidecar is optional on purpose. A capture writes one ({@link runFixtureCapture}), but a fixture
 * can also be hand-authored: the eight cases of {@link REQUIRED_FIXTURE_CASES} include situations a
 * Platform does not hand out on demand — a Captcha, a reported rate limit, a changed page layout —
 * and waiting for one to occur in the wild would be the wrong way to get a regression test.
 */

import { readdir, readFile } from 'node:fs/promises';

import type { Platform } from '@job-scraper/domain';

import { type FixtureCaptureMetadata, parseFixtureMetadata } from './fixture-metadata.js';
import {
  fixtureCaseFromFileName,
  fixtureHtmlPath,
  fixtureMetadataPath,
  isFixtureCaseName,
  platformFixtureDir,
} from './fixture-paths.js';

/** A fixture as read from disk. */
export interface LoadedFixture {
  readonly platform: Platform;
  readonly fixtureCase: string;
  /** The captured document, byte for byte as it is stored. */
  readonly html: string;
  /** The capture provenance, or `undefined` for a hand-authored fixture without a sidecar. */
  readonly metadata: FixtureCaptureMetadata | undefined;
  readonly htmlPath: string;
}

/** Which fixture to read. */
export interface ReadFixtureOptions {
  readonly platform: Platform;
  readonly fixtureCase: string;
  /** The folder to read from. Defaults to the fixture folder of that Platform. */
  readonly fixtureDir?: string;
  /** The package root the default folder is resolved against; a test passes a temporary directory. */
  readonly packageRoot?: string;
}

/** A fixture case name that cannot address a file. */
export class InvalidFixtureCaseError extends Error {
  constructor(fixtureCase: string) {
    super(
      `The fixture case ${JSON.stringify(fixtureCase)} is not a lowercase kebab-case name, so it addresses no fixture file.`,
    );
    this.name = 'InvalidFixtureCaseError';
  }
}

/**
 * Reads one fixture.
 *
 * @throws An {@link InvalidFixtureCaseError} for a case name that is not kebab-case, and the
 *   underlying filesystem error when the captured document does not exist — a missing fixture is a
 *   missing test input, not a case to degrade over.
 */
export async function readFixture(options: ReadFixtureOptions): Promise<LoadedFixture> {
  if (!isFixtureCaseName(options.fixtureCase)) {
    throw new InvalidFixtureCaseError(options.fixtureCase);
  }

  const fixtureDir =
    options.fixtureDir ?? platformFixtureDir(options.platform, options.packageRoot);
  const htmlPath = fixtureHtmlPath(fixtureDir, options.fixtureCase);
  const html = await readFile(htmlPath, 'utf8');
  const metadata = await readOptionalMetadata(fixtureMetadataPath(fixtureDir, options.fixtureCase));

  return {
    platform: options.platform,
    fixtureCase: options.fixtureCase,
    html,
    metadata,
    htmlPath,
  };
}

/** The captured document of one fixture, for a test that needs nothing but the markup. */
export async function readFixtureHtml(options: ReadFixtureOptions): Promise<string> {
  return (await readFixture(options)).html;
}

/**
 * The fixture cases a folder contains, sorted.
 *
 * @returns An empty list when the folder does not exist, so a Platform without fixtures yet reads as
 *   "no cases" rather than as a failure — which is what {@link missingFixtureCases} is then asked.
 */
export async function listFixtureCases(fixtureDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(fixtureDir);

    return entries
      .map((entry) => fixtureCaseFromFileName(entry))
      .filter((fixtureCase): fixtureCase is string => fixtureCase !== undefined)
      .sort();
  } catch {
    return [];
  }
}

/** The sidecar of a fixture, or `undefined` when none is stored. */
async function readOptionalMetadata(
  metadataPath: string,
): Promise<FixtureCaptureMetadata | undefined> {
  try {
    return parseFixtureMetadata(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    // A malformed sidecar is a fault worth reporting; an absent one is the hand-authored case.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}
