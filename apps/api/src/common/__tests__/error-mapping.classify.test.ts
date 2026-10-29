/**
 * Unit tests for the classification half of the central error mapping (12.5, 13.1).
 *
 * 13.1 is the rule under test: whatever a Platform_Adapter ends a retrieval with, the
 * Scraper_Service has to close that Platform with one of the 14 permitted Platform_Status values and
 * go on with the remaining Platform. The mapping is therefore held to being *total over `unknown`* —
 * not over a tidy union of error classes — because a catch block receives whatever was thrown: an
 * adapter error, a queue error, an abort reason, a string, or something nobody anticipated.
 *
 * The real error classes of `@job-scraper/scrapers` are used rather than stand-ins, so the
 * structural detection is proven against the objects it will actually meet. The hand-built plain
 * objects next to them are not a convenience: they are the dual-package case. The adapters ship as
 * ESM and the API_Service compiles to CommonJS, so an error can reach this mapping as an instance of
 * a class that was loaded twice — which is exactly when `instanceof` answers `false` — and the
 * classification has to survive it.
 */

import { PLATFORM_STATUSES } from '@job-scraper/domain';
import {
  FetchRateLimitedError,
  PageLayoutUnknownError,
  PlatformBlockedError,
  PlatformQueueClosedError,
  PlatformUnreachableError,
  RequestAttemptsExhaustedError,
  RetryableRequestError,
  SignInRequiredError,
} from '@job-scraper/scrapers';
import { describe, expect, it } from 'vitest';

import {
  classifyPlatformError,
  mapFailure,
  mapPlatformError,
  type PlatformErrorContext,
} from '../error-mapping';

const context: PlatformErrorContext = { platform: 'STEPSTONE', pageNumber: 3 };

describe('classifyPlatformError with the real adapter errors', () => {
  it('reports the sign-in prompt of 7.2 with its Platform_Status and source URL', () => {
    const error = new SignInRequiredError('STEPSTONE', {
      pageNumber: 2,
      sourceUrl: 'https://www.stepstone.de/jobs?page=2',
    });
    const failure = classifyPlatformError(error, context);

    expect(failure).toEqual({
      kind: 'platform.signInRequired',
      platform: 'STEPSTONE',
      sourceUrl: 'https://www.stepstone.de/jobs?page=2',
    });
    expect(mapFailure(failure).platformStatus).toBe('SIGN_IN_REQUIRED');
  });

  it.each([
    [new PlatformBlockedError('JOBVECTOR'), 'platform.blocked', 'PLATFORM_BLOCKED'],
    [new PageLayoutUnknownError('STEPSTONE'), 'platform.layoutUnknown', 'PAGE_LAYOUT_UNKNOWN'],
    [new FetchRateLimitedError('GLASSDOOR'), 'platform.rateLimited', 'FETCH_RATE_LIMITED'],
    [new PlatformUnreachableError('INDEED'), 'platform.unreachable', 'PLATFORM_UNREACHABLE'],
  ])('maps %s onto the row of its Platform_Status', (error, expectedKind, expectedStatus) => {
    const failure = classifyPlatformError(error, context);

    expect(failure.kind).toBe(expectedKind);
    expect(mapFailure(failure).platformStatus).toBe(expectedStatus);
  });

  it('keeps the page number the error carries over the one the caller guessed', () => {
    const error = new PageLayoutUnknownError('STEPSTONE', { pageNumber: 7 });
    const failure = classifyPlatformError(error, { platform: 'STEPSTONE', pageNumber: 1 });

    expect(failure).toMatchObject({ pageNumber: 7 });
  });

  it('falls back to the caller page number when the adapter knew none', () => {
    const failure = classifyPlatformError(new PageLayoutUnknownError('STEPSTONE'), context);

    expect(failure).toMatchObject({ pageNumber: 3 });
  });
});

describe('classifyPlatformError with the queue errors', () => {
  it('reports exhausted attempts as the "failed" row of 13.8', () => {
    const failure = classifyPlatformError(
      new RequestAttemptsExhaustedError('STEPSTONE', 3),
      context,
    );
    const mapping = mapFailure(failure);

    expect(failure).toEqual({ kind: 'page.failed', platform: 'STEPSTONE', pageNumber: 3 });
    expect(mapping.platformStatus).toBe('FAILED');
    expect(mapping.userMessageDe).toContain('Seite 3');
  });

  it('classifies a closed queue by the error that closed it, not by the closure', () => {
    // 13.5 and 7.8: once a Platform reported a sign-in prompt or a rate limit, its queue stops
    // sending and every later request rejects with a closure. Reporting that closure as "failed"
    // would overwrite the status the Platform actually ended with.
    const closed = new PlatformQueueClosedError('STEPSTONE', {
      cause: new SignInRequiredError('STEPSTONE', { pageNumber: 2 }),
    });

    expect(classifyPlatformError(closed, context).kind).toBe('platform.signInRequired');
    expect(mapPlatformError(closed, context).platformStatus).toBe('SIGN_IN_REQUIRED');
  });

  it('follows a chain of wrapped causes to the error that carries a Platform_Status', () => {
    const closed = new PlatformQueueClosedError('STEPSTONE', {
      cause: new PlatformQueueClosedError('STEPSTONE', {
        cause: new FetchRateLimitedError('STEPSTONE', { pageNumber: 4 }),
      }),
    });

    expect(mapPlatformError(closed, context).platformStatus).toBe('FETCH_RATE_LIMITED');
  });

  it('reports a closed queue whose cause names no status as "failed"', () => {
    const exhausted = new PlatformQueueClosedError('STEPSTONE', {
      cause: new RequestAttemptsExhaustedError('STEPSTONE', 3),
    });

    expect(mapPlatformError(exhausted, context).platformStatus).toBe('FAILED');
    expect(
      mapPlatformError(new PlatformQueueClosedError('STEPSTONE'), context).platformStatus,
    ).toBe('FAILED');
  });

  it('reports a retryable error that reached the caller as "failed"', () => {
    // The retry progress line belongs to the attempt loop; by the time a retryable error leaves the
    // queue, the attempts are over.
    const failure = classifyPlatformError(new RetryableRequestError('timeout'), context);

    expect(failure.kind).toBe('page.failed');
  });
});

describe('classifyPlatformError with a cancellation', () => {
  const abort = new Error('The wait before the next page request was aborted.');

  it('reports a cancellation by the user as its run row (12.7)', () => {
    const failure = classifyPlatformError(abort, {
      ...context,
      cancellation: { kind: 'BY_USER' },
    });
    const mapping = mapFailure(failure);

    expect(failure).toEqual({ kind: 'run.cancelledByUser' });
    expect(mapping.runOutcome).toBe('CANCELLED_BY_USER');
    // An unfinished Platform keeps its last reported status or NOT_YET_RUN, so this row names none.
    expect(mapping.platformStatus).toBeUndefined();
  });

  it('reports the retrieval deadline as its run row with the limit it was given (13.6)', () => {
    const mapping = mapPlatformError(abort, {
      ...context,
      cancellation: { kind: 'BY_TIME_LIMIT', limitMinutes: 30 },
    });

    expect(mapping.platformStatus).toBe('CANCELLED_BY_TIME_LIMIT');
    expect(mapping.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');
    expect(mapping.userMessageDe).toContain('Zeitlimit von 30 Minuten erreicht.');
  });

  it('lets an adapter error win over the cancellation it raced', () => {
    // The adapter observed something specific; the cancellation only says the run is ending.
    const mapping = mapPlatformError(new PlatformBlockedError('STEPSTONE'), {
      ...context,
      cancellation: { kind: 'BY_USER' },
    });

    expect(mapping.platformStatus).toBe('PLATFORM_BLOCKED');
  });
});

describe('classifyPlatformError across the module boundary', () => {
  it('recognises an adapter error that lost its class identity', () => {
    // What an ESM/CommonJS double load leaves behind: the fields are intact, `instanceof` is not.
    const crossRealm = {
      name: 'SignInRequiredError',
      message: 'Platform INDEED showed a sign-in prompt',
      platform: 'INDEED',
      platformStatus: 'SIGN_IN_REQUIRED',
      code: 'platform.signInRequired',
      sourceUrl: 'https://de.indeed.com/jobs',
    };

    expect(classifyPlatformError(crossRealm, { platform: 'INDEED' })).toEqual({
      kind: 'platform.signInRequired',
      platform: 'INDEED',
      sourceUrl: 'https://de.indeed.com/jobs',
    });
  });

  it('refuses a Platform_Status that is not one of the 14 permitted values', () => {
    const invented = {
      name: 'AdapterError',
      platform: 'INDEED',
      platformStatus: 'ALMOST_WORKED',
    };

    // An invented status must not travel; the fallback row of 13.1 takes over.
    expect(mapPlatformError(invented, { platform: 'INDEED' }).platformStatus).toBe('FAILED');
  });

  it('refuses an object that names a status but no platform', () => {
    expect(
      mapPlatformError({ platformStatus: 'SIGN_IN_REQUIRED' }, { platform: 'INDEED' })
        .platformStatus,
    ).toBe('FAILED');
  });

  it('answers for every Platform_Status an adapter error may carry', () => {
    for (const platformStatus of PLATFORM_STATUSES) {
      const mapping = mapPlatformError(
        { name: 'AdapterError', platform: 'STEPSTONE', platformStatus },
        context,
      );

      // Either the row of that status, or the "failed" row for the four values that describe no
      // failure — never an unclassified pass-through.
      expect(mapping.userMessageDe.length).toBeGreaterThan(0);

      if (mapping.platformStatus !== undefined) {
        expect(PLATFORM_STATUSES).toContain(mapping.platformStatus);
      }
    }
  });
});

describe('classifyPlatformError is total over unknown', () => {
  /** Values a catch block can really receive, including the ones no code throws on purpose. */
  const thrownValues: readonly unknown[] = [
    undefined,
    null,
    'boom',
    '',
    0,
    42,
    Number.NaN,
    true,
    false,
    Symbol('boom'),
    123n,
    {},
    [],
    new Error('plain'),
    new TypeError('wrong type'),
    new RangeError('out of range'),
    Object.assign(new Error('prisma'), { code: 'P1001' }),
    { message: 'looks like an error' },
    Object.create(null),
    new Date(),
    () => undefined,
  ];

  it.each(thrownValues.map((value, index) => [index, value] as const))(
    'classifies thrown value %i',
    (_index, value) => {
      const mapping = mapPlatformError(value, context);

      expect(mapping.logCode).toBe('page.failed');
      expect(mapping.platformStatus).toBe('FAILED');
      expect(mapping.logLevel).toBe('ERROR');
      expect(mapping.userMessageDe).toContain('Stepstone');
      expect(mapping.userMessageDe).not.toContain('undefined');
    },
  );

  it('terminates on a cause chain that points at itself', () => {
    // A wrapper naming itself is a programming mistake, and the error mapping is the component that
    // reports mistakes — it must not be the one that overflows the stack while doing so.
    const selfReferential: Record<string, unknown> = {
      name: 'PlatformQueueClosedError',
      platform: 'STEPSTONE',
    };

    selfReferential['cause'] = selfReferential;

    expect(mapPlatformError(selfReferential, context).platformStatus).toBe('FAILED');
  });

  it('terminates on two causes that point at each other', () => {
    const first: Record<string, unknown> = { name: 'PlatformQueueClosedError', platform: 'INDEED' };
    const second: Record<string, unknown> = {
      name: 'PlatformQueueClosedError',
      platform: 'INDEED',
    };

    first['cause'] = second;
    second['cause'] = first;

    expect(mapPlatformError(first, { platform: 'INDEED' }).platformStatus).toBe('FAILED');
  });

  it('ignores a page number that is not a usable page number', () => {
    const mapping = mapPlatformError(
      { name: 'AdapterError', platform: 'STEPSTONE', platformStatus: 'FAILED', pageNumber: -2 },
      { platform: 'STEPSTONE' },
    );

    expect(mapping.userMessageDe).not.toContain('-2');
    expect(mapping.userMessageDe).toContain('Stepstone hat nicht geantwortet.');
  });
});
