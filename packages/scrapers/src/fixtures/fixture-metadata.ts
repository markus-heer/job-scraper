/**
 * The `captured-at` sidecar of a frozen fixture (design, Testing Strategy).
 *
 * A fixture without a capture date is a page of unknown age, and the whole fixture refresh loop of
 * the design — a `PAGE_LAYOUT_UNKNOWN` leads to a re-capture, a selector fix and a new review date in
 * `docs/adapters/<platform>.md` (14.7) — needs to know how old the frozen page is. The sidecar
 * records that date plus the provenance of the file: which Platform, which URL, which HTTP status,
 * which user agent (14.5) and what the sanitization removed.
 *
 * Validation on read is deliberate rather than defensive: the sidecar is hand-editable, lives in the
 * repository for a long time and is read by tests that would otherwise fail with a confusing message
 * about an undefined date.
 */

import { type Platform, PLATFORMS } from '@job-scraper/domain';

import type { FixtureSanitizationReport } from './sanitize-html.js';

/** The provenance of one captured fixture, written next to the HTML it describes. */
export interface FixtureCaptureMetadata {
  readonly platform: Platform;
  /** The fixture case this file belongs to, matching the HTML file name. */
  readonly case: string;
  /** When the single real retrieval happened, as an ISO 8601 timestamp. */
  readonly capturedAt: string;
  /** The Result_Page number the capture asked for (13.3). */
  readonly pageNumber: number;
  /** The URL the capture requested. */
  readonly requestUrl: string;
  /** The URL the retrieval ended on, which differs after a redirect such as a sign-in wall (7.2). */
  readonly finalUrl: string;
  /** HTTP status of the main document, or `null` where the Platform served none. */
  readonly httpStatus: number | null;
  /** The unchanged Job_Tool user agent the retrieval sent (14.5). */
  readonly userAgent: string;
  /** Bytes before and after sanitization, so a suspiciously small capture is visible at a glance. */
  readonly bytes: { readonly raw: number; readonly sanitized: number };
  readonly sanitization: FixtureSanitizationReport;
}

/** A sidecar that is not readable as {@link FixtureCaptureMetadata}. */
export class InvalidFixtureMetadataError extends Error {
  constructor(reason: string) {
    super(`The fixture capture metadata is unusable: ${reason}.`);
    this.name = 'InvalidFixtureMetadataError';
  }
}

/** Serialises the metadata as the sidecar content: pretty-printed JSON with a trailing newline. */
export function formatFixtureMetadata(metadata: FixtureCaptureMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

/**
 * Reads a sidecar.
 *
 * @throws An {@link InvalidFixtureMetadataError} when the text is not JSON, is not an object, names
 *   no known Platform or carries no parsable capture date.
 */
export function parseFixtureMetadata(text: string): FixtureCaptureMetadata {
  const parsed: unknown = parseJson(text);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidFixtureMetadataError('the content is not a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const platform = record.platform;
  const capturedAt = record.capturedAt;

  if (typeof platform !== 'string' || !isPlatform(platform)) {
    throw new InvalidFixtureMetadataError('the "platform" field names no known Platform');
  }

  if (typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt))) {
    throw new InvalidFixtureMetadataError('the "capturedAt" field is no parsable date');
  }

  return { ...(record as unknown as FixtureCaptureMetadata), platform, capturedAt };
}

/** The capture date of a sidecar as a `Date`. */
export function fixtureCapturedAt(metadata: FixtureCaptureMetadata): Date {
  return new Date(metadata.capturedAt);
}

/** Parses JSON and reports a failure in the terms of this module. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InvalidFixtureMetadataError(
      `the content is no valid JSON (${error instanceof Error ? error.message : 'unknown reason'})`,
    );
  }
}

/** Whether a string is one of the Platform values. */
function isPlatform(value: string): value is Platform {
  return PLATFORMS.some((platform) => platform === value);
}
