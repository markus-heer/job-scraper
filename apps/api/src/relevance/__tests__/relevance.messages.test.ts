/**
 * The German end-of-run text of the Relevance_Service (15.16, 16.8).
 *
 * The subject is the wording of the assessment counters: all three numbers 15.16 names, in German,
 * with the "not relevant" count written as a part of the assessed ones.
 *
 * Requirements: 15.16, 16.8.
 */

import { describe, expect, it } from 'vitest';

import { RELEVANCE_COUNTERS_LOG_CODE, relevanceCountersMessageDe } from '../relevance.messages';

describe('relevanceCountersMessageDe', () => {
  it('names the assessed, "not relevant" and "not assessed" counts (15.16)', () => {
    expect(relevanceCountersMessageDe({ assessed: 42, notRelevant: 17, notAssessed: 5 })).toBe(
      'KI-Bewertung: 42 Treffer bewertet, davon 17 nicht relevant. 5 Treffer nicht bewertet.',
    );
  });

  it('keeps every zero, so a tally cannot be mistaken for a missing number', () => {
    expect(relevanceCountersMessageDe({ assessed: 0, notRelevant: 0, notAssessed: 0 })).toBe(
      'KI-Bewertung: 0 Treffer bewertet, davon 0 nicht relevant. 0 Treffer nicht bewertet.',
    );
  });

  it('carries a stable English log code next to the German text (16.8)', () => {
    expect(RELEVANCE_COUNTERS_LOG_CODE).toBe('relevance.counters');
  });
});
