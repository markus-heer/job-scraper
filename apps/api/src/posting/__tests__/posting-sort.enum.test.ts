/**
 * The published sort keys of 10.7 against the ones the repository can sort by.
 *
 * The `satisfies` clause on the tuple catches one direction — a key published that the read contract
 * does not know — and no type can catch the other: a key the repository sorts by and the schema
 * omits would silently be unreachable for the Web_App. That is what this suite asserts, by naming
 * the four keys of 10.7 once more and comparing the sets.
 *
 * Requirements: 10.7.
 */

import { describe, expect, it } from 'vitest';

import { POSTING_SORT_FIELDS, SORT_DIRECTIONS } from '../models/posting-sort.enum';
import { DEFAULT_POSTING_SORT, type PostingSortField } from '../posting-page-query';

/** The four sort keys 10.7 names: recording time, publication date, commute time, verdict. */
const EVERY_SORT_FIELD: readonly PostingSortField[] = [
  'FIRST_SEEN_AT',
  'PUBLISHED_AT',
  'BEST_COMMUTE_MINUTES',
  'RELEVANCE',
];

describe('the published sort keys (10.7)', () => {
  it('are exactly the keys the read contract knows', () => {
    expect([...POSTING_SORT_FIELDS].sort()).toEqual([...EVERY_SORT_FIELD].sort());
  });

  it('offer both directions', () => {
    expect([...SORT_DIRECTIONS].sort()).toEqual(['ASC', 'DESC']);
  });

  it('contain the default sorting the overview is opened with', () => {
    expect(POSTING_SORT_FIELDS).toContain(DEFAULT_POSTING_SORT.field);
    expect(SORT_DIRECTIONS).toContain(DEFAULT_POSTING_SORT.direction);
  });
});
