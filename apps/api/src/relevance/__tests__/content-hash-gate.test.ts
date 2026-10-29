/**
 * The condition that decides whether a Job_Posting costs an AI_Provider request (15.5, 15.6,
 * 15.15).
 *
 * Four named cases here; the generated ones are Property 21 (task 14.9).
 *
 * Requirements: 15.5, 15.6, 15.15.
 */

import { describe, expect, it } from 'vitest';

import { needsRelevanceAssessment } from '../content-hash-gate';

describe('needsRelevanceAssessment', () => {
  it('opens for a Job_Posting that was never assessed', () => {
    expect(
      needsRelevanceAssessment({
        relevanceSetManually: false,
        relevanceContentHash: null,
        contentHash: 'hash-1',
      }),
    ).toBe(true);
  });

  it('stays closed while the assessed content is unchanged (15.5)', () => {
    expect(
      needsRelevanceAssessment({
        relevanceSetManually: false,
        relevanceContentHash: 'hash-1',
        contentHash: 'hash-1',
      }),
    ).toBe(false);
  });

  it('opens once the title or the description text changed (15.6)', () => {
    expect(
      needsRelevanceAssessment({
        relevanceSetManually: false,
        relevanceContentHash: 'hash-1',
        contentHash: 'hash-2',
      }),
    ).toBe(true);
  });

  it('stays closed for a manually set Relevance_Verdict, whatever the content did (15.15)', () => {
    expect(
      needsRelevanceAssessment({
        relevanceSetManually: true,
        relevanceContentHash: null,
        contentHash: 'hash-2',
      }),
    ).toBe(false);
  });
});
