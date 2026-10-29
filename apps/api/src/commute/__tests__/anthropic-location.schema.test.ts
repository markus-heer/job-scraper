/**
 * The wire contract of the work location normalization: the tool the model sees, and the gate every
 * answer passes (8.6, 8.7).
 *
 * The one property worth stating plainly is totality: `parseLocationResponse` reads *any* value and
 * answers a place name, the explicit "no place", or `null`. That matters more here than on the
 * relevance side, because only two of those three may be recorded — a `null` that leaked through as
 * `NO_PLACE` would permanently close a work location that 8.7 gives exactly one chance.
 *
 * Requirements: 8.6, 8.7.
 */

import { describe, expect, it } from 'vitest';

import {
  LOCATION_OUTCOME_KINDS,
  LOCATION_PLACE_NAME_MAX_LENGTH,
  LOCATION_TOOL_DEFINITION,
  LOCATION_TOOL_NAME,
  parseLocationResponse,
  reportWorkLocationToolInput,
} from '../anthropic-location.schema';

describe('LOCATION_TOOL_DEFINITION', () => {
  it('derives its enum and its length bound from the constants the parser uses', () => {
    const properties = LOCATION_TOOL_DEFINITION.input_schema.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(LOCATION_TOOL_DEFINITION.name).toBe(LOCATION_TOOL_NAME);
    expect(properties.outcome?.enum).toStrictEqual([...LOCATION_OUTCOME_KINDS]);
    expect(properties.placeName?.maxLength).toBe(LOCATION_PLACE_NAME_MAX_LENGTH);
    // `placeName` is required only for `PLACE`, which JSON Schema cannot express; the parser's
    // cross-field check is what closes that gap.
    expect(LOCATION_TOOL_DEFINITION.input_schema.required).toStrictEqual(['outcome']);
    expect(LOCATION_TOOL_DEFINITION.input_schema.additionalProperties).toBe(false);
  });
});

describe('parseLocationResponse', () => {
  it('accepts a PLACE with a name and reports the trimmed name', () => {
    expect(parseLocationResponse({ outcome: 'PLACE', placeName: ' München ' })).toStrictEqual({
      outcome: 'PLACE',
      placeName: 'München',
    });
  });

  it('accepts a NO_PLACE and drops anything else the model added', () => {
    expect(
      parseLocationResponse({ outcome: 'NO_PLACE', confidence: 0.9, placeName: 'München' }),
    ).toStrictEqual({ outcome: 'NO_PLACE' });
  });

  it('rejects a PLACE whose name is missing or blank, rather than calling it NO_PLACE', () => {
    expect(parseLocationResponse({ outcome: 'PLACE' })).toBeNull();
    expect(parseLocationResponse({ outcome: 'PLACE', placeName: '  ' })).toBeNull();
  });

  it('rejects a name longer than the bound the store and the geocoder share', () => {
    expect(
      parseLocationResponse({
        outcome: 'PLACE',
        placeName: 'M'.repeat(LOCATION_PLACE_NAME_MAX_LENGTH + 1),
      }),
    ).toBeNull();
  });

  it('answers null for every shape that is not an answer, without throwing', () => {
    const unusable: readonly unknown[] = [
      undefined,
      null,
      'München',
      42,
      [],
      {},
      { outcome: 'MAYBE' },
      { outcome: 'place', placeName: 'München' },
      { placeName: 'München' },
      { outcome: ['PLACE'], placeName: 'München' },
    ];

    for (const input of unusable) {
      expect(parseLocationResponse(input)).toBeNull();
    }
  });
});

describe('reportWorkLocationToolInput', () => {
  it('finds the tool call by name and ignores a differently named one', () => {
    const input = { outcome: 'NO_PLACE' };

    expect(
      reportWorkLocationToolInput({
        content: [
          { type: 'text' },
          { type: 'tool_use', name: 'report_relevance', input: { verdict: 'RELEVANT' } },
          { type: 'tool_use', name: LOCATION_TOOL_NAME, input },
        ],
      }),
    ).toStrictEqual(input);
  });

  it('answers undefined when the model called no tool at all', () => {
    expect(reportWorkLocationToolInput({ content: [{ type: 'text' }] })).toBeUndefined();
  });
});
