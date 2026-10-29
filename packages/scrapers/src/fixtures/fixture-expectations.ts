/**
 * The expected reading of a frozen fixture: `<case>.expected.json` next to `<case>.html` (design,
 * Testing Strategy).
 *
 * The design fixes both halves of a Platform_Adapter parser test — the captured document and a file
 * holding "the expected `RawJobPosting[]` and the expected Platform_Status". This module is the second
 * half. Keeping the expectation in a data file rather than in the test source has one purpose: when a
 * Platform changes its markup, the fixture and its expectation are re-captured together and the diff
 * of this file *is* the review of what changed. An expectation inlined in a test would make that diff
 * a code change and hide it among assertions.
 *
 * The file carries slightly more than its name promises, because a reading depends on how the page was
 * served: the response status and headers belong to the fixture as much as the markup does (a rate
 * limit of 13.5 is a `429` plus a `retry-after`, not a sentence in the body), so they are declared
 * here and the fixture server is configured from them.
 *
 * Two fields are deliberately untyped against a Platform:
 *
 * - `outcome` is a plain string. Each Platform_Adapter parser has its own outcome vocabulary — the
 *   Stepstone one is `ResultPageOutcome` — and this module is shared by all of them, so it validates
 *   the shape and lets the Platform's own test compare the value.
 * - `platformStatus` is checked against the closed Platform_Status vocabulary of the domain package,
 *   because that one *is* shared: it is what a Scrape_Run reports per Platform (7.4).
 */

import { readFile } from 'node:fs/promises';

import { PLATFORM_STATUSES, type PlatformStatus } from '@job-scraper/domain';

import type { RawJobPosting } from '../adapter/types.js';
import { InvalidFixtureCaseError, type ReadFixtureOptions } from './fixture-files.js';
import { fixtureExpectedPath, isFixtureCaseName, platformFixtureDir } from './fixture-paths.js';

/** Where a fixture's HTML came from, since a hand-authored fixture carries no capture sidecar. */
export type FixtureProvenance =
  /** Written by `pnpm fixtures:capture`, so a `<case>.capture.json` sidecar exists. */
  | 'CAPTURED'
  /**
   * Written by hand. The required cases include situations no Platform serves on demand — a Captcha, a
   * reported fetch rate limit, a changed page layout — and a fixture for them is authored from the
   * Platform's documented behaviour rather than waited for in the wild.
   */
  | 'HAND_AUTHORED';

/** How the Platform served the fixture, which is half of what the reading depends on. */
export interface FixtureResponseExpectation {
  /** HTTP status of the main document, or `null` where the navigation reported none. */
  readonly status: number | null;
  /** Response headers under lowercased names, as {@link AdapterPageResponse} carries them. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The expected reading of one fixture. */
export interface FixtureExpectation {
  /** The fixture case, matching the file name of the HTML it describes. */
  readonly case: string;
  readonly provenance: FixtureProvenance;
  /** Why this fixture looks the way it does, for the reviewer of the next re-capture. */
  readonly description: string;
  /** The Result_Page number the document is the page for (13.3). */
  readonly pageNumber: number;
  readonly response: FixtureResponseExpectation;
  /** The parser's own classification of the page, in that Platform's outcome vocabulary. */
  readonly outcome: string;
  /**
   * The Platform_Status a retrieval reports when this Result_Page is the only page it reads — which is
   * what the adapter test asserts by running with a page budget of 1.
   */
  readonly platformStatus: PlatformStatus;
  /** Whether the page offers a further Result_Page. */
  readonly hasNextPage: boolean;
  /** How many of {@link postings} carry title, source URL and Posting_Id (6.5, 6.7). */
  readonly readablePostingCount: number;
  /** Every raw posting the page yields, in page order, with the source URLs already cleaned. */
  readonly postings: readonly RawJobPosting[];
}

/** An expectation file that cannot be read as a {@link FixtureExpectation}. */
export class InvalidFixtureExpectationError extends Error {
  constructor(reason: string) {
    super(`The fixture expectation is unusable: ${reason}.`);
    this.name = 'InvalidFixtureExpectationError';
  }
}

/** The seven fields of a {@link RawJobPosting}, which an expectation has to state in full. */
const RAW_POSTING_FIELDS = [
  'postingId',
  'title',
  'employer',
  'workLocation',
  'publishedAtText',
  'sourceUrl',
  'descriptionText',
] as const;

/** Serialises an expectation as the file content: pretty-printed JSON with a trailing newline. */
export function formatFixtureExpectation(expectation: FixtureExpectation): string {
  return `${JSON.stringify(expectation, null, 2)}\n`;
}

/**
 * Reads an expectation file.
 *
 * @throws An {@link InvalidFixtureExpectationError} for content that is not JSON, states no known
 *   Platform_Status, or declares a posting without all seven raw fields. Strict on purpose: an
 *   expectation with a silently missing field would turn into a test that asserts less than it reads.
 */
export function parseFixtureExpectation(text: string): FixtureExpectation {
  const record = asRecord(parseJson(text));

  return {
    case: fixtureCaseOf(record.case),
    provenance: provenanceOf(record.provenance),
    description: stringOf(record.description, 'description'),
    pageNumber: positiveIntegerOf(record.pageNumber, 'pageNumber'),
    response: responseOf(record.response),
    outcome: stringOf(record.outcome, 'outcome'),
    platformStatus: platformStatusOf(record.platformStatus),
    hasNextPage: booleanOf(record.hasNextPage, 'hasNextPage'),
    readablePostingCount: countOf(record.readablePostingCount),
    postings: postingsOf(record.postings),
  };
}

/**
 * The expectation belonging to one fixture case, addressed exactly like its HTML.
 *
 * @throws An `InvalidFixtureCaseError` for a case name that addresses no file, the underlying
 *   filesystem error when no expectation is stored — a fixture without one is an untested fixture —
 *   and an {@link InvalidFixtureExpectationError} for unusable content.
 */
export async function readFixtureExpectation(
  options: ReadFixtureOptions,
): Promise<FixtureExpectation> {
  if (!isFixtureCaseName(options.fixtureCase)) {
    throw new InvalidFixtureCaseError(options.fixtureCase);
  }

  const fixtureDir =
    options.fixtureDir ?? platformFixtureDir(options.platform, options.packageRoot);

  return parseFixtureExpectation(
    await readFile(fixtureExpectedPath(fixtureDir, options.fixtureCase), 'utf8'),
  );
}

/** The parsed JSON of an expectation file, reported in this module's terms. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InvalidFixtureExpectationError(
      `the content is no valid JSON (${error instanceof Error ? error.message : 'unknown reason'})`,
    );
  }
}

/** The value as a plain object. */
function asRecord(value: unknown, field = 'content'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidFixtureExpectationError(`the "${field}" is not a JSON object`);
  }

  return value as Record<string, unknown>;
}

function stringOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidFixtureExpectationError(`the "${field}" field is no non-empty string`);
  }

  return value;
}

function booleanOf(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidFixtureExpectationError(`the "${field}" field is no boolean`);
  }

  return value;
}

function countOf(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new InvalidFixtureExpectationError(
      'the "readablePostingCount" field is no count at or above 0',
    );
  }

  return value as number;
}

function positiveIntegerOf(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new InvalidFixtureExpectationError(`the "${field}" field is no positive integer`);
  }

  return value as number;
}

function fixtureCaseOf(value: unknown): string {
  const fixtureCase = stringOf(value, 'case');

  if (!isFixtureCaseName(fixtureCase)) {
    throw new InvalidFixtureExpectationError('the "case" field is no lowercase kebab-case name');
  }

  return fixtureCase;
}

function provenanceOf(value: unknown): FixtureProvenance {
  if (value !== 'CAPTURED' && value !== 'HAND_AUTHORED') {
    throw new InvalidFixtureExpectationError(
      'the "provenance" field is neither "CAPTURED" nor "HAND_AUTHORED"',
    );
  }

  return value;
}

function platformStatusOf(value: unknown): PlatformStatus {
  const status = PLATFORM_STATUSES.find((candidate) => candidate === value);

  if (status === undefined) {
    throw new InvalidFixtureExpectationError(
      'the "platformStatus" field names no known Platform_Status',
    );
  }

  return status;
}

function responseOf(value: unknown): FixtureResponseExpectation {
  const record = asRecord(value, 'response');
  const status = record.status;

  if (status !== null && !Number.isInteger(status)) {
    throw new InvalidFixtureExpectationError(
      'the "response.status" field is no integer and no null',
    );
  }

  const headers = asRecord(record.headers, 'response.headers');

  for (const [name, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== 'string') {
      throw new InvalidFixtureExpectationError(
        `the response header "${name}" carries no string value`,
      );
    }
  }

  return {
    status: status as number | null,
    headers: headers as Record<string, string>,
  };
}

function postingsOf(value: unknown): readonly RawJobPosting[] {
  if (!Array.isArray(value)) {
    throw new InvalidFixtureExpectationError('the "postings" field is no array');
  }

  return value.map((entry, index) => postingOf(entry, index));
}

/** One expected raw posting: all seven fields, each a string or `null`. */
function postingOf(value: unknown, index: number): RawJobPosting {
  const record = asRecord(value, `postings[${String(index)}]`);
  const posting: Record<string, string | null> = {};

  for (const field of RAW_POSTING_FIELDS) {
    const fieldValue = record[field];

    if (typeof fieldValue !== 'string' && fieldValue !== null) {
      throw new InvalidFixtureExpectationError(
        `the posting at index ${String(index)} states no string and no null for "${field}"`,
      );
    }

    posting[field] = fieldValue;
  }

  return posting as unknown as RawJobPosting;
}
