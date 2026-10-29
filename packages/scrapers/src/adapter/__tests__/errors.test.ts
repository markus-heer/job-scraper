/**
 * The adapter error types and their mapping onto Platform_Status.
 *
 * The load-bearing behaviour is 13.1: whatever reaches the catch block of the Scraper_Service maps to
 * one of the 14 permitted Platform_Status values, so a failing Platform never ends a Scrape_Run. The
 * cases below cover the observations the requirements name plus the two "unrecognised error" paths —
 * an exhausted attempt series (13.8) and an unexpected fault.
 */

import { PLATFORM_STATUSES } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { RequestAttemptsExhaustedError } from '../../scheduling/platform-queue.js';
import {
  AdapterError,
  FetchRateLimitedError,
  isAdapterError,
  PageLayoutUnknownError,
  PlatformBlockedError,
  platformStatusForError,
  PlatformUnreachableError,
  SignInRequiredError,
} from '../errors.js';

describe('adapter errors', () => {
  describe('the observations the requirements name', () => {
    it.each([
      { Error: SignInRequiredError, status: 'SIGN_IN_REQUIRED', code: 'platform.signInRequired' },
      { Error: PlatformBlockedError, status: 'PLATFORM_BLOCKED', code: 'platform.blocked' },
      {
        Error: PageLayoutUnknownError,
        status: 'PAGE_LAYOUT_UNKNOWN',
        code: 'platform.layoutUnknown',
      },
      { Error: FetchRateLimitedError, status: 'FETCH_RATE_LIMITED', code: 'platform.rateLimited' },
      {
        Error: PlatformUnreachableError,
        status: 'PLATFORM_UNREACHABLE',
        code: 'platform.unreachable',
      },
    ])('$status carries its Platform_Status and its log key', ({ Error: Kind, status, code }) => {
      const error = new Kind('STEPSTONE', { pageNumber: 3, sourceUrl: 'https://example.test/p3' });

      expect(error).toBeInstanceOf(AdapterError);
      expect(error).toBeInstanceOf(Error);
      expect(error.platform).toBe('STEPSTONE');
      expect(error.platformStatus).toBe(status);
      expect(PLATFORM_STATUSES).toContain(error.platformStatus);
      expect(error.code).toBe(code);
      expect(error.pageNumber).toBe(3);
      expect(error.sourceUrl).toBe('https://example.test/p3');
      // The technical message names the Platform and the page; the German text is mapped elsewhere.
      expect(error.message).toContain('STEPSTONE');
      expect(error.message).toContain('3');
    });

    it('omits the page from the message where the adapter knows none', () => {
      const error = new PlatformUnreachableError('JOBVECTOR');

      expect(error.pageNumber).toBeUndefined();
      expect(error.sourceUrl).toBeUndefined();
      expect(error.message).toBe('Platform JOBVECTOR was unreachable.');
    });

    it('keeps the underlying fault as the cause', () => {
      const transport = new Error('socket hang up');
      const error = new PlatformUnreachableError('INDEED', { cause: transport });

      expect(error.cause).toBe(transport);
    });
  });

  describe('platformStatusForError', () => {
    it('answers the status an adapter error carries', () => {
      expect(platformStatusForError(new SignInRequiredError('GLASSDOOR'))).toBe('SIGN_IN_REQUIRED');
    });

    it('answers FAILED for an exhausted attempt series (13.8)', () => {
      const exhausted = new RequestAttemptsExhaustedError('STEPSTONE', 3);

      expect(isAdapterError(exhausted)).toBe(false);
      expect(platformStatusForError(exhausted)).toBe('FAILED');
    });

    it.each([
      ['an unexpected fault', new TypeError('selector is not a function')],
      ['a thrown non-error', 'boom'],
      ['nothing at all', undefined],
    ])('answers FAILED for %s (13.1)', (_case, thrown) => {
      expect(platformStatusForError(thrown)).toBe('FAILED');
    });
  });

  it('reports a further permitted Platform_Status without a class of its own', () => {
    const error = new AdapterError({
      platform: 'STEPSTONE',
      platformStatus: 'CANCELLED_BY_TIME_LIMIT',
      code: 'run.timeLimitReached',
      message: 'The retrieval of Platform STEPSTONE was ended by the runtime limit.',
      pageNumber: 2,
    });

    expect(platformStatusForError(error)).toBe('CANCELLED_BY_TIME_LIMIT');
    expect(error.name).toBe('AdapterError');
  });
});
