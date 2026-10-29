/**
 * One assessment as the `JobPosting` row holds it (15.1, 15.5, 15.11, 15.12, 10.7).
 *
 * Two rules are what this file is about: the denormalized rank always matches the verdict, so the
 * sorting of 10.7 cannot drift from the stored value, and `relevanceContentHash` is set by an
 * assessment that happened and by nothing else, so a failed one is requested again in the next
 * Scrape_Run.
 *
 * Requirements: 10.7, 15.1, 15.5, 15.11, 15.12.
 */

import { RELEVANCE_RANK } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { persistedRelevanceResultOf } from '../persisted-relevance';
import type { RelevanceNotAssessedCause } from '../relevance.service';
import type { AssessedRelevanceVerdict } from '../relevance-assessor.port';

const CONTENT_HASH = 'hash-1';
const ASSESSED_AT = new Date('2026-03-02T08:05:00.000Z');

const VERDICTS: readonly AssessedRelevanceVerdict[] = ['RELEVANT', 'NOT_RELEVANT', 'UNCERTAIN'];

describe('persistedRelevanceResultOf, an assessment that happened', () => {
  it.each(VERDICTS)('stores %s with the rank the sort order of 10.7 needs', (verdict) => {
    const stored = persistedRelevanceResultOf(
      {
        kind: 'ASSESSED',
        verdict,
        reasonDe: 'Der Arbeitsort liegt außerhalb des Suchgebiets.',
        model: 'claude-sonnet-4-5-20250929',
        assessedAt: ASSESSED_AT,
        attempts: 1,
      },
      CONTENT_HASH,
    );

    expect(stored.relevanceVerdict).toBe(verdict);
    expect(stored.relevanceRank).toBe(RELEVANCE_RANK[verdict]);
    expect(stored.relevanceModel).toBe('claude-sonnet-4-5-20250929');
    expect(stored.relevanceAssessedAt).toStrictEqual(ASSESSED_AT);
    // The content the verdict is about, which the gate of the next Scrape_Run reads (15.5).
    expect(stored.relevanceContentHash).toBe(CONTENT_HASH);
  });
});

describe('persistedRelevanceResultOf, an assessment that did not happen', () => {
  const causes: readonly RelevanceNotAssessedCause[] = [
    'REQUEST_FAILED',
    'SCHEMA_VIOLATION',
    'BUDGET_REACHED',
    'DISABLED',
  ];

  it.each(causes)('stores "not assessed" without a content hash after %s', (cause) => {
    const stored = persistedRelevanceResultOf(
      { kind: 'NOT_ASSESSED', cause, reasonDe: null, failureCode: null, attempts: 0 },
      CONTENT_HASH,
    );

    expect(stored.relevanceVerdict).toBe('NOT_ASSESSED');
    expect(stored.relevanceRank).toBe(RELEVANCE_RANK.NOT_ASSESSED);
    expect(stored.relevanceModel).toBeNull();
    expect(stored.relevanceAssessedAt).toBeNull();
    // Anything else would close the gate on a Job_Posting that was never assessed, and the next
    // Scrape_Run would never ask again (15.5, 15.11, 15.12).
    expect(stored.relevanceContentHash).toBeNull();
  });

  it('carries the German note of the cause through to the Relevance_Reason (15.11)', () => {
    const stored = persistedRelevanceResultOf(
      {
        kind: 'NOT_ASSESSED',
        cause: 'REQUEST_FAILED',
        reasonDe: 'Die KI-Bewertung eines Treffers ist fehlgeschlagen.',
        failureCode: 'TIMEOUT',
        attempts: 3,
      },
      CONTENT_HASH,
    );

    expect(stored.relevanceReason).toBe('Die KI-Bewertung eines Treffers ist fehlgeschlagen.');
  });
});
