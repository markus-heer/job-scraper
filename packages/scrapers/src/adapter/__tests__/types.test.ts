/**
 * The uniform adapter interface (6.6) and the Partial_Result derivation (7.7).
 *
 * The interface itself is types only, so the test that matters is whether a Platform_Adapter can be
 * written against it and driven entirely through its {@link AdapterContext}: no browser, no network, no
 * clock of its own. The fake adapter below is exactly that, with an {@link AdapterPage} over a frozen
 * HTML string standing in for the Playwright runtime of task 8.4.
 */

import { PLATFORM_CAPABILITIES, resolveSearchProfile } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  type AdapterContext,
  type AdapterLogEvent,
  type AdapterPage,
  type AdapterResult,
  buildAdapterResult,
  effectivePageBudget,
  type PlatformAdapter,
  type RawJobPosting,
  RESULT_PAGE_BUDGET,
  RESULT_PAGE_TIMEOUT_MS,
} from '../types.js';

const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/** The effective Search_Profile a Platform_Adapter receives, resolved as the Scraper_Service does. */
function stepstoneProfile(): AdapterContext['profile'] {
  const resolution = resolveSearchProfile(
    'STEPSTONE',
    { jobTitle: 'Projektmanagerin', searchLocation: 'München', searchRadiusKm: 30 },
    {},
  );

  if (!resolution.ok) {
    throw new Error('The test profile must resolve.');
  }

  return resolution.profile;
}

/** One Result_Page of a Platform as the fake page serves it. */
interface FixturePage {
  readonly url: string;
  readonly html: string;
}

/** A recorded page load, so the test can assert what the adapter requested and in which order. */
interface PageRecord {
  readonly loadedUrls: string[];
  closes: number;
}

/**
 * An {@link AdapterPage} over frozen HTML: `load` answers from the fixture list, `html` returns the body
 * of the last load. This is the shape the Playwright runtime implements and the shape the fixture-based
 * adapter tests of 9.x reuse.
 */
function fixturePage(pages: readonly FixturePage[], record: PageRecord): AdapterPage {
  let current: FixturePage | undefined = undefined;

  return {
    load: (url) => {
      record.loadedUrls.push(url);
      current = pages.find((page) => page.url === url);

      return Promise.resolve({
        url,
        status: current === undefined ? 404 : 200,
        headers: { 'content-type': 'text/html' },
      });
    },
    html: () => Promise.resolve(current?.html ?? ''),
    // This double paginates through URLs, so it has no in-page control: `false` is the honest
    // answer of 13.12, "no further block", and not a stub.
    loadMore: () => Promise.resolve(false),
    close: () => {
      record.closes += 1;

      return Promise.resolve();
    },
  };
}

/** The one posting shape the fake Platform renders, read back out with a deliberately dumb parser. */
function renderPosting(id: string, title: string): string {
  return `<li data-id="${id}"><h2>${title}</h2></li>`;
}

function parsePostings(html: string): readonly RawJobPosting[] {
  return [...html.matchAll(/<li data-id="([^"]+)"><h2>([^<]*)<\/h2><\/li>/g)].map((match) => ({
    postingId: match[1] ?? null,
    title: match[2] ?? null,
    // The fake result list shows no employer, location, date or description: absent, not empty (6.8).
    employer: null,
    workLocation: null,
    publishedAtText: null,
    sourceUrl: `https://example.test/job/${match[1] ?? ''}`,
    descriptionText: null,
  }));
}

/**
 * A Platform_Adapter written against the interface only: it pages through the result list until a page
 * yields nothing or the page budget of 13.3 is spent, and reports what it read.
 */
const fakeStepstoneAdapter: PlatformAdapter<typeof PLATFORM_CAPABILITIES.STEPSTONE> = {
  capability: PLATFORM_CAPABILITIES.STEPSTONE,
  resultListUrl: (profile, pageNumber) =>
    `https://example.test/${profile.platform.toLowerCase()}?page=${String(pageNumber)}`,
  fetch: async (context): Promise<AdapterResult> => {
    const page = await context.openPage();
    const postings: RawJobPosting[] = [];
    let pagesFetched = 0;

    try {
      for (let pageNumber = 1; pageNumber <= context.pageBudget; pageNumber += 1) {
        context.signal.throwIfAborted();

        const url = fakeStepstoneAdapter.resultListUrl(context.profile, pageNumber);

        await page.load(url);
        pagesFetched += 1;

        const pagePostings = parsePostings(await page.html());

        if (pagePostings.length === 0) {
          break;
        }

        postings.push(...pagePostings);
        context.log({
          level: 'INFO',
          code: 'platform.pageRead',
          messageDe: `Stepstone: Seite ${String(pageNumber)} gelesen, ${String(pagePostings.length)} Treffer.`,
          pageNumber,
          sourceUrl: url,
        });
      }
    } finally {
      await page.close();
    }

    return buildAdapterResult({
      platform: 'STEPSTONE',
      postings,
      platformStatus: 'COMPLETED',
      pagesFetched,
    });
  },
};

/** The context of one Scrape_Run for the fake adapter, with every channel recorded. */
function fakeContext(
  pages: readonly FixturePage[],
  signal: AbortSignal = new AbortController().signal,
): {
  readonly context: AdapterContext;
  readonly events: AdapterLogEvent[];
  readonly record: PageRecord;
} {
  const events: AdapterLogEvent[] = [];
  const record: PageRecord = { loadedUrls: [], closes: 0 };

  return {
    context: {
      runId: 'run-1',
      runStartedAt: RUN_STARTED_AT,
      profile: stepstoneProfile(),
      openPage: () => Promise.resolve(fixturePage(pages, record)),
      pageBudget: RESULT_PAGE_BUDGET,
      pageTimeoutMs: RESULT_PAGE_TIMEOUT_MS,
      log: (event) => events.push(event),
      signal,
    },
    events,
    record,
  };
}

describe('the production bounds', () => {
  it('states the Page_Safety_Limit of 13.10 and the page timeout of 6.2', () => {
    // 100, not the 10 this started at: 13.3 asks for the result list to be read to its end and this
    // is only the safety net of 13.10 for a Platform that claims a further Result_Page without end.
    // The binding constraint is the 30-minute window of 13.6, which 100 paced requests stay inside.
    expect(RESULT_PAGE_BUDGET).toBe(100);
    expect(RESULT_PAGE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('effectivePageBudget', () => {
  it('takes the narrowest of the handed budget, the Page_Safety_Limit and the Platform limit', () => {
    expect(effectivePageBudget(5)).toBe(5);
    expect(effectivePageBudget(RESULT_PAGE_BUDGET * 10)).toBe(RESULT_PAGE_BUDGET);
    expect(effectivePageBudget(50, 1)).toBe(1);
    expect(effectivePageBudget(1, 50)).toBe(1);
  });

  it('floors a nonsensical budget at 0 rather than looping, and truncates a fraction', () => {
    expect(effectivePageBudget(-3)).toBe(0);
    expect(effectivePageBudget(2.9)).toBe(2);
  });

  it('falls back to the bound for a non-finite budget', () => {
    expect(effectivePageBudget(Number.POSITIVE_INFINITY)).toBe(RESULT_PAGE_BUDGET);
    expect(effectivePageBudget(Number.NaN, 1)).toBe(1);
  });
});

describe('buildAdapterResult', () => {
  it('marks a completed retrieval as no Partial_Result', () => {
    const result = buildAdapterResult({
      platform: 'STEPSTONE',
      postings: [],
      platformStatus: 'COMPLETED',
      pagesFetched: 4,
    });

    expect(result.partialResult).toBe(false);
    expect(result.pagesFetched).toBe(4);
  });

  it.each(['SIGN_IN_REQUIRED', 'PLATFORM_BLOCKED', 'PAGE_LIMIT_REACHED', 'FAILED'] as const)(
    'marks a retrieval ended with %s as a Partial_Result (7.7)',
    (platformStatus) => {
      const posting = parsePostings(renderPosting('a-1', 'Projektmanagerin'));

      const result = buildAdapterResult({
        platform: 'STEPSTONE',
        postings: posting,
        platformStatus,
        pagesFetched: 1,
      });

      expect(result.partialResult).toBe(true);
      // The Job_Posting read so far are kept, never discarded (7.7, 13.5, 13.8).
      expect(result.postings).toEqual(posting);
    },
  );
});

describe('a Platform_Adapter driven through the interface only', () => {
  it('pages through the result list and reports what it read', async () => {
    const { context, events, record } = fakeContext([
      {
        url: 'https://example.test/stepstone?page=1',
        html: `<ul>${renderPosting('a-1', 'Projektmanagerin')}${renderPosting('a-2', 'Projektleiter')}</ul>`,
      },
      {
        url: 'https://example.test/stepstone?page=2',
        html: `<ul>${renderPosting('a-3', 'Project Manager')}</ul>`,
      },
    ]);

    const result = await fakeStepstoneAdapter.fetch(context);

    expect(result.platform).toBe('STEPSTONE');
    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    // Page 3 is requested, answers nothing and ends the retrieval, so two pages carried postings.
    expect(result.pagesFetched).toBe(3);
    expect(result.postings.map((posting) => posting.postingId)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(result.postings[0]?.employer).toBeNull();
    expect(record.loadedUrls).toEqual([
      'https://example.test/stepstone?page=1',
      'https://example.test/stepstone?page=2',
      'https://example.test/stepstone?page=3',
    ]);
    expect(record.closes).toBe(1);
    expect(events.map((event) => event.pageNumber)).toEqual([1, 2]);
    expect(events.every((event) => event.code === 'platform.pageRead')).toBe(true);
  });

  it('stops on a cancelled Scrape_Run and closes its page (12.7, 13.6)', async () => {
    const controller = new AbortController();
    const cancellation = new Error('Suchlauf abgebrochen.');
    const { context, record } = fakeContext(
      [{ url: 'https://example.test/stepstone?page=1', html: '<ul></ul>' }],
      controller.signal,
    );

    controller.abort(cancellation);

    await expect(fakeStepstoneAdapter.fetch(context)).rejects.toBe(cancellation);
    expect(record.loadedUrls).toEqual([]);
    expect(record.closes).toBe(1);
  });
});
