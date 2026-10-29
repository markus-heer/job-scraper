/**
 * Unit tests for the pure normalization layer (6.3, 6.5, 6.8).
 *
 * These cover the concrete cases: a clean posting, each field limit, the three discard fields and the
 * empty-field rule. The universally quantified statement — normalization is total and every accepted
 * field respects its limit while staying a prefix of the input — is Property 5 and lives in its own
 * test (task 8.5).
 */

import { describe, expect, it } from 'vitest';

import type { RawJobPosting } from '../../adapter/types.js';
import {
  FIELD_LIMITS,
  normalizePosting,
  type PublicationDateParser,
  REQUIRED_POSTING_FIELDS,
  type RequiredPostingField,
} from '../normalize-posting.js';

const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/** A raw posting with every field supplied, as a base for the single-field variations below. */
function rawPosting(overrides: Partial<RawJobPosting> = {}): RawJobPosting {
  return {
    postingId: 'ST-4711',
    title: 'Projektmanagerin Pharma',
    employer: 'Beispiel Pharma GmbH',
    workLocation: 'München',
    publishedAtText: 'vor 3 Tagen',
    sourceUrl: 'https://example.test/jobs/4711',
    descriptionText: 'Wir suchen eine Projektmanagerin.',
    ...overrides,
  };
}

/** Stands in for the parser of task 8.3: one known wording, everything else unparsable. */
const parseKnownWording: PublicationDateParser = (text) =>
  text === 'vor 3 Tagen' ? new Date('2026-02-27T08:00:00.000Z') : null;

/** A parser that recognises nothing, so every non-empty date text is unparsable (6.9). */
const parseNothing: PublicationDateParser = () => null;

describe('a posting with every field supplied', () => {
  it('normalizes onto the eight fields of 6.3', () => {
    const outcome = normalizePosting('STEPSTONE', rawPosting(), RUN_STARTED_AT, parseKnownWording);

    expect(outcome).toEqual({
      kind: 'ACCEPTED',
      notes: [],
      posting: {
        platform: 'STEPSTONE',
        postingId: 'ST-4711',
        title: 'Projektmanagerin Pharma',
        employer: 'Beispiel Pharma GmbH',
        workLocation: 'München',
        publishedAt: new Date('2026-02-27T08:00:00.000Z'),
        sourceUrl: 'https://example.test/jobs/4711',
        descriptionText: 'Wir suchen eine Projektmanagerin.',
      },
    });
  });

  it('trims the surrounding whitespace a Result_Page carries into every field', () => {
    const outcome = normalizePosting(
      'JOBVECTOR',
      rawPosting({
        postingId: '  JV-9  ',
        title: '\n  Projektleiter  \t',
        employer: ' Beispiel AG\n',
        workLocation: '\tMünchen ',
        sourceUrl: '  https://example.test/jobs/9  ',
        descriptionText: '  Aufgaben  ',
      }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({
      kind: 'ACCEPTED',
      posting: {
        postingId: 'JV-9',
        title: 'Projektleiter',
        employer: 'Beispiel AG',
        workLocation: 'München',
        sourceUrl: 'https://example.test/jobs/9',
        descriptionText: 'Aufgaben',
      },
    });
  });
});

describe('the field limits of 6.3', () => {
  it('truncates every limited field to its upper bound, keeping a prefix of the input', () => {
    const raw = rawPosting({
      title: 'T'.repeat(FIELD_LIMITS.title + 50),
      employer: 'E'.repeat(FIELD_LIMITS.employer + 50),
      workLocation: 'W'.repeat(FIELD_LIMITS.workLocation + 50),
      descriptionText: 'D'.repeat(FIELD_LIMITS.descriptionText + 50),
    });

    const outcome = normalizePosting('INDEED', raw, RUN_STARTED_AT, parseKnownWording);

    if (outcome.kind !== 'ACCEPTED') {
      throw new Error('An over-long value is truncated, not discarded.');
    }

    const { title, employer, workLocation, descriptionText } = outcome.posting;

    expect(title).toHaveLength(FIELD_LIMITS.title);
    expect(employer).toHaveLength(FIELD_LIMITS.employer);
    expect(workLocation).toHaveLength(FIELD_LIMITS.workLocation);
    expect(descriptionText).toHaveLength(FIELD_LIMITS.descriptionText);
    expect(raw.title?.startsWith(title)).toBe(true);
    expect(raw.descriptionText?.startsWith(descriptionText ?? '')).toBe(true);
  });

  it('leaves a value exactly at its limit untouched', () => {
    const title = 'T'.repeat(FIELD_LIMITS.title);

    const outcome = normalizePosting(
      'INDEED',
      rawPosting({ title }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({ kind: 'ACCEPTED', posting: { title } });
  });

  it('never cuts an astral character in half', () => {
    // 'ä' plus 100 astral characters is 201 UTF-16 code units, so the cut at 200 would land inside
    // the last pair.
    const title = `ä${'𝒥'.repeat(100)}`;

    const outcome = normalizePosting(
      'GLASSDOOR',
      rawPosting({ title }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    if (outcome.kind !== 'ACCEPTED') {
      throw new Error('An over-long title is truncated, not discarded.');
    }

    expect(outcome.posting.title).toBe(`ä${'𝒥'.repeat(99)}`);
    expect(outcome.posting.title.length).toBeLessThanOrEqual(FIELD_LIMITS.title);
    expect(title.startsWith(outcome.posting.title)).toBe(true);
  });

  it('leaves no whitespace at an end exposed by the cut', () => {
    const title = `${'T'.repeat(FIELD_LIMITS.title - 1)}   Rest`;

    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting({ title }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({
      kind: 'ACCEPTED',
      posting: { title: 'T'.repeat(FIELD_LIMITS.title - 1) },
    });
  });
});

describe('an absent optional field (6.8)', () => {
  it('is marked as empty and the Job_Posting is kept', () => {
    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting({
        employer: null,
        workLocation: null,
        publishedAtText: null,
        descriptionText: null,
      }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({
      kind: 'ACCEPTED',
      notes: [],
      posting: {
        employer: null,
        workLocation: null,
        publishedAt: null,
        descriptionText: null,
        title: 'Projektmanagerin Pharma',
      },
    });
  });

  it('counts a whitespace-only value as absent rather than as a value', () => {
    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting({ employer: '   ', workLocation: '\u00a0', descriptionText: '\n\t ' }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({
      kind: 'ACCEPTED',
      posting: { employer: null, workLocation: null, descriptionText: null },
    });
  });
});

/** Per required field of 6.5: the absent variation and the whitespace-only variation. */
const missingFieldCases: ReadonlyArray<
  readonly [RequiredPostingField, Partial<RawJobPosting>, Partial<RawJobPosting>]
> = [
  ['title', { title: null }, { title: '   \n' }],
  ['sourceUrl', { sourceUrl: null }, { sourceUrl: ' ' }],
  ['postingId', { postingId: null }, { postingId: '\t\u00a0' }],
];

describe('a posting missing one of the three required fields (6.5)', () => {
  it('varies exactly the three fields of 6.5, in their reported order', () => {
    expect(missingFieldCases.map(([field]) => field)).toEqual([...REQUIRED_POSTING_FIELDS]);
  });

  it.each(missingFieldCases)('discards it when %s is absent', (field, absent) => {
    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting(absent),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({
      kind: 'DISCARDED',
      reason: 'MISSING_REQUIRED_FIELD',
      field,
      code: 'posting.discardedMissingField',
      platform: 'STEPSTONE',
    });
  });

  it.each(missingFieldCases)('discards it when %s is whitespace only', (field, _absent, blank) => {
    const outcome = normalizePosting(
      'JOBVECTOR',
      rawPosting(blank),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({ kind: 'DISCARDED', field });
  });

  it('reports the source URL 6.5 asks for alongside the platform name', () => {
    const outcome = normalizePosting(
      'INDEED',
      rawPosting({ title: null }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({
      kind: 'DISCARDED',
      platform: 'INDEED',
      sourceUrl: 'https://example.test/jobs/4711',
    });
  });

  it('names the first missing field in a fixed order when several are absent', () => {
    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting({ title: null, sourceUrl: null, postingId: null }),
      RUN_STARTED_AT,
      parseKnownWording,
    );

    expect(outcome).toMatchObject({ kind: 'DISCARDED', field: 'title', sourceUrl: null });
  });
});

describe('the publication date boundary towards the parser of task 8.3', () => {
  it('hands the trimmed text and the Scrape_Run start time to the parser', () => {
    const calls: Array<readonly [string | null, Date]> = [];
    const recording: PublicationDateParser = (text, runStartedAt) => {
      calls.push([text, runStartedAt]);

      return null;
    };

    normalizePosting(
      'STEPSTONE',
      rawPosting({ publishedAtText: '  heute  ' }),
      RUN_STARTED_AT,
      recording,
    );

    expect(calls).toEqual([['heute', RUN_STARTED_AT]]);
  });

  it('keeps the Job_Posting with an empty publication date and one note when the text is unparsable (6.9)', () => {
    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting({ publishedAtText: 'irgendwann neulich' }),
      RUN_STARTED_AT,
      parseNothing,
    );

    expect(outcome).toMatchObject({
      kind: 'ACCEPTED',
      notes: ['posting.publicationDateUnparsable'],
      posting: { publishedAt: null, title: 'Projektmanagerin Pharma' },
    });
  });

  it('asks the parser nothing and notes nothing when the Platform supplied no date at all', () => {
    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting({ publishedAtText: '   ' }),
      RUN_STARTED_AT,
      () => {
        throw new Error('The parser is not called for an absent date text.');
      },
    );

    expect(outcome).toMatchObject({ kind: 'ACCEPTED', notes: [], posting: { publishedAt: null } });
  });

  it('treats an invalid Date from the parser as unparsable', () => {
    const outcome = normalizePosting(
      'STEPSTONE',
      rawPosting({ publishedAtText: 'vor drölf Tagen' }),
      RUN_STARTED_AT,
      () => new Date('not a date'),
    );

    expect(outcome).toMatchObject({
      kind: 'ACCEPTED',
      notes: ['posting.publicationDateUnparsable'],
      posting: { publishedAt: null },
    });
  });
});
