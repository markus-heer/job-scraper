/**
 * Property 5 of the job-search-tool design: normalization is total and respects every field limit.
 *
 * The input space is the one the design prescribes — a `RawJobPosting` whose seven fields are drawn
 * independently from `null`, the empty string, whitespace-only values, short unicode text, text
 * sitting within three characters of the field limit and text well over it — paired with a Platform,
 * a Scrape_Run start time and a publication date parser. Drawing each field on its own is what makes
 * the discard rule of 6.5 and the empty-field rule of 6.8 meet in the same run: a posting can arrive
 * with a blank title and a usable description, or with every optional field absent and all three
 * required fields present.
 *
 * Three generator decisions carry weight:
 *
 * - every generated text is wrapped in generated whitespace, including the non-breaking space a
 *   Platform renders an empty table cell as, so "trimmed first, and whitespace-only counts as absent"
 *   is exercised on values that are *not* blank as well as on values that are;
 * - one branch builds a value out of astral characters positioned so that a cut at the field limit
 *   lands inside a surrogate pair, which is the only way the "never split a character" part of the
 *   prefix statement can fail;
 * - the Scrape_Run start time may be an `Invalid Date` and the parser may answer with one, because
 *   totality is a claim about every input, and the publication date is the one field normalization
 *   does not compute itself.
 *
 * The oracle recomputes the rules from the requirements rather than reading them off the result: the
 * trimmed value of each raw field, the first blank field in the order of `REQUIRED_POSTING_FIELDS`,
 * and the four limits as literal numbers via `FIELD_LIMITS`. The truncation check is two-sided — a
 * prefix of the trimmed input, at or below the limit, and never shorter than the input cut one
 * character below the limit — so an implementation that truncated everything to a handful of
 * characters would still fail it.
 *
 * **Validates: Requirements 6.3, 6.5, 6.8**
 */

// Feature: job-search-tool, Property 5 - Normalization is total and respects every field limit

import { type Platform, PLATFORMS } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RawJobPosting } from '../../adapter/types.js';
import {
  FIELD_LIMITS,
  type NormalizationOutcome,
  normalizePosting,
  type PublicationDateParser,
  REQUIRED_POSTING_FIELDS,
  type RequiredPostingField,
} from '../normalize-posting.js';
import { parsePublicationDate } from '../parse-publication-date.js';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** One accepted field together with what it was built from, for the limit and prefix checks. */
interface FieldCheck {
  /** The field name, used to name the field in a failing expectation. */
  readonly name: string;
  readonly limit: number;
  /** The value as the Platform supplied it, untrimmed. */
  readonly rawValue: string | null;
  /** The value normalization produced. */
  readonly value: string | null;
}

/** Everything one generated run hands to {@link normalizePosting}. */
interface NormalizationInput {
  readonly platform: Platform;
  readonly raw: RawJobPosting;
  readonly runStartedAt: Date;
  readonly parse: PublicationDateParser;
}

/**
 * The whitespace a Result_Page carries around a value. `\u00a0` is in the list because a Platform
 * that renders an empty cell as a non-breaking space has supplied no value at all (6.8).
 */
const whitespaceArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  '',
  ' ',
  '   ',
  '\n',
  '\t',
  '\r\n ',
  '\u00a0',
  ' \u2009 ',
);

/** A value consisting of nothing but whitespace, plus the empty string. */
const blankArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  '',
  ' ',
  '    ',
  '\n\t ',
  '\u00a0',
  '\u00a0 \u2009',
);

/** Wraps a generated value in generated whitespace, the way a Result_Page delivers it. */
function padded(inner: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(whitespaceArbitrary, inner, whitespaceArbitrary)
    .map(([before, text, after]) => `${before}${text}${after}`);
}

/**
 * A value built from astral characters so that a cut at `limit` lands inside a surrogate pair.
 *
 * The leading `ä` is one UTF-16 code unit and every following character is two, so every even cut
 * position — and all four limits are even — falls between the halves of a pair.
 */
function astralArbitrary(limit: number): fc.Arbitrary<string> {
  return fc.nat({ max: 20 }).map((extra) => `ä${'\u{1d4a5}'.repeat(Math.ceil(limit / 2) + extra)}`);
}

/**
 * A raw field value: absent, blank, short unicode text, text around its limit or text over it.
 *
 * The boundary branch uses printable ASCII so that the generated length is the UTF-16 length the
 * limit is counted in, which is what puts values exactly at, just below and just above the bound.
 * The over-limit branch uses the full code point range, where a value can reach twice the generated
 * unit count in code units — well over the limit, as the design asks for.
 */
function fieldArbitrary(limit: number): fc.Arbitrary<string | null> {
  return fc.oneof(
    { arbitrary: fc.constant(null), weight: 3 },
    { arbitrary: blankArbitrary, weight: 3 },
    { arbitrary: padded(fc.string({ unit: 'binary', maxLength: 40 })), weight: 5 },
    {
      arbitrary: padded(
        fc.string({ unit: 'grapheme-ascii', minLength: limit - 3, maxLength: limit + 3 }),
      ),
      weight: 4,
    },
    {
      arbitrary: padded(fc.string({ unit: 'binary', minLength: limit + 1, maxLength: limit + 5 })),
      weight: 3,
    },
    { arbitrary: padded(astralArbitrary(limit)), weight: 3 },
  );
}

/** A publication date text: the German relative wordings, ISO shapes and arbitrary unicode. */
const publishedAtTextArbitrary: fc.Arbitrary<string | null> = fc.oneof(
  { arbitrary: fc.constant(null), weight: 2 },
  { arbitrary: blankArbitrary, weight: 1 },
  {
    arbitrary: padded(
      fc.oneof(
        fc.constantFrom('heute', 'gestern'),
        fc.nat({ max: 400 }).map((days) => `vor ${String(days)} Tagen`),
        fc.nat({ max: 48 }).map((hours) => `vor ${String(hours)} Stunden`),
        fc.date({ noInvalidDate: true }).map((date) => date.toISOString()),
      ),
    ),
    weight: 5,
  },
  { arbitrary: padded(fc.string({ unit: 'binary', maxLength: 30 })), weight: 3 },
);

/**
 * The parsers normalization is driven with: the real one of task 8.3 and three stubs.
 *
 * The stubs exist because 6.9 is a statement about what normalization does with the parser's answer,
 * not about the parser. `null` is the unparsable case, an `Invalid Date` is a parser that answers
 * with a value that only looks like a date, and an arbitrary `Date` covers answers the real parser
 * would never give.
 */
const parserArbitrary: fc.Arbitrary<PublicationDateParser> = fc.oneof(
  { arbitrary: fc.constant<PublicationDateParser>(parsePublicationDate), weight: 4 },
  { arbitrary: fc.constant<PublicationDateParser>(() => null), weight: 2 },
  { arbitrary: fc.constant<PublicationDateParser>(() => new Date('kein Datum')), weight: 1 },
  {
    arbitrary: fc.date().map<PublicationDateParser>((date) => () => date),
    weight: 2,
  },
);

/**
 * Lengths that shape the generated Posting_Id and source URL. Neither field carries a limit in 6.3,
 * so these are plausible value sizes rather than bounds — the assertions require both fields to come
 * out as the trimmed input whatever their length.
 */
const POSTING_ID_LENGTH = 40;
const SOURCE_URL_LENGTH = 60;

const normalizationInputArbitrary: fc.Arbitrary<NormalizationInput> = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  raw: fc.record({
    postingId: fieldArbitrary(POSTING_ID_LENGTH),
    title: fieldArbitrary(FIELD_LIMITS.title),
    employer: fieldArbitrary(FIELD_LIMITS.employer),
    workLocation: fieldArbitrary(FIELD_LIMITS.workLocation),
    publishedAtText: publishedAtTextArbitrary,
    sourceUrl: fieldArbitrary(SOURCE_URL_LENGTH),
    descriptionText: fieldArbitrary(FIELD_LIMITS.descriptionText),
  }),
  runStartedAt: fc.date(),
  parse: parserArbitrary,
});

/** The trimmed value, or `null` where the Platform supplied nothing but whitespace (6.5, 6.8). */
function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';

  return trimmed.length === 0 ? null : trimmed;
}

/** The first field of 6.5 that is missing or whitespace only, or `null` where all three are there. */
function firstBlankRequiredField(raw: RawJobPosting): RequiredPostingField | null {
  for (const field of REQUIRED_POSTING_FIELDS) {
    if (trimmedOrNull(raw[field]) === null) {
      return field;
    }
  }

  return null;
}

/** Whether `value` ends on the high half of a surrogate pair, which is half a character. */
function endsOnLoneHighSurrogate(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const lastUnit = value.charCodeAt(value.length - 1);

  return lastUnit >= 0xd800 && lastUnit <= 0xdbff;
}

/** The four limited fields of 6.3 with the raw values they were built from. */
function fieldChecks(raw: RawJobPosting, outcome: NormalizationOutcome): readonly FieldCheck[] {
  if (outcome.kind !== 'ACCEPTED') {
    return [];
  }

  const { posting } = outcome;

  return [
    { name: 'title', limit: FIELD_LIMITS.title, rawValue: raw.title, value: posting.title },
    {
      name: 'employer',
      limit: FIELD_LIMITS.employer,
      rawValue: raw.employer,
      value: posting.employer,
    },
    {
      name: 'workLocation',
      limit: FIELD_LIMITS.workLocation,
      rawValue: raw.workLocation,
      value: posting.workLocation,
    },
    {
      name: 'descriptionText',
      limit: FIELD_LIMITS.descriptionText,
      rawValue: raw.descriptionText,
      value: posting.descriptionText,
    },
  ];
}

describe('Property 5: Normalization is total and respects every field limit', () => {
  /**
   * **Validates: Requirements 6.5**
   *
   * For all raw postings, normalization returns one of exactly two outcomes, and it returns
   * `DISCARDED` exactly when title, source URL or Posting_Id is missing or whitespace only — naming
   * the first such field together with the platform name and the trimmed source URL.
   */
  it('discards exactly the postings missing one of title, source URL or Posting_Id', () => {
    let accepted = 0;
    const discardedPerField = new Map<RequiredPostingField, number>();

    fc.assert(
      fc.property(normalizationInputArbitrary, ({ platform, raw, runStartedAt, parse }) => {
        // Nothing is caught here: a thrown error fails the property, which is the totality half of
        // the statement.
        const outcome = normalizePosting(platform, raw, runStartedAt, parse);
        const expectedField = firstBlankRequiredField(raw);

        expect(['ACCEPTED', 'DISCARDED']).toContain(outcome.kind);

        if (expectedField === null) {
          accepted += 1;

          expect(outcome.kind).toBe('ACCEPTED');

          return;
        }

        discardedPerField.set(expectedField, (discardedPerField.get(expectedField) ?? 0) + 1);

        // Asserted as a whole, so the discard outcome carries exactly the fields 6.5 asks the caller
        // to report and nothing is silently added or left out.
        expect(outcome).toEqual({
          kind: 'DISCARDED',
          reason: 'MISSING_REQUIRED_FIELD',
          field: expectedField,
          code: 'posting.discardedMissingField',
          platform,
          // 6.5 asks for the source URL alongside the platform name; where the source URL itself is
          // the missing field there is none to report.
          sourceUrl: expectedField === 'sourceUrl' ? null : trimmedOrNull(raw.sourceUrl),
        });
      }),
      PROPERTY_RUNS,
    );

    // Both branches of the equivalence have to occur, and each of the three fields has to be the
    // reported one at least once, otherwise the property would pass on a generator that never
    // reaches the discard path.
    expect(accepted).toBeGreaterThan(0);

    for (const field of REQUIRED_POSTING_FIELDS) {
      expect(discardedPerField.get(field) ?? 0).toBeGreaterThan(0);
    }
  });

  /**
   * **Validates: Requirements 6.3**
   *
   * For all accepted postings, every limited field is at or below its limit and is a prefix of the
   * trimmed input, no cut splits a character, and the two unlimited identifying fields are the
   * trimmed input unchanged.
   */
  it('keeps every accepted field within its limit as a prefix of the trimmed input', () => {
    let truncations = 0;
    let untouchedValues = 0;

    fc.assert(
      fc.property(normalizationInputArbitrary, ({ platform, raw, runStartedAt, parse }) => {
        const outcome = normalizePosting(platform, raw, runStartedAt, parse);

        if (outcome.kind !== 'ACCEPTED') {
          return;
        }

        expect(outcome.posting.platform).toBe(platform);
        // Source URL and Posting_Id carry no limit: truncating either would leave a value that no
        // longer resolves or no longer matches the Platform's identifier.
        expect(outcome.posting.sourceUrl).toBe(trimmedOrNull(raw.sourceUrl));
        expect(outcome.posting.postingId).toBe(trimmedOrNull(raw.postingId));

        for (const { name, limit, rawValue, value } of fieldChecks(raw, outcome)) {
          const trimmed = trimmedOrNull(rawValue);

          if (trimmed === null) {
            continue;
          }

          // A field the Platform did supply stays supplied: the `null` of 6.8 is reserved for the
          // absent case, which the previous branch has already taken.
          expect(value, `${name} is kept`).not.toBeNull();

          if (value === null) {
            continue;
          }

          expect(value.length, `${name} stays within its limit`).toBeLessThanOrEqual(limit);
          expect(trimmed.startsWith(value), `${name} is a prefix of its trimmed input`).toBe(true);
          // A value that survived at all is a value: no limit turns text into an empty string, which
          // would be indistinguishable from the "absent" of 6.8.
          expect(value.length, `${name} is not emptied`).toBeGreaterThan(0);
          expect(value, `${name} carries no whitespace exposed by the cut`).toBe(value.trimEnd());
          expect(endsOnLoneHighSurrogate(value), `${name} does not end on half a character`).toBe(
            false,
          );

          if (trimmed.length <= limit) {
            untouchedValues += 1;

            expect(value, `${name} is left untouched within its limit`).toBe(trimmed);

            continue;
          }

          truncations += 1;
          // The lower bound against over-truncation: dropping the character the cut may split and
          // the whitespace it may expose is all a truncation is allowed to cost.
          expect(value.length, `${name} keeps everything up to its limit`).toBeGreaterThanOrEqual(
            trimmed.slice(0, limit - 1).trimEnd().length,
          );
        }
      }),
      PROPERTY_RUNS,
    );

    expect(truncations).toBeGreaterThan(0);
    expect(untouchedValues).toBeGreaterThan(0);
  });

  /**
   * **Validates: Requirements 6.8**
   *
   * For all accepted postings, an optional field the Platform did not supply — absent or whitespace
   * only — is `null` and the posting is kept; the publication date is `null` or a usable date, and
   * the unparsable note appears exactly where a date text was supplied but no date resulted (6.9).
   */
  it('marks every absent optional field as empty and keeps the posting', () => {
    let absentOptionalFields = 0;
    let unparsableDates = 0;
    let parsedDates = 0;

    fc.assert(
      fc.property(normalizationInputArbitrary, ({ platform, raw, runStartedAt, parse }) => {
        const outcome = normalizePosting(platform, raw, runStartedAt, parse);

        if (outcome.kind !== 'ACCEPTED') {
          return;
        }

        for (const { name, rawValue, value } of fieldChecks(raw, outcome)) {
          if (trimmedOrNull(rawValue) !== null) {
            continue;
          }

          if (name !== 'title') {
            absentOptionalFields += 1;
          }

          expect(value, `${name} is marked as empty`).toBeNull();
        }

        const { publishedAt } = outcome.posting;

        // Never an `Invalid Date`: a field that looks set but serializes to "Invalid Date" is worse
        // than the empty publication date 6.9 allows.
        if (publishedAt !== null) {
          parsedDates += 1;

          expect(Number.isNaN(publishedAt.getTime())).toBe(false);
        }

        // 6.9: the note accompanies exactly the case where the Platform showed a date text that did
        // not become a date. No text, no note; a resolved date, no note.
        const expectedNotes =
          trimmedOrNull(raw.publishedAtText) !== null && publishedAt === null
            ? ['posting.publicationDateUnparsable']
            : [];

        unparsableDates += expectedNotes.length;

        expect(outcome.notes).toEqual(expectedNotes);
      }),
      PROPERTY_RUNS,
    );

    expect(absentOptionalFields).toBeGreaterThan(0);
    expect(unparsableDates).toBeGreaterThan(0);
    expect(parsedDates).toBeGreaterThan(0);
  });
});
