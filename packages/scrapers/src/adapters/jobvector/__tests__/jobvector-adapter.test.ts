/**
 * The Jobvector Platform_Adapter as a sequencer of Result_Page (6.2, 6.7, 7.2, 7.6, 7.7, 13.3, 13.5).
 *
 * The {@link AdapterPage} port is scripted here, so these tests cover what the adapter itself decides:
 * how far it pages, which Platform_Status it reports for which observation, that the Job_Posting read
 * before an end survive as Partial_Result, that the German progress lines are written, and that no
 * further page is requested after an end. Pacing, repetitions and the page time limit belong to the
 * `PlatformQueue` and are tested with it; captured fixtures are task 10.3.
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
import { JobvectorAdapter } from '../index.js';

/** The effective Search_Profile of Jobvector as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('JOBVECTOR', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Jobvector profile does not resolve.');
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

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** The context of one Jobvector retrieval, with the Log_Stream collected in an array. */
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
    <li itemscope itemtype="https://schema.org/JobPosting" data-jobid="${id}">
      <h2><a itemprop="url" href="/stellenangebote/${id}-projektmanagerin/"><span itemprop="title">Projektmanagerin ${id}</span></a></h2>
      <div itemprop="hiringOrganization"><span itemprop="name">Beispiel GmbH</span></div>
      <div itemprop="jobLocation"><span itemprop="addressLocality">München</span></div>
      <span itemprop="datePosted">vor 3 Tagen</span>
    </li>`;
}

/** A result list page, with a pagination control unless `nextPage` is false. */
function resultList(ids: readonly string[], nextPage = true): string {
  const next = nextPage
    ? '<a rel="next" href="?page=next">Weiter</a>'
    : '<a rel="next" aria-disabled="true">Weiter</a>';

  return `<html><body><main><ul>${ids.map(card).join('')}</ul>${next}</main></body></html>`;
}

/** The codes of the collected Log_Stream entries, in order. */
function codesOf(events: readonly AdapterLogEvent[]): readonly string[] {
  return events.map((event) => event.code);
}

describe('the adapter as a registry entry', () => {
  it('declares the Jobvector capability and builds its own Result_Page URL (4.2, 14.1)', () => {
    const adapter = new JobvectorAdapter();

    const url = new URL(adapter.resultListUrl(PROFILE, 1));

    expect(adapter.capability).toBe(PLATFORM_CAPABILITIES.JOBVECTOR);
    expect(url.origin).toBe('https://www.jobvector.de');
    expect(url.pathname).toBe('/jobs/');
    // The industry filter Jobvector supports and Stepstone does not (4.2).
    expect(url.searchParams.get('industry')).toBe('Pharma and Life Science');
    expect(url.searchParams.get('location')).toBe('München');
    expect(url.searchParams.get('radius')).toBe('50');
  });
});

describe('a retrieval that reads the result list to its end', () => {
  it('pages until no further Result_Page is offered and reports COMPLETED', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111', '222222']) },
      { html: resultList(['333333'], false) },
    ]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(result.pagesFetched).toBe(2);
    expect(result.postings.map((posting) => posting.postingId)).toEqual([
      '111111',
      '222222',
      '333333',
    ]);
    expect(page.requested).toEqual([
      new JobvectorAdapter().resultListUrl(PROFILE, 1),
      new JobvectorAdapter().resultListUrl(PROFILE, 2),
    ]);
    expect(codesOf(events)).toEqual([
      'platform.pageFetched',
      'platform.pageFetched',
      'platform.resultListComplete',
    ]);
  });

  it('writes one German progress line per page with the postings found (12.3)', async () => {
    const page = new ScriptedPage([{ html: resultList(['111111', '222222'], false) }]);
    const { context, events } = contextFor(page);

    await new JobvectorAdapter().fetch(context);

    expect(events[0]).toMatchObject({
      level: 'INFO',
      code: 'platform.pageFetched',
      messageDe: 'Jobvector: Seite 1 gelesen, 2 Treffer gefunden.',
      pageNumber: 1,
    });
  });

  it('reports COMPLETED without a posting for an empty result list (2.8)', async () => {
    const page = new ScriptedPage([
      {
        html: '<html><body><div class="no-results">Keine Stellenangebote gefunden</div></body></html>',
      },
    ]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.postings).toEqual([]);
    expect(result.pagesFetched).toBe(1);
    expect(codesOf(events)).toContain('platform.noResults');
  });
});

describe('the page limit of 13.3', () => {
  it('ends after the budget with PAGE_LIMIT_REACHED and keeps the postings read', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111']) },
      { html: resultList(['222222']) },
    ]);
    const { context, events } = contextFor(page, { pageBudget: 2 });

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    expect(result.partialResult).toBe(true);
    expect(result.pagesFetched).toBe(2);
    expect(result.postings).toHaveLength(2);
    expect(page.requested).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      level: 'INFO',
      code: 'platform.pageLimit',
      messageDe: 'Jobvector: Seitenlimit erreicht, es wurden 2 Ergebnisseiten gelesen.',
    });
  });

  it('never reads more than 10 Result_Page, whatever budget it is handed', async () => {
    const page = new ScriptedPage(
      Array.from({ length: 20 }, (_unused, index) => ({
        html: resultList([`10000${String(index)}`]),
      })),
    );
    const { context } = contextFor(page, { pageBudget: 50 });

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.pagesFetched).toBe(RESULT_PAGE_BUDGET);
    expect(page.requested).toHaveLength(RESULT_PAGE_BUDGET);
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
  });
});

describe('a retrieval that a page ends', () => {
  it('reports SIGN_IN_REQUIRED and keeps the earlier postings as Partial_Result (7.2, 7.7)', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111']) },
      { html: resultList(['222222']), endedAt: 'https://www.jobvector.de/bewerberlogin/' },
    ]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('SIGN_IN_REQUIRED');
    expect(result.partialResult).toBe(true);
    expect(result.postings.map((posting) => posting.postingId)).toEqual(['111111']);
    expect(page.requested).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      level: 'WARN',
      code: 'platform.signInRequired',
      messageDe:
        'Jobvector zeigt Ergebnisse nur nach Anmeldung. Die Trefferliste ist für diese Plattform unvollständig.',
      pageNumber: 2,
    });
  });

  it('reports PLATFORM_BLOCKED for a bot check and asks for no further page (7.6, 7.8)', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111']) },
      { html: '<html><body><h1>Sind Sie ein Mensch?</h1></body></html>' },
      { html: resultList(['333333']) },
    ]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('PLATFORM_BLOCKED');
    expect(result.postings).toHaveLength(1);
    expect(page.requested).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ level: 'WARN', code: 'platform.blocked' });
  });

  it('reports FETCH_RATE_LIMITED and sends no further request to the Platform (13.5)', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111']) },
      { html: '', status: 429, headers: { 'retry-after': '60' } },
      { html: resultList(['333333']) },
    ]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('FETCH_RATE_LIMITED');
    expect(result.postings).toHaveLength(1);
    expect(page.requested).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      level: 'WARN',
      code: 'platform.rateLimited',
      pageNumber: 2,
    });
  });

  it('reports PAGE_LAYOUT_UNKNOWN for a page that yields no readable Job_Posting (6.7)', async () => {
    const page = new ScriptedPage([
      {
        html: '<html><body><main><div class="new-card">Projektmanagerin</div></main></body></html>',
      },
    ]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('PAGE_LAYOUT_UNKNOWN');
    expect(result.pagesFetched).toBe(1);
    expect(events.at(-1)).toMatchObject({
      level: 'ERROR',
      code: 'platform.layoutUnknown',
      messageDe:
        'Der Seitenaufbau von Jobvector hat sich geändert; es konnten keine Treffer gelesen werden.',
    });
  });

  it('reports PLATFORM_UNREACHABLE when the Platform serves no result list', async () => {
    const page = new ScriptedPage([{ html: '', status: 503 }]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('PLATFORM_UNREACHABLE');
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'platform.unreachable' });
  });
});

describe('a page request that fails', () => {
  it('reports FAILED with the page number and keeps the postings up to it (13.8)', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111']) },
      { error: new RequestAttemptsExhaustedError('JOBVECTOR', 3) },
    ]);
    const { context, events } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('FAILED');
    expect(result.partialResult).toBe(true);
    expect(result.postings).toHaveLength(1);
    expect(result.pagesFetched).toBe(1);
    expect(events.at(-1)).toMatchObject({
      level: 'ERROR',
      code: 'page.failed',
      messageDe:
        'Jobvector hat auf Seite 2 nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.',
      pageNumber: 2,
    });
  });

  it('reports FAILED for an unexpected fault rather than losing the Partial_Result', async () => {
    const page = new ScriptedPage([
      { html: resultList(['111111']) },
      { error: new TypeError('Something inside the runtime broke.') },
    ]);
    const { context } = contextFor(page);

    const result = await new JobvectorAdapter().fetch(context);

    expect(result.platformStatus).toBe('FAILED');
    expect(result.postings).toHaveLength(1);
  });
});

describe('cancellation of the Scrape_Run', () => {
  it('rejects with the abort reason instead of inventing a Platform_Status (12.7, 13.6)', async () => {
    const controller = new AbortController();
    const reason = new Error('Zeitlimit von 30 Minuten erreicht.');
    const page = new ScriptedPage([{ html: resultList(['111111']) }]);
    const { context } = contextFor(page, { signal: controller.signal });

    controller.abort(reason);

    await expect(new JobvectorAdapter().fetch(context)).rejects.toBe(reason);
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
    const adapter = new JobvectorAdapter();
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
    const failed = new ScriptedPage([{ error: new RequestAttemptsExhaustedError('JOBVECTOR', 3) }]);

    for (const page of [completed, blocked, failed]) {
      await new JobvectorAdapter().fetch(contextFor(page).context);

      expect(page.closeCount).toBe(1);
    }
  });
});
