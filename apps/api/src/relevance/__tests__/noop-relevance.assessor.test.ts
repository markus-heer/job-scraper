/**
 * The assessor of a deactivated Relevance_Service: it answers, and it does nothing else (15.9,
 * 15.10).
 *
 * Three promises are worth a test, because the whole of 15.10 rests on them: the outcome is a
 * failure code rather than an exception, the code is the one the Relevance_Service maps to the
 * deactivated cause, and nothing about an AI_Provider is read or constructed — no key, no model, no
 * HTTP client. The last one is asserted through the model name, which is the only thing this class
 * exposes.
 *
 * That the Relevance_Service asks it nothing at all in a batch is asserted in
 * `./relevance.service.test.ts`; this file is about what one call answers.
 *
 * Requirements: 15.9, 15.10, 15.14, 14.9.
 */

import { describe, expect, it } from 'vitest';

import { NO_RELEVANCE_MODEL, NoopRelevanceAssessor } from '../noop-relevance.assessor';

describe('NoopRelevanceAssessor', () => {
  it('answers NO_API_KEY without a request', async () => {
    const assessor = new NoopRelevanceAssessor();

    await expect(assessor.assess()).resolves.toEqual({ kind: 'FAILED', code: 'NO_API_KEY' });
  });

  it('reports no model name, because no model is asked (14.9)', () => {
    expect(new NoopRelevanceAssessor().model).toBe(NO_RELEVANCE_MODEL);
    expect(NO_RELEVANCE_MODEL).toBe('');
  });

  it('answers the same way for every call, including an aborted Scrape_Run', async () => {
    const assessor = new NoopRelevanceAssessor();

    await expect(assessor.assess()).resolves.toMatchObject({ code: 'NO_API_KEY' });
    await expect(assessor.assess()).resolves.toMatchObject({ code: 'NO_API_KEY' });
  });
});
