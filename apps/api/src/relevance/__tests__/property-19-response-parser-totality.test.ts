/**
 * Property 19 of the job-search-tool design: the relevance response parser is total.
 *
 * The subject is `parseRelevanceResponse`, the one function the whole enrichment stage reads an
 * AI_Provider answer through, plus the envelope path that leads to it —
 * `anthropicMessageResponseSchema` and `reportRelevanceToolInput`. 15.14 is a statement about *all*
 * responses, which is why it is a property and not a case: the example tests next to this file pin
 * the shapes a model is known to answer with, while this file states that no third shape exists.
 * Reading any value yields either exactly one permitted Relevance_Verdict with a Relevance_Reason of
 * 1 to 300 characters, or `null`, and never an exception that would end a Scrape_Run over a renamed
 * JSON field (15.12).
 *
 * The oracle recomputes the two bounds of 15.12 from the requirement rather than from the schema:
 * `verdict` has to be one of the three verdicts a model may answer with, and `reason` has to be a
 * string of at least one and at most 300 UTF-16 code units. It is an *equivalence*, not an
 * implication, so the property bites in both directions — a parser that answered `null` for
 * everything would fail it as surely as one that let a fourth verdict through.
 *
 * Three generator decisions carry weight:
 *
 * - `NOT_ASSESSED` is drawn as a verdict value in its own right. It is a member of
 *   `RELEVANCE_VERDICTS` and therefore the one rejection that no generic "unknown string" branch
 *   would produce, yet it is the rejection that matters most: it is the Job_Tool's record of a
 *   missing answer (15.10, 15.11), and a model that claimed it would make "nothing decisive was
 *   found" and "we never got an answer" indistinguishable in the stored data.
 * - every generated tool input may carry extra properties. 15.12 asks for a response that *deviates
 *   from the expected format* to be discarded, and an added field is not that deviation — the design
 *   strips unknown properties, so the oracle requires the result to be exactly the two fields and
 *   nothing more.
 * - the totality half is driven by `fc.anything()` and `fc.jsonValue()` as well as by the structured
 *   mixture, because `toolInput` is typed `unknown` for a reason: it is the `input` property of a
 *   third-party tool-use block, with no guarantee beyond having been JSON, and the value the caller
 *   passes when it found no tool-use block at all.
 *
 * One shape the oracle accepts deliberately: a reason consisting of nothing but whitespace. The
 * bound of the design is `.min(1).max(300)` on the untrimmed value, so `'   '` is a Relevance_Reason
 * as far as the parser is concerned. Whether the reason is German and names the decisive factor
 * (15.3, 15.4) is the system prompt's business and cannot be checked by a validator; this property
 * states the shape, not the wording.
 *
 * **Validates: Requirements 15.3, 15.12, 15.14**
 */

// Feature: job-search-tool, Property 19 - The relevance response parser is total

import { RELEVANCE_VERDICTS } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_TOOL_NAME,
  ANTHROPIC_TOOL_USE_BLOCK_TYPE,
  anthropicMessageResponseSchema,
  reportRelevanceToolInput,
} from '../anthropic-relevance.schema';
import {
  ASSESSED_RELEVANCE_VERDICTS,
  parseRelevanceResponse,
  RELEVANCE_REASON_MAX_LENGTH,
  type RelevanceResponse,
} from '../relevance-assessor.port';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The verdicts the oracle permits, as plain strings, read from the port's own list. */
const PERMITTED_VERDICTS: readonly string[] = ASSESSED_RELEVANCE_VERDICTS;

/** The two properties a usable response consists of, and the only two it may come out with. */
const RESPONSE_KEYS = ['reason', 'verdict'] as const;

/**
 * Reads one property off a generated value without claiming anything about its type.
 *
 * The assertion is to `Record<string, unknown>`, not to the response shape: the point of the oracle
 * is to judge the two fields *after* reading them as `unknown`, which is the state the parser gets
 * them in.
 */
const propertyOf = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
};

/**
 * The oracle: whether 15.12 permits this value to become a stored assessment.
 *
 * Recomputed from the requirement — one of the three model-answerable verdicts, a reason of 1 to 300
 * characters — rather than from `relevanceResponseSchema`, so it cannot drift with the subject it
 * judges.
 */
const isUsableResponse = (candidate: unknown): boolean => {
  const verdict = propertyOf(candidate, 'verdict');
  const reason = propertyOf(candidate, 'reason');

  return (
    typeof verdict === 'string' &&
    PERMITTED_VERDICTS.includes(verdict) &&
    typeof reason === 'string' &&
    reason.length >= 1 &&
    reason.length <= RELEVANCE_REASON_MAX_LENGTH
  );
};

/**
 * Asserts the half of the property that holds for every input: either `null`, or exactly one
 * permitted verdict with a reason within the bound.
 *
 * Separate from the equivalence check because it applies to values whose acceptance the oracle
 * cannot predict — a `Date` or a boxed string carrying the two fields is still an object to a
 * validator — while this part has to hold for all of them.
 */
const expectVerdictOrNothing = (parsed: RelevanceResponse | null): void => {
  if (parsed === null) {
    return;
  }

  expect([...Object.keys(parsed)].sort()).toStrictEqual([...RESPONSE_KEYS]);
  expect(PERMITTED_VERDICTS).toContain(parsed.verdict);
  // `NOT_ASSESSED` is in `RELEVANCE_VERDICTS` but not answerable by a model: stated separately so a
  // parser that let it through fails on the reason 15.10 gives, not only on a list membership.
  expect(RELEVANCE_VERDICTS).toContain(parsed.verdict);
  expect(parsed.verdict).not.toBe('NOT_ASSESSED');
  expect(typeof parsed.reason).toBe('string');
  expect(parsed.reason.length).toBeGreaterThanOrEqual(1);
  expect(parsed.reason.length).toBeLessThanOrEqual(RELEVANCE_REASON_MAX_LENGTH);
};

/**
 * A `verdict` value: the three permitted ones, `NOT_ASSESSED`, near misses, arbitrary strings and
 * values that are not strings at all.
 */
const verdictArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: fc.constantFrom(...ASSESSED_RELEVANCE_VERDICTS), weight: 8 },
  { arbitrary: fc.constant('NOT_ASSESSED'), weight: 3 },
  {
    // The near misses: right word, wrong case; right value, trailing blank; a fourth verdict.
    arbitrary: fc.constantFrom('relevant', 'RELEVANT ', 'NOT RELEVANT', 'MAYBE', 'UNKNOWN', ''),
    weight: 3,
  },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 20 }), weight: 2 },
  { arbitrary: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.jsonValue()), weight: 2 },
);

/** A reason of exactly the permitted length, in two-byte characters, as a stored reason would be. */
const REASON_AT_LIMIT = 'ä'.repeat(RELEVANCE_REASON_MAX_LENGTH);

/**
 * A `reason` value: usable German text, the two sides of the 300-character bound, the empty and
 * whitespace-only cases, far-too-long text and values that are not strings.
 *
 * The boundary branch is drawn in printable ASCII so the generated length *is* the UTF-16 length the
 * bound counts, which is what puts values at 299, 300 and 301 characters.
 */
const reasonArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  {
    arbitrary: fc.constantFrom(
      'Fachgebiet und Arbeitsort passen zum Profil.',
      'Die Stelle ist eine Personalvermittlung statt einer Festanstellung.',
      'Die Anzeige nennt keine Fachrichtung.',
    ),
    weight: 6,
  },
  {
    arbitrary: fc.string({
      unit: 'grapheme-ascii',
      minLength: RELEVANCE_REASON_MAX_LENGTH - 1,
      maxLength: RELEVANCE_REASON_MAX_LENGTH + 1,
    }),
    weight: 4,
  },
  { arbitrary: fc.constantFrom(REASON_AT_LIMIT, `${REASON_AT_LIMIT}ä`), weight: 2 },
  { arbitrary: fc.constantFrom('', ' ', '\n\t '), weight: 2 },
  {
    arbitrary: fc.string({
      unit: 'binary',
      minLength: RELEVANCE_REASON_MAX_LENGTH + 1,
      maxLength: RELEVANCE_REASON_MAX_LENGTH + 40,
    }),
    weight: 2,
  },
  { arbitrary: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.jsonValue()), weight: 2 },
);

/** A reason the bound permits: German prose, printable text within 300 characters, or exactly 300. */
const usableReasonArbitrary: fc.Arbitrary<string> = fc.oneof(
  {
    arbitrary: fc.constantFrom(
      'Fachgebiet und Arbeitsort passen zum Profil.',
      'Die Stelle ist eine Personalvermittlung statt einer Festanstellung.',
      'Die Anzeige nennt keine Fachrichtung.',
    ),
    weight: 4,
  },
  {
    arbitrary: fc.string({
      unit: 'grapheme-ascii',
      minLength: 1,
      maxLength: RELEVANCE_REASON_MAX_LENGTH,
    }),
    weight: 3,
  },
  { arbitrary: fc.constant(REASON_AT_LIMIT), weight: 1 },
);

/**
 * A reason sitting on the 300-character bound: 299, 300 and 301 characters.
 *
 * Its own branch because the bound is where the stored Relevance_Reason stops fitting its column,
 * and because it is the one distinction a mixture reaches too rarely to be relied on: the 301-unit
 * values have to be drawn together with a present, permitted verdict to say anything at all.
 */
const boundaryReasonArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string({
    unit: 'grapheme-ascii',
    minLength: RELEVANCE_REASON_MAX_LENGTH - 1,
    maxLength: RELEVANCE_REASON_MAX_LENGTH + 1,
  }),
  fc.constantFrom(REASON_AT_LIMIT, `${REASON_AT_LIMIT}ä`),
);

/** Properties a model added on its own. Never the two it was asked for, which the record supplies. */
const extraPropertiesArbitrary: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc
    .string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 12 })
    .filter((key) => !['verdict', 'reason', '__proto__'].includes(key)),
  fc.jsonValue(),
  { maxKeys: 3 },
);

/** Adds the properties a model may have invented beside the two it was asked for. */
const withExtras = (
  fields: fc.Arbitrary<Record<string, unknown>>,
): fc.Arbitrary<Record<string, unknown>> =>
  fc.tuple(fields, extraPropertiesArbitrary).map(([own, extras]) => ({ ...extras, ...own }));

/**
 * A tool input as the `report_relevance` call would carry it: either field may be missing, either
 * may be of the wrong type, and unasked-for properties may sit beside them.
 *
 * The well-formed branch and the boundary branch are drawn separately and weighted rather than left
 * to the mixture, where a dropped field or a rejected verdict would swallow them: the accepted case
 * and the 300-versus-301 distinction have to occur in every run, whatever the seed, or the
 * acceptance half of the equivalence would assert nothing.
 */
const toolInputArbitrary: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  {
    arbitrary: withExtras(
      fc.record({
        verdict: fc.constantFrom<string>(...ASSESSED_RELEVANCE_VERDICTS),
        reason: usableReasonArbitrary,
      }),
    ),
    weight: 8,
  },
  {
    arbitrary: withExtras(
      fc.record({
        verdict: fc.constantFrom<string>(...ASSESSED_RELEVANCE_VERDICTS),
        reason: boundaryReasonArbitrary,
      }),
    ),
    weight: 6,
  },
  {
    arbitrary: withExtras(
      fc.record({ verdict: verdictArbitrary, reason: reasonArbitrary }, { requiredKeys: [] }),
    ),
    weight: 10,
  },
);

/**
 * Everything the parser may be handed: structured tool inputs, arbitrary JSON, arbitrary strings and
 * arbitrary values — including `undefined`, which is what the caller passes when the answer carried
 * no tool-use block at all.
 */
const parserInputArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: toolInputArbitrary, weight: 10 },
  { arbitrary: fc.jsonValue(), weight: 3 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 40 }), weight: 2 },
  { arbitrary: fc.constantFrom(undefined, null, Number.NaN), weight: 2 },
  { arbitrary: fc.array(toolInputArbitrary, { maxLength: 2 }), weight: 2 },
  { arbitrary: fc.anything(), weight: 3 },
);

/** One content block of a generated Messages API answer. */
const contentBlockArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  {
    // The tool call the model was forced to make.
    arbitrary: fc.record({
      type: fc.constant(ANTHROPIC_TOOL_USE_BLOCK_TYPE),
      id: fc.constant('toolu_01'),
      name: fc.constant(ANTHROPIC_TOOL_NAME),
      // Weighted towards a structured tool input: the arbitrary values are already covered by the
      // first two properties of this file, and a body whose tool call never carries a usable input
      // would leave the "usable verdict" branch of this one unexercised.
      input: fc.oneof(
        { arbitrary: toolInputArbitrary, weight: 8 },
        { arbitrary: parserInputArbitrary, weight: 3 },
      ),
    }),
    weight: 8,
  },
  {
    // A tool call announcing another name, and a tool-use block without a name at all.
    arbitrary: fc.record(
      {
        type: fc.constant(ANTHROPIC_TOOL_USE_BLOCK_TYPE),
        name: fc.constantFrom('report_commute', 'web_search'),
        input: parserInputArbitrary,
      },
      { requiredKeys: ['type', 'input'] },
    ),
    weight: 3,
  },
  {
    // Prose, a refusal, a server-side block type the API added later.
    arbitrary: fc.record({
      type: fc.constantFrom('text', 'thinking', 'server_tool_use_v2'),
      text: fc.string({ unit: 'binary', maxLength: 30 }),
    }),
    weight: 4,
  },
  { arbitrary: fc.jsonValue(), weight: 2 },
);

/** A whole answer body, including bodies in which no tool call could be. */
const messageBodyArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  {
    arbitrary: fc.record(
      {
        id: fc.constant('msg_01'),
        model: fc.constantFrom('claude-sonnet-4-5-20250929', 'claude-haiku-4-5'),
        stop_reason: fc.constantFrom('tool_use', 'end_turn', 'max_tokens', null),
        content: fc.array(contentBlockArbitrary, { maxLength: 3 }),
      },
      { requiredKeys: ['content'] },
    ),
    weight: 10,
  },
  { arbitrary: fc.jsonValue(), weight: 2 },
  { arbitrary: fc.anything(), weight: 2 },
);

/** The input of the first `report_relevance` tool-use block of a generated body, computed directly. */
const expectedToolInputOf = (body: unknown): unknown => {
  const content = propertyOf(body, 'content');

  if (!Array.isArray(content)) {
    return undefined;
  }

  const block: unknown = content.find(
    (candidate: unknown) =>
      propertyOf(candidate, 'type') === ANTHROPIC_TOOL_USE_BLOCK_TYPE &&
      propertyOf(candidate, 'name') === ANTHROPIC_TOOL_NAME,
  );

  return propertyOf(block, 'input');
};

describe('Property 19: The relevance response parser is total', () => {
  /**
   * **Validates: Requirements 15.3, 15.12, 15.14**
   *
   * For all values an AI_Provider answer can put in the input of a `report_relevance` tool call —
   * well-formed inputs, verdicts outside the permitted value list, `NOT_ASSESSED`, reasons that are
   * empty or longer than 300 characters, missing fields, fields of the wrong type, arbitrary JSON,
   * arbitrary strings and arbitrary values — reading the response yields exactly one verdict from
   * the permitted value list together with a reason of 1 to 300 characters, or `null`; it never
   * throws, never yields a verdict outside the value list, and never yields `NOT_ASSESSED`.
   */
  it('yields a permitted verdict with a bounded reason, or nothing, for every value', () => {
    let usable = 0;
    let discarded = 0;

    fc.assert(
      fc.property(parserInputArbitrary, (toolInput) => {
        // Nothing is caught here: a thrown error fails the property, which is the totality half of
        // the statement and the reason this function exists instead of a bare `schema.parse`.
        const parsed = parseRelevanceResponse(toolInput);

        expectVerdictOrNothing(parsed);

        if (parsed === null) {
          discarded += 1;

          return;
        }

        usable += 1;

        // What came out is what went in, field for field: a parser that repaired a bad verdict or
        // shortened an over-long reason would store an assessment 15.12 asks to be discarded.
        expect(parsed.verdict).toBe(propertyOf(toolInput, 'verdict'));
        expect(parsed.reason).toBe(propertyOf(toolInput, 'reason'));
      }),
      PROPERTY_RUNS,
    );

    // Both outcomes have to occur, otherwise the property would pass on a generator that never
    // reaches one of them.
    expect(usable).toBeGreaterThan(0);
    expect(discarded).toBeGreaterThan(0);
  });

  /**
   * **Validates: Requirements 15.3, 15.12**
   *
   * For all tool inputs, the response is usable exactly when the verdict is one of the three
   * model-answerable verdicts and the reason is a string of 1 to 300 characters; properties the
   * model added on its own are stripped rather than counted as a deviation from the expected format.
   */
  it('accepts exactly the tool inputs the verdict list and the reason bound permit', () => {
    let accepted = 0;
    let rejected = 0;
    let strippedExtras = 0;

    fc.assert(
      fc.property(toolInputArbitrary, (toolInput) => {
        const parsed = parseRelevanceResponse(toolInput);
        const expected = isUsableResponse(toolInput);

        expect(parsed !== null).toBe(expected);

        if (!expected) {
          rejected += 1;

          return;
        }

        accepted += 1;

        if (Object.keys(toolInput).length > RESPONSE_KEYS.length) {
          strippedExtras += 1;
        }

        expect(parsed).toStrictEqual({
          verdict: toolInput.verdict,
          reason: toolInput.reason,
        });
      }),
      PROPERTY_RUNS,
    );

    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(strippedExtras).toBeGreaterThan(0);
  });

  /**
   * **Validates: Requirements 15.12, 15.14**
   *
   * For all Messages API answer bodies — including bodies with prose instead of a tool call, with a
   * tool call under a different name, with an unknown block type, with a `content` that is not an
   * array and with arbitrary values in place of the body — the envelope gate followed by the
   * response parser yields a usable verdict exactly when the first `report_relevance` tool-use block
   * carries an input the two bounds permit, and `null` in every other case, without throwing.
   */
  it('yields nothing for an answer that carried no usable report_relevance tool call', () => {
    let withUsableCall = 0;
    let withoutUsableCall = 0;
    let withoutAnyCall = 0;

    fc.assert(
      fc.property(messageBodyArbitrary, (body) => {
        const envelope = anthropicMessageResponseSchema.safeParse(body);
        const parsed = envelope.success
          ? parseRelevanceResponse(reportRelevanceToolInput(envelope.data))
          : null;

        expectVerdictOrNothing(parsed);

        const expectedInput = expectedToolInputOf(body);

        if (expectedInput === undefined) {
          withoutAnyCall += 1;
        }

        if (envelope.success && isUsableResponse(expectedInput)) {
          withUsableCall += 1;

          expect(parsed).toStrictEqual({
            verdict: propertyOf(expectedInput, 'verdict'),
            reason: propertyOf(expectedInput, 'reason'),
          });

          return;
        }

        withoutUsableCall += 1;

        expect(parsed).toBe(null);
      }),
      PROPERTY_RUNS,
    );

    expect(withUsableCall).toBeGreaterThan(0);
    expect(withoutUsableCall).toBeGreaterThan(0);
    expect(withoutAnyCall).toBeGreaterThan(0);
  });
});
