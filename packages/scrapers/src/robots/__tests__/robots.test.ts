/**
 * robots.txt retrieval and evaluation of Requirement 14: one request per Platform and Scrape_Run
 * (14.1), the forbidden path and the unavailable robots.txt mapped onto their Platform_Status (14.2,
 * 14.3) and the stated crawl delay reported for the PlatformQueue (14.4).
 *
 * The exhaustive FOR ALL version of the gating is Property 13 (task 8.8); these are the examples and
 * edge cases. Every retrieval goes through the injected fetch function, so no test touches a network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateRobots,
  ROBOTS_FETCH_TIMEOUT_MS,
  RobotsCache,
  type RobotsDecision,
  type RobotsFetch,
  robotsPlatformStatus,
  type RobotsResponse,
} from '../robots.js';

const ORIGIN = 'https://jobs.example.com';

/** A user agent in the shape 14.5 requires: tool name, private-use statement and a contact detail. */
const USER_AGENT = 'JobScraper/0.1 (privater Gebrauch; kontakt@example.com)';

/** One recorded robots.txt request. */
interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** A fetch stand-in that records its calls and answers from a fixture. */
interface FetchRecorder {
  readonly calls: RecordedRequest[];
  readonly fetch: RobotsFetch;
}

function textResponse(body: string, status: number): RobotsResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  };
}

/** Answers every request with `answer`, which may also be a rejection. */
function recordingFetch(answer: () => Promise<RobotsResponse>): FetchRecorder {
  const calls: RecordedRequest[] = [];

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, headers: init.headers });

      return answer();
    },
  };
}

/** Answers with a robots.txt body under the given HTTP status. */
function bodyFetch(body: string, status = 200): FetchRecorder {
  return recordingFetch(() => Promise.resolve(textResponse(body, status)));
}

/** Parks until the request is aborted and then rejects with the abort reason, as `fetch` does. */
function abortAwareFetch(): FetchRecorder {
  const calls: RecordedRequest[] = [];

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, headers: init.headers });

      return new Promise<RobotsResponse>((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            reject(init.signal.reason);
          },
          { once: true },
        );
      });
    },
  };
}

function evaluate(
  fetchRobots: RobotsFetch,
  intendedPaths: readonly string[],
  signal: AbortSignal = new AbortController().signal,
): Promise<RobotsDecision> {
  return evaluateRobots({
    origin: ORIGIN,
    intendedPaths,
    userAgent: USER_AGENT,
    signal,
    fetch: fetchRobots,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('evaluateRobots', () => {
  it('accepts the global fetch as its retrieval function', () => {
    const injected: RobotsFetch = fetch;

    expect(typeof injected).toBe('function');
  });

  it('requests /robots.txt of the origin with the unchanged user agent', async () => {
    const recorder = bodyFetch('User-agent: *\nAllow: /\n');

    await evaluate(recorder.fetch, ['/jobs']);

    expect(recorder.calls).toStrictEqual([
      {
        url: 'https://jobs.example.com/robots.txt',
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
      },
    ]);
  });

  it('permits the intended paths an unrestricted robots.txt allows', async () => {
    const recorder = bodyFetch('User-agent: *\nDisallow: /intern\n');

    const decision = await evaluate(recorder.fetch, ['/jobs', '/jobs?seite=2']);

    expect(decision).toStrictEqual({
      allowedPaths: ['/jobs', '/jobs?seite=2'],
      disallowedPaths: [],
      crawlDelaySeconds: null,
      status: 'EVALUATED',
    });
  });

  it('splits the intended paths into the allowed and the forbidden ones', async () => {
    const recorder = bodyFetch('User-agent: *\nDisallow: /intern\nDisallow: /suche\n');

    const decision = await evaluate(recorder.fetch, ['/jobs', '/suche?q=node', '/intern/liste']);

    expect(decision.allowedPaths).toStrictEqual(['/jobs']);
    expect(decision.disallowedPaths).toStrictEqual(['/suche?q=node', '/intern/liste']);
    expect(decision.status).toBe('EVALUATED');
  });

  it('reads the crawl delay of the group matching the sent user agent', async () => {
    const recorder = bodyFetch(
      'User-agent: *\nCrawl-delay: 1\n\nUser-agent: JobScraper\nCrawl-delay: 5\n',
    );

    const decision = await evaluate(recorder.fetch, ['/jobs']);

    expect(decision.crawlDelaySeconds).toBe(5);
  });

  it.each([403, 404, 410])('treats an absent robots.txt (%i) as unrestricted', async (status) => {
    const recorder = bodyFetch('', status);

    const decision = await evaluate(recorder.fetch, ['/jobs']);

    expect(decision.status).toBe('EVALUATED');
    expect(decision.allowedPaths).toStrictEqual(['/jobs']);
  });

  it.each([429, 500, 503])('reports UNAVAILABLE for the status %i', async (status) => {
    const recorder = bodyFetch('User-agent: *\nAllow: /\n', status);

    const decision = await evaluate(recorder.fetch, ['/jobs']);

    expect(decision).toStrictEqual({
      allowedPaths: [],
      disallowedPaths: [],
      crawlDelaySeconds: null,
      status: 'UNAVAILABLE',
    });
  });

  it('reports UNAVAILABLE when the request fails', async () => {
    const recorder = recordingFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')));

    const decision = await evaluate(recorder.fetch, ['/jobs']);

    expect(decision.status).toBe('UNAVAILABLE');
  });

  it('reports UNAVAILABLE when the robots.txt does not arrive within 10 seconds', async () => {
    vi.useFakeTimers();
    const recorder = abortAwareFetch();

    const pending = evaluate(recorder.fetch, ['/jobs']);

    await vi.advanceTimersByTimeAsync(ROBOTS_FETCH_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ status: 'UNAVAILABLE' });
  });

  it('reports UNAVAILABLE for an origin that forms no URL', async () => {
    const recorder = bodyFetch('User-agent: *\nAllow: /\n');

    const decision = await evaluateRobots({
      origin: 'not-an-origin',
      intendedPaths: ['/jobs'],
      userAgent: USER_AGENT,
      signal: new AbortController().signal,
      fetch: recorder.fetch,
    });

    expect(decision.status).toBe('UNAVAILABLE');
    expect(recorder.calls).toStrictEqual([]);
  });

  it('issues no request when the Scrape_Run is already cancelled', async () => {
    const recorder = bodyFetch('User-agent: *\nAllow: /\n');
    const controller = new AbortController();
    const reason = new Error('Scrape_Run cancelled by the user.');
    controller.abort(reason);

    await expect(evaluate(recorder.fetch, ['/jobs'], controller.signal)).rejects.toBe(reason);
    expect(recorder.calls).toStrictEqual([]);
  });

  it('rejects with the cancellation reason when the Scrape_Run is cancelled in flight', async () => {
    const recorder = abortAwareFetch();
    const controller = new AbortController();
    const reason = new Error('Scrape_Run cancelled by the time limit.');

    const pending = evaluate(recorder.fetch, ['/jobs'], controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

describe('RobotsCache', () => {
  it('fetches the robots.txt of a Platform once for every evaluation of that run', async () => {
    const recorder = bodyFetch('User-agent: *\nDisallow: /intern\n');
    const cache = new RobotsCache({ userAgent: USER_AGENT, fetch: recorder.fetch });
    const signal = new AbortController().signal;

    const [first, second, later] = await Promise.all([
      cache.evaluate({ platform: 'STEPSTONE', origin: ORIGIN, intendedPaths: ['/jobs'], signal }),
      cache.evaluate({ platform: 'STEPSTONE', origin: ORIGIN, intendedPaths: ['/jobs'], signal }),
      cache.evaluate({
        platform: 'STEPSTONE',
        origin: ORIGIN,
        intendedPaths: ['/intern/liste'],
        signal,
      }),
    ]);

    expect(recorder.calls).toHaveLength(1);
    expect(cache.requestedPlatforms).toStrictEqual(['STEPSTONE']);
    expect(first.allowedPaths).toStrictEqual(['/jobs']);
    expect(second.allowedPaths).toStrictEqual(['/jobs']);
    expect(later.disallowedPaths).toStrictEqual(['/intern/liste']);
  });

  it('fetches one robots.txt per Platform', async () => {
    const recorder = bodyFetch('User-agent: *\nAllow: /\n');
    const cache = new RobotsCache({ userAgent: USER_AGENT, fetch: recorder.fetch });
    const signal = new AbortController().signal;

    await cache.evaluate({ platform: 'INDEED', origin: ORIGIN, intendedPaths: ['/jobs'], signal });
    await cache.evaluate({
      platform: 'JOBVECTOR',
      origin: 'https://jobvector.example.com',
      intendedPaths: ['/jobs'],
      signal,
    });

    expect(recorder.calls).toHaveLength(2);
    expect(cache.requestedPlatforms).toStrictEqual(['INDEED', 'JOBVECTOR']);
  });

  it('caches no cancelled retrieval, so a later evaluation can retry', async () => {
    const recorder = abortAwareFetch();
    const controller = new AbortController();
    const cache = new RobotsCache({ userAgent: USER_AGENT, fetch: recorder.fetch });

    const pending = cache.evaluate({
      platform: 'GLASSDOOR',
      origin: ORIGIN,
      intendedPaths: ['/jobs'],
      signal: controller.signal,
    });
    controller.abort(new Error('Scrape_Run cancelled by the user.'));

    await expect(pending).rejects.toThrow('cancelled by the user');
    expect(cache.requestedPlatforms).toStrictEqual([]);
  });
});

describe('robotsPlatformStatus', () => {
  it('maps a forbidden intended path onto EXCLUDED_BY_ROBOTS_TXT', () => {
    const status = robotsPlatformStatus({
      allowedPaths: ['/jobs'],
      disallowedPaths: ['/intern'],
      crawlDelaySeconds: null,
      status: 'EVALUATED',
    });

    expect(status).toBe('EXCLUDED_BY_ROBOTS_TXT');
  });

  it('maps an unevaluable robots.txt onto ROBOTS_TXT_UNAVAILABLE', () => {
    const status = robotsPlatformStatus({
      allowedPaths: [],
      disallowedPaths: [],
      crawlDelaySeconds: null,
      status: 'UNAVAILABLE',
    });

    expect(status).toBe('ROBOTS_TXT_UNAVAILABLE');
  });

  it('reports no Platform_Status while every intended path is allowed', () => {
    const status = robotsPlatformStatus({
      allowedPaths: ['/jobs'],
      disallowedPaths: [],
      crawlDelaySeconds: 5,
      status: 'EVALUATED',
    });

    expect(status).toBeNull();
  });
});
