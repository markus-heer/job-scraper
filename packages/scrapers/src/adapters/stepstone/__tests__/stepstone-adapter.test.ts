/**
 * The Stepstone Platform_Adapter as a sequencer of Result_Page (6.2, 6.7, 7.2, 7.6, 7.7, 13.3, 13.5).
 *
 * The {@link AdapterPage} port is scripted here, so these tests cover what the adapter itself decides:
 * how far it pages, which Platform_Status it reports for which observation, that the Job_Posting read
 * before an end survive as Partial_Result, that the German progress lines are written, and that no
 * further page is requested after an end. Pacing, repetitions and the page time limit belong to the
 * `PlatformQueue` and are tested with it; captured fixtures are task 9.3.
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_CAPABILITIES,
  PLATFORM_OVERRIDES,
  resolveSearchProfile,
} from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  AdapterLogEvent,
  AdapterPage,
  AdapterPageResponse,
} from '../../../adapter/types.js';
import { RESULT_PAGE_BUDGET } from '../../../adapter/types.js';
import { RequestAttemptsExhaustedError } from '../../../scheduling/platform-queue.js';
import { StepstoneAdapter } from '../index.js';
import { STEPSTONE_RESULT_PAGE_LIMIT } from '../result-list-url.js';

/** The effective Search_Profile of Stepstone as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('STEPSTONE', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Stepstone profile does not resolve.');
  }

  return resolution.profile;
})();

/** What the scripted page answers for one load. */
interface ScriptedLoad {
  /** The HTML of that Result_Page. */
  readonly html?: string;
  /** The URL the load ended on, for a redirect (7.2). Defaults to the requested URL. */
  readonly endedAt?: string;
  readonly status?: number | null;
  readonly headers?: Readonly<Record<string, string>>;
  /** Thrown instead of answering, as the queue does for an exhausted attempt series (13.8). */
  readonly error?: unknown;
}

/** An {@link AdapterPage} that answers a scripted sequence and records what was asked of it. */
class ScriptedPage implements AdapterPage {
  readonly requested: string[] = [];

  closeCount = 0;

  readonly #loads: readonly ScriptedLoad[];

  #html = '';

  constructor(loads: readonly ScriptedLoad[]) {
    this.#loads = loads;
  }

  async load(url: string): Promise<AdapterPageResponse> {
    const load = this.#loads[this.requested.length];

    this.requested.push(url);

    if (load === undefined) {
      throw new Error(`The test scripted no answer for ${url}.`);
    }

    if (load.error !== undefined) {
      throw load.error;
    }

    this.#html = load.html ?? '';

    return {
      url: load.endedAt ?? url,
      status: load.status === undefined ? 200 : load.status,
      headers: load.headers ?? {},
    };
  }

  async html(): Promise<string> {
    return this.#html;
  }

  /**
   * Stepstone has no in-page pagination control, so `false` is the honest answer of 13.12 rather
   * than a stub: this scripted page offers no further block.
   */
  async loadMore(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** The context of one Stepstone retrieval, with the Log_Stream collected in an array. */
function contextFor(
  page: AdapterPage,
  options: { pageBudget?: number; signal?: AbortSignal } = {},
): { context: AdapterContext; events: AdapterLogEvent[] } {
  const events: AdapterLogEvent[] = [];

  return {
    events,
    context: {
      runId: 'run-1',
      runStartedAt: new Date('2026-10-27T08:00:00.000Z'),
      profile: PROFILE,
      openPage: () => Promise.resolve(page),
      pageBudget: options.pageBudget ?? RESULT_PAGE_BUDGET,
      pageTimeoutMs: 30_000,
      log: (event) => events.push(event),
      signal: options.signal ?? new AbortController().signal,
    },
  };
}

/** One job card with the given Posting_Id. */
function card(id: string): string {
  return `
    <article data-at="job-item" data-id="${id}">
      <h2><a data-at="job-item-title" href="/stellenangebote--Projektmanagerin--${id}-inline.html">Projektmanagerin ${id}</a></h2>
      <span data-at="job-item-company-name">Beispiel GmbH</span>
      <span data-at="job-item-location">München</span>
      <span data-at="job-item-timeago">vor 3 Tagen</span>
    </article>`;
}

/** A result list page, with a pagination control unless `nextPage` is false. */
function resultList(ids: readonly string[], nextPage = true): string {
  const next = nextPage
    ? '<a data-at="pagination-next" href="?page=next">Weiter</a>'
    : '<a data-at="pagination-next" aria-disabled="true">Weiter</a>';

  return `<html><body><main>${ids.map(card).join('')}${next}</main></body></html>`;
}

/** The codes of the collected Log_Stream entries, in order. */
function codesOf(events: readonly AdapterLogEvent[]): readonly string[] {
  return events.map((event) => event.code);
}

describe('the adapter as a registry entry', () => {
  it('declares the Stepstone capability and builds its own Result_Page URL (4.2, 14.1)', () => {
    const adapter = new StepstoneAdapter();

    const url = new URL(adapter.resultListUrl(PROFILE, 1));

    expect(adapter.capability).toBe(PLATFORM_CAPABILITIES.STEPSTONE);
    expect(url.origin).toBe('https://www.stepstone.de');
    expect(url.pathname).toBe('/jobs/projektmanagerin/in-muenchen');
    // No radius, and no second parameter of any kind: this Platform's robots.txt permits exactly one
    // query parameter, so `searchRadiusKm` left its `supportedFields` and the Platform_Override that
    // used to set it is gone (14.2). `../result-list-url.ts` carries the measured decision table.
    expect(url.searchParams.get('radius')).toBeNull();
    expect([...url.searchParams.keys()].length).toBeLessThanOrEqual(1);
  });

  it('declares the one-Result_Page limit of this Platform on the interface (13.13)', () => {
    // Read by `intendedPathsOf` in the Scraper_Service *before* the first request, so the robots.txt
    // evaluation of 14.1 only ever sees paths this adapter actually intends to request. Without it,
    // 14.2 would exclude the Platform in full for a `?page=2` the adapter never builds.
    expect(new StepstoneAdapter().pageLimit).toBe(1);
  });
});

describe('a retrieval that reads the result list to its end', () => {
  it('reads the one permitted Result_Page and reports COMPLETED where it is the last', async () => {
    const page = new ScriptedPage([{ html: resultList(['111111', '222222'], false) }]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(result.pagesFetched).toBe(1);
    expect(result.postings.map((posting) => posting.postingId)).toEqual(['111111', '222222']);
    expect(page.requested).toEqual([new StepstoneAdapter().resultListUrl(PROFILE, 1)]);
    expect(codesOf(events)).toEqual(['platform.pageFetched', 'platform.resultListComplete']);
  });

  it('writes one German progress line per page with the postings found (12.3)', async () => {
    const page = new ScriptedPage([{ html: resultList(['111111', '222222'], false) }]);
    const { context, events } = contextFor(page);

    await new StepstoneAdapter().fetch(context);

    expect(events[0]).toMatchObject({
      level: 'INFO',
      code: 'platform.pageFetched',
      messageDe: 'Stepstone: Seite 1 gelesen, 2 Treffer gefunden.',
      pageNumber: 1,
    });
  });

  it('reports COMPLETED without a posting for an empty result list (2.8)', async () => {
    const page = new ScriptedPage([
      { html: '<html><body><div data-at="no-results">Leider keine Treffer</div></body></html>' },
    ]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.postings).toEqual([]);
    expect(result.pagesFetched).toBe(1);
    expect(codesOf(events)).toContain('platform.noResults');
  });
});

describe('the page limit of 13.3', () => {
  it('ends with PAGE_LIMIT_REACHED where the page offers a further one, keeping its postings', async () => {
    const page = new ScriptedPage([{ html: resultList(['111111']) }]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    // The page offers a further Result_Page that has no permitted address, so this is the ordinary
    // end of a *successful* Stepstone retrieval (13.13) and the postings read are kept (7.7).
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    expect(result.partialResult).toBe(true);
    expect(result.pagesFetched).toBe(1);
    expect(result.postings).toHaveLength(1);
    expect(page.requested).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      level: 'INFO',
      code: 'platform.pageLimit',
      messageDe: 'Stepstone: Seitenlimit erreicht, es wurden 1 Ergebnisseiten gelesen.',
    });
  });

  it('reads one Result_Page whatever budget it is handed, since no second is permitted', async () => {
    const page = new ScriptedPage(
      Array.from({ length: 20 }, (_unused, index) => ({
        html: resultList([`10000${String(index)}`]),
      })),
    );
    const { context } = contextFor(page, { pageBudget: RESULT_PAGE_BUDGET });

    const result = await new StepstoneAdapter().fetch(context);

    // `STEPSTONE_RESULT_PAGE_LIMIT` is the tighter of the two bounds and nothing can raise it: the
    // robots.txt of this Platform forbids every pagination shape (13.13), so `PAGE_LIMIT_REACHED` is
    // the ordinary end of a *successful* retrieval here and the result is a Partial_Result (7.7).
    expect(result.pagesFetched).toBe(STEPSTONE_RESULT_PAGE_LIMIT);
    expect(page.requested).toHaveLength(STEPSTONE_RESULT_PAGE_LIMIT);
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    expect(result.partialResult).toBe(true);
  });
});

describe('a retrieval that a page ends', () => {
  it('reports SIGN_IN_REQUIRED and keeps what the page left readable (7.2, 7.7)', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111']), endedAt: 'https://www.stepstone.de/candidate/login' },
    ]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    // A *redirect* to the sign-in page is classified from the response URL rather than from the
    // markup, so no posting is read at all — the document the Platform served is the login page.
    // That is still a Partial_Result (7.7): the result list was not read. The case where postings
    // *do* survive a sign-in wall is an overlay above a readable list, which the `sign-in-wall`
    // fixture covers in `fixture-adapter.test.ts`; the across-pages shape of the rule is covered by
    // the Jobvector sibling of this file, the adapter that still paginates through a URL.
    expect(result.platformStatus).toBe('SIGN_IN_REQUIRED');
    expect(result.partialResult).toBe(true);
    expect(result.postings).toEqual([]);
    expect(page.requested).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      level: 'WARN',
      code: 'platform.signInRequired',
      messageDe:
        'Stepstone zeigt Ergebnisse nur nach Anmeldung. Die Trefferliste ist für diese Plattform unvollständig.',
      pageNumber: 1,
    });
  });

  it('reports PLATFORM_BLOCKED for a bot check and asks for no further page (7.6, 7.8)', async () => {
    const page = new ScriptedPage([
      { html: '<html><body><h1>Sind Sie ein Mensch?</h1></body></html>' },
      { html: resultList(['333333']) },
    ]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    expect(result.platformStatus).toBe('PLATFORM_BLOCKED');
    // 7.8: the second scripted answer is never asked for. The check stays unanswered (7.6).
    expect(page.requested).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ level: 'WARN', code: 'platform.blocked' });
  });

  it('reports FETCH_RATE_LIMITED and sends no further request to the Platform (13.5)', async () => {
    const page = new ScriptedPage([
      { html: '', status: 429, headers: { 'retry-after': '60' } },
      { html: resultList(['333333']) },
    ]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    expect(result.platformStatus).toBe('FETCH_RATE_LIMITED');
    expect(page.requested).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      level: 'WARN',
      code: 'platform.rateLimited',
      pageNumber: 1,
    });
  });

  it('reports PAGE_LAYOUT_UNKNOWN for a page that yields no readable Job_Posting (6.7)', async () => {
    const page = new ScriptedPage([
      {
        html: '<html><body><main><div class="new-card">Projektmanagerin</div></main></body></html>',
      },
    ]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    expect(result.platformStatus).toBe('PAGE_LAYOUT_UNKNOWN');
    expect(result.pagesFetched).toBe(1);
    expect(events.at(-1)).toMatchObject({
      level: 'ERROR',
      code: 'platform.layoutUnknown',
      messageDe:
        'Der Seitenaufbau von Stepstone hat sich geändert; es konnten keine Treffer gelesen werden.',
    });
  });

  it('reports PLATFORM_UNREACHABLE when the Platform serves no result list', async () => {
    const page = new ScriptedPage([{ html: '', status: 503 }]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    expect(result.platformStatus).toBe('PLATFORM_UNREACHABLE');
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'platform.unreachable' });
  });
});

describe('a page request that fails', () => {
  it('reports FAILED with the page number after the attempts are exhausted (13.8)', async () => {
    const page = new ScriptedPage([{ error: new RequestAttemptsExhaustedError('STEPSTONE', 3) }]);
    const { context, events } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    expect(result.platformStatus).toBe('FAILED');
    expect(result.partialResult).toBe(true);
    expect(result.pagesFetched).toBe(0);
    expect(events.at(-1)).toMatchObject({
      level: 'ERROR',
      code: 'page.failed',
      messageDe:
        'Stepstone hat auf Seite 1 nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.',
      pageNumber: 1,
    });
  });

  it('reports FAILED for an unexpected fault rather than throwing', async () => {
    const page = new ScriptedPage([
      { error: new TypeError('Something inside the runtime broke.') },
    ]);
    const { context } = contextFor(page);

    const result = await new StepstoneAdapter().fetch(context);

    // The "keeps the postings up to the failed page" half of 13.8 needs a second Result_Page to be
    // observable, which this Platform has none of; the Jobvector sibling of this file covers it.
    expect(result.platformStatus).toBe('FAILED');
    expect(result.postings).toEqual([]);
  });
});

describe('cancellation of the Scrape_Run', () => {
  it('rejects with the abort reason instead of inventing a Platform_Status (12.7, 13.6)', async () => {
    const controller = new AbortController();
    const reason = new Error('Zeitlimit von 30 Minuten erreicht.');
    const page = new ScriptedPage([{ html: resultList(['111111']) }]);
    const { context } = contextFor(page, { signal: controller.signal });

    controller.abort(reason);

    await expect(new StepstoneAdapter().fetch(context)).rejects.toBe(reason);
    expect(page.requested).toEqual([]);
  });

  it('asks for no further page once the Scrape_Run is cancelled mid-retrieval', async () => {
    const controller = new AbortController();
    const reason = new Error('Suchlauf abgebrochen.');
    const page = new ScriptedPage([
      { html: resultList(['111111']) },
      { html: resultList(['222222']) },
    ]);
    const { context } = contextFor(page, { signal: controller.signal });
    const adapter = new StepstoneAdapter();
    const pending = adapter.fetch(context);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(page.requested.length).toBeLessThanOrEqual(1);
    expect(page.closeCount).toBe(1);
  });
});

describe('the page the adapter opened', () => {
  it('is closed on every path', async () => {
    const completed = new ScriptedPage([{ html: resultList(['111111'], false) }]);
    const blocked = new ScriptedPage([{ html: '<html><body>Captcha</body></html>' }]);
    const failed = new ScriptedPage([{ error: new RequestAttemptsExhaustedError('STEPSTONE', 3) }]);

    for (const page of [completed, blocked, failed]) {
      await new StepstoneAdapter().fetch(contextFor(page).context);

      expect(page.closeCount).toBe(1);
    }
  });
});
