/**
 * The pure normalization layer: one raw posting read from a Result_Page becomes either one
 * Job_Posting with the eight fields of Requirement 6.3, or a discarded posting naming the field that
 * made it unusable (6.5).
 *
 * This is the single place where the two neighbouring rules of the requirements are told apart, and
 * the distinction is the whole reason the layer exists:
 *
 * - 6.5 names three fields — title, source URL and Posting_Id — whose absence makes a Job_Posting
 *   worthless: without them it can neither be shown, nor opened, nor upserted on `(platform,
 *   postingId)`. A raw posting missing one of them is **discarded**.
 * - 6.8 names the remaining optional fields — employer, work location, publication date, description
 *   text. Their absence costs detail, not identity, so the affected field is **marked as empty**
 *   (`null`) and the Job_Posting is kept.
 *
 * "Missing" in both rules covers the whitespace-only case explicitly for the three required fields,
 * and this layer applies the same reading to the optional ones: a Platform that renders an empty
 * employer cell as `"\u00a0"` has not supplied an employer, so the field is empty rather than a value
 * consisting of invisible characters. Every value is therefore trimmed first, and a value that is
 * empty after trimming is `null`.
 *
 * Purity is deliberate. The only time input is the Scrape_Run start time (6.4), the only platform
 * input is the Platform name, and the publication date parser arrives as an argument — see
 * {@link PublicationDateParser}. Nothing here reads a clock, a configuration or the Log_Stream: the
 * events 6.5 and 6.9 ask for are *returned* (as the discard reason and as {@link NormalizationNote}
 * codes) and written to the Log_Stream by the caller, which is the component that knows the run
 * identifier and the page number.
 *
 * No German text lives here either, for the same reason as in `../adapter/errors.ts`: the user-facing
 * wording is mapped once, in the API_Service, from the stable English codes below.
 */

import type { Platform } from '@job-scraper/domain';

import type { RawJobPosting } from '../adapter/types.js';

/**
 * A normalized Job_Posting: the eight fields of 6.3, with every length limit already applied.
 *
 * The three fields 6.5 guards are non-nullable, which is what makes the discard decision visible in
 * the type — a consumer of an `ACCEPTED` outcome never has to re-check them. The four fields 6.8
 * covers are nullable, where `null` is exactly the "marked as empty" of that criterion.
 */
export interface NormalizedJobPosting {
  readonly platform: Platform;
  readonly postingId: string;
  readonly title: string;
  readonly employer: string | null;
  readonly workLocation: string | null;
  /** Absolute publication date, or `null` where the Platform supplied none or an unparsable one (6.9). */
  readonly publishedAt: Date | null;
  readonly sourceUrl: string;
  readonly descriptionText: string | null;
}

/**
 * The upper bounds of 6.3, in UTF-16 code units, which is what `String.prototype.length` counts and
 * what the `varchar` limits of the Posting_Store are declared in.
 *
 * Only these four fields carry a limit. Source URL and Posting_Id carry none on purpose: truncating
 * either would produce a value that still looks usable but no longer resolves or no longer matches the
 * Platform's identifier, and 6.3 asks for truncation of the displayed text fields only.
 */
export const FIELD_LIMITS = {
  title: 200,
  employer: 150,
  workLocation: 150,
  descriptionText: 10_000,
} as const;

/**
 * The three fields whose absence discards the Job_Posting (6.5), in the order they are reported.
 *
 * The order is fixed so that a posting missing several of them always names the same field, which
 * keeps the discard events of a frozen fixture stable across runs.
 */
export const REQUIRED_POSTING_FIELDS = ['title', 'sourceUrl', 'postingId'] as const;

/** One of the three fields of 6.5. */
export type RequiredPostingField = (typeof REQUIRED_POSTING_FIELDS)[number];

/**
 * A stable English code for an observation made while normalizing a posting that was nevertheless
 * kept. The caller turns it into a Log_Stream entry with platform name and source URL.
 *
 * Today the only member is the unparsable publication date of 6.9. It stays a union rather than a
 * bare `string` so that adding a note later is a type-checked change at every call site that maps
 * codes onto German text.
 */
export type NormalizationNote = 'posting.publicationDateUnparsable';

/**
 * The outcome of normalizing one raw posting. Total over every {@link RawJobPosting}: there is no
 * third case and nothing throws, which is the totality half of Property 5.
 */
export type NormalizationOutcome =
  | {
      readonly kind: 'ACCEPTED';
      readonly posting: NormalizedJobPosting;
      /** Observations worth a Log_Stream entry; empty for a posting that normalized cleanly. */
      readonly notes: readonly NormalizationNote[];
    }
  /** title, sourceUrl or postingId missing or whitespace only (6.5). */
  | {
      readonly kind: 'DISCARDED';
      readonly reason: 'MISSING_REQUIRED_FIELD';
      /** The first field of {@link REQUIRED_POSTING_FIELDS} that was missing or whitespace only. */
      readonly field: RequiredPostingField;
      /** Stable English log key for the event 6.5 asks to report. */
      readonly code: 'posting.discardedMissingField';
      readonly platform: Platform;
      /**
       * The source URL 6.5 asks to report alongside the platform name, trimmed, or `null` where the
       * missing field *is* the source URL. The caller logs the Result_Page URL in that case.
       */
      readonly sourceUrl: string | null;
    };

/**
 * Converts a publication date text into an absolute date relative to the Scrape_Run start time (6.4).
 *
 * Injected rather than imported so that this module stays independent of the German relative-date
 * vocabulary and of `date-fns`: the implementation lives in its own module (`parse-publication-date`,
 * task 8.3) and is the only thing that has to change when a Platform invents a new date wording.
 * Normalization only cares about the two outcomes — a date, or `null` for "unparsable", which 6.9
 * turns into an empty publication date plus a note.
 *
 * An implementation is expected to be total and to throw for no input. A thrown error would propagate,
 * so a parser under construction should return `null` instead.
 */
export type PublicationDateParser = (text: string | null, runStartedAt: Date) => Date | null;

/** The trimmed value, or `null` where there was nothing but whitespace (the "empty" of 6.8). */
function blankToNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Cuts `value` down to `limit` code units, as 6.3 demands for an over-long value.
 *
 * The result is always a prefix of the input, so no truncation can invent characters the Platform did
 * not show. Two details keep that prefix sound: a trailing unpaired high surrogate is dropped, so the
 * cut never splits an astral character into an isolated half that renders as a replacement glyph; and
 * whitespace exposed at the new end is trimmed, so a value cut mid-gap does not carry a trailing
 * space into the Posting_Store.
 */
function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const cut = value.slice(0, limit);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const endsOnLoneHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;

  return (endsOnLoneHighSurrogate ? cut.slice(0, -1) : cut).trimEnd();
}

/** The trimmed value cut to its limit, or `null` where the Platform supplied none (6.3, 6.8). */
function optionalText(value: string | null, limit: number): string | null {
  const trimmed = blankToNull(value);

  return trimmed === null ? null : truncate(trimmed, limit);
}

/** The discard outcome of 6.5, carrying what the caller needs for the event it reports. */
function discarded(
  platform: Platform,
  field: RequiredPostingField,
  sourceUrl: string | null,
): NormalizationOutcome {
  return {
    kind: 'DISCARDED',
    reason: 'MISSING_REQUIRED_FIELD',
    field,
    code: 'posting.discardedMissingField',
    platform,
    sourceUrl,
  };
}

/**
 * Normalizes one raw posting read from a Result_Page into a Job_Posting (6.3), discarding it where one
 * of the three fields of 6.5 is missing and marking absent optional fields as empty (6.8).
 *
 * @param platform The Platform the posting was read from; the platform name field of 6.3.
 * @param raw The values as read from the Result_Page, each one possibly absent.
 * @param runStartedAt The Scrape_Run start time, the reference point for a relative date (6.4).
 * @param parsePublicationDate The date parser of task 8.3; see {@link PublicationDateParser}.
 * @returns `ACCEPTED` with the Job_Posting and any notes, or `DISCARDED` naming the missing field.
 */
export function normalizePosting(
  platform: Platform,
  raw: RawJobPosting,
  runStartedAt: Date,
  parsePublicationDate: PublicationDateParser,
): NormalizationOutcome {
  const trimmedTitle = blankToNull(raw.title);
  const sourceUrl = blankToNull(raw.sourceUrl);
  const postingId = blankToNull(raw.postingId);

  // Checked one after the other in the order of REQUIRED_POSTING_FIELDS. That both fixes which field
  // a posting missing several of them reports and narrows all three to `string` for the code below.
  if (trimmedTitle === null) {
    return discarded(platform, 'title', sourceUrl);
  }

  if (sourceUrl === null) {
    return discarded(platform, 'sourceUrl', null);
  }

  if (postingId === null) {
    return discarded(platform, 'postingId', sourceUrl);
  }

  const title = truncate(trimmedTitle, FIELD_LIMITS.title);
  const publishedAtText = blankToNull(raw.publishedAtText);
  const parsed =
    publishedAtText === null ? null : parsePublicationDate(publishedAtText, runStartedAt);
  // An invalid Date would travel on as a field that looks set but serializes to "Invalid Date". It is
  // treated like an unparsable value, so the invariant "publishedAt is null or a usable Date" holds
  // whatever a parser answers.
  const publishedAt = parsed === null || Number.isNaN(parsed.getTime()) ? null : parsed;
  const unparsableDate = publishedAtText !== null && publishedAt === null;

  return {
    kind: 'ACCEPTED',
    posting: {
      platform,
      postingId,
      title,
      employer: optionalText(raw.employer, FIELD_LIMITS.employer),
      workLocation: optionalText(raw.workLocation, FIELD_LIMITS.workLocation),
      publishedAt,
      sourceUrl,
      descriptionText: optionalText(raw.descriptionText, FIELD_LIMITS.descriptionText),
    },
    notes: unparsableDate ? ['posting.publicationDateUnparsable'] : [],
  };
}
