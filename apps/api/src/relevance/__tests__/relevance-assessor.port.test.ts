/**
 * What the Relevance_Assessor contract promises its callers.
 *
 * Three of its parts are decisions the Relevance_Service depends on and that no implementation may
 * re-decide:
 *
 * - reading any response yields exactly one permitted verdict with a reason of at most 300
 *   characters, or nothing at all — never an exception (15.12, 15.14). The boundary is asserted at
 *   300 and at 301 characters, because that is where a stored Relevance_Reason would stop fitting
 *   its column.
 * - `NOT_ASSESSED` is not a verdict a model may answer with: it is the Job_Tool's record of a
 *   missing answer, and a response carrying it is as unusable as a misspelled one.
 * - a description is transmitted at no more than 4,000 characters, and a Job_Posting without one
 *   still produces a value (15.2, 6.8).
 *
 * Requirements: 15.2, 15.3, 15.12, 15.14.
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  ASSESSED_RELEVANCE_VERDICTS,
  parseRelevanceResponse,
  RELEVANCE_DESCRIPTION_MAX_LENGTH,
  RELEVANCE_MAX_ATTEMPTS,
  RELEVANCE_REASON_MAX_LENGTH,
  RELEVANCE_REQUEST_TIMEOUT_MS,
  RELEVANCE_RETRY_BACKOFF_MS,
  type RelevanceAssessor,
  type RelevanceRequest,
  truncateDescription,
} from '../relevance-assessor.port';

const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [
    { field: 'jobTitle', value: 'Pflegefachkraft', provenance: 'DEFAULT' },
    { field: 'searchLocation', value: 'München', provenance: 'OVERRIDE' },
  ],
};

describe('parseRelevanceResponse', () => {
  it('returns the verdict and the reason of a usable tool input', () => {
    expect(
      parseRelevanceResponse({
        verdict: 'NOT_RELEVANT',
        reason: 'Die Stelle ist eine Personalvermittlung statt einer Festanstellung.',
      }),
    ).toEqual({
      verdict: 'NOT_RELEVANT',
      reason: 'Die Stelle ist eine Personalvermittlung statt einer Festanstellung.',
    });
  });

  it('ignores a property the model added on its own', () => {
    expect(
      parseRelevanceResponse({ verdict: 'RELEVANT', reason: 'Passt fachlich.', confidence: 0.9 }),
    ).toEqual({ verdict: 'RELEVANT', reason: 'Passt fachlich.' });
  });

  it('accepts a reason of exactly 300 characters and rejects one of 301', () => {
    const reason = 'ä'.repeat(RELEVANCE_REASON_MAX_LENGTH);

    expect(parseRelevanceResponse({ verdict: 'UNCERTAIN', reason })).toEqual({
      verdict: 'UNCERTAIN',
      reason,
    });
    expect(parseRelevanceResponse({ verdict: 'UNCERTAIN', reason: `${reason}ä` })).toBe(null);
  });

  it('rejects NOT_ASSESSED, which the Job_Tool records and no model may claim', () => {
    expect(parseRelevanceResponse({ verdict: 'NOT_ASSESSED', reason: 'Keine Antwort.' })).toBe(
      null,
    );
  });

  it('rejects a verdict outside the permitted value list and an empty reason', () => {
    expect(parseRelevanceResponse({ verdict: 'relevant', reason: 'Passt fachlich.' })).toBe(null);
    expect(parseRelevanceResponse({ verdict: 'MAYBE', reason: 'Passt fachlich.' })).toBe(null);
    expect(parseRelevanceResponse({ verdict: 'RELEVANT', reason: '' })).toBe(null);
  });

  it('rejects a missing field instead of filling it in', () => {
    expect(parseRelevanceResponse({ verdict: 'RELEVANT' })).toBe(null);
    expect(parseRelevanceResponse({ reason: 'Passt fachlich.' })).toBe(null);
  });

  it('answers null instead of throwing for anything that is not the expected object', () => {
    expect(parseRelevanceResponse(undefined)).toBe(null);
    expect(parseRelevanceResponse(null)).toBe(null);
    expect(parseRelevanceResponse('Die Stelle passt gut zum Profil.')).toBe(null);
    expect(parseRelevanceResponse([{ verdict: 'RELEVANT', reason: 'Passt.' }])).toBe(null);
  });
});

describe('truncateDescription', () => {
  it('passes a text within the bound through unchanged', () => {
    expect(truncateDescription('Wir suchen eine Fachkraft.')).toBe('Wir suchen eine Fachkraft.');
  });

  it('cuts a longer text to 4,000 characters without adding an ellipsis', () => {
    const truncated = truncateDescription('x'.repeat(RELEVANCE_DESCRIPTION_MAX_LENGTH + 500));

    expect(truncated).toHaveLength(RELEVANCE_DESCRIPTION_MAX_LENGTH);
    expect(truncated.endsWith('x')).toBe(true);
  });

  it('yields the empty string for a Job_Posting without a description', () => {
    expect(truncateDescription(null)).toBe('');
    expect(truncateDescription(undefined)).toBe('');
  });
});

describe('request bounds', () => {
  it('states the 30-second timeout, the three attempts and the increasing intervals of 15.11', () => {
    expect(RELEVANCE_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(RELEVANCE_MAX_ATTEMPTS).toBe(3);
    expect(RELEVANCE_RETRY_BACKOFF_MS).toEqual([1_000, 4_000]);
    expect(RELEVANCE_RETRY_BACKOFF_MS).toHaveLength(RELEVANCE_MAX_ATTEMPTS - 1);
  });

  it('offers the three model-answerable verdicts without NOT_ASSESSED', () => {
    expect(ASSESSED_RELEVANCE_VERDICTS).toEqual(['RELEVANT', 'NOT_RELEVANT', 'UNCERTAIN']);
  });
});

describe('RelevanceAssessor', () => {
  /** A request for a Job_Posting whose optional fields the Platform did not supply (6.8). */
  const request: RelevanceRequest = {
    title: 'Pflegefachkraft (m/w/d)',
    employer: null,
    workLocation: null,
    publishedAt: null,
    descriptionText: truncateDescription(null),
    profile: PROFILE,
  };

  it('is implementable with a verdict for an answered request', async () => {
    const assessor: RelevanceAssessor = {
      model: 'claude-sonnet-4-5',
      assess: (_request, _signal) =>
        Promise.resolve({
          kind: 'ASSESSED',
          response: { verdict: 'RELEVANT', reason: 'Fachgebiet und Arbeitsort passen.' },
          model: 'claude-sonnet-4-5-20250929',
        }),
    };

    await expect(assessor.assess(request, AbortSignal.abort())).resolves.toEqual({
      kind: 'ASSESSED',
      response: { verdict: 'RELEVANT', reason: 'Fachgebiet und Arbeitsort passen.' },
      model: 'claude-sonnet-4-5-20250929',
    });
  });

  it('reports an aborted request as a failure rather than rejecting', async () => {
    const assessor: RelevanceAssessor = {
      model: 'claude-sonnet-4-5',
      assess: (_request, signal) =>
        Promise.resolve(
          signal.aborted
            ? { kind: 'FAILED', code: 'TIMEOUT' }
            : { kind: 'FAILED', code: 'TRANSPORT' },
        ),
    };

    await expect(assessor.assess(request, AbortSignal.abort())).resolves.toEqual({
      kind: 'FAILED',
      code: 'TIMEOUT',
    });
  });
});
