import { describe, expect, it } from 'vitest';

import { RESULT_PAGE_TIMEOUT_MS } from '../../adapter/types.js';
import {
  type Clock,
  MAX_REQUEST_ATTEMPTS,
  MIN_REQUEST_GAP_MS,
  RequestAttemptsExhaustedError,
  type Sleep,
} from '../../scheduling/platform-queue.js';
import {
  BLOCKED_RESOURCE_TYPES,
  PlatformContextExistsError,
  ScrapeRunBrowser,
  ScrapeRunBrowserClosedError,
  withScrapeRunBrowser,
} from '../browser.js';
import { buildUserAgent } from '../user-agent.js';
import { type FakeBrowserBehaviour, FakeBrowserType, FakeRoute } from './fake-playwright.js';

const USER_AGENT = buildUserAgent('job.tool@example.com');

const RESULT_LIST_URL = 'https://www.example.com/jobs?page=1';

/** A clock and a wait that advance virtual time, so a 2-second gap costs no real second. */
function virtualTime(): { clock: Clock; sleep: Sleep; waits: number[] } {
  let current = 0;
  const waits: number[] = [];

  return {
    clock: { now: () => current },
    sleep: async (durationMs) => {
      waits.push(durationMs);
      current += durationMs;
    },
    waits,
  };
}

/** Launches the fake browser and opens the Stepstone context, which is what every test here needs. */
async function openStepstoneContext(
  behaviour: FakeBrowserBehaviour = {},
  signal: AbortSignal = new AbortController().signal,
) {
  const launcher = new FakeBrowserType(behaviour);
  const browser = await ScrapeRunBrowser.launch({ userAgent: USER_AGENT, signal, launcher });
  const time = virtualTime();
  const context = await browser.contextFor({
    platform: 'STEPSTONE',
    clock: time.clock,
    sleep: time.sleep,
  });

  return { browser, context, recorder: launcher.recorder, time };
}

describe('ScrapeRunBrowser.launch', () => {
  it('launches exactly one visible browser window per Scrape_Run (14.13)', async () => {
    const { browser, recorder } = await openStepstoneContext();

    // 14.13: visible, not headless. The single user starts each Scrape_Run by hand and watches it.
    expect(recorder.launchOptions).toEqual([{ headless: false }]);

    await browser.close();
  });

  it('rejects without launching when the Scrape_Run is already cancelled', async () => {
    const controller = new AbortController();
    const cancellation = new Error('Der Scrape_Run wurde abgebrochen.');

    controller.abort(cancellation);

    const launcher = new FakeBrowserType();

    await expect(
      ScrapeRunBrowser.launch({ userAgent: USER_AGENT, signal: controller.signal, launcher }),
    ).rejects.toBe(cancellation);
    expect(launcher.recorder.launchOptions).toHaveLength(0);
  });

  it('applies the per-Result_Page limit of 6.2 unless one is given', async () => {
    const { browser } = await openStepstoneContext();

    expect(browser.pageTimeoutMs).toBe(RESULT_PAGE_TIMEOUT_MS);

    await browser.close();
  });
});

describe('ScrapeRunBrowser.contextFor', () => {
  it('creates one context per Platform with a fresh storage state and the Job_Tool user agent', async () => {
    const { browser, recorder } = await openStepstoneContext();

    expect(recorder.contextOptions).toEqual([
      {
        userAgent: USER_AGENT,
        storageState: undefined,
        serviceWorkers: 'block',
        javaScriptEnabled: true,
      },
    ]);

    await browser.close();
  });

  it('keeps one Platform per context and refuses a second one', async () => {
    const { browser, recorder } = await openStepstoneContext();

    await browser.contextFor({ platform: 'JOBVECTOR' });

    expect(browser.platformsWithContext).toEqual(['STEPSTONE', 'JOBVECTOR']);
    expect(recorder.contextOptions).toHaveLength(2);
    await expect(browser.contextFor({ platform: 'STEPSTONE' })).rejects.toThrow(
      PlatformContextExistsError,
    );

    await browser.close();
  });

  it('applies a stated crawl-delay to the queue of that Platform (14.4)', async () => {
    const { browser, context } = await openStepstoneContext();
    const slow = await browser.contextFor({ platform: 'JOBVECTOR', crawlDelaySeconds: 7 });

    expect(context.queue.minDelayMs).toBe(MIN_REQUEST_GAP_MS);
    expect(slow.queue.minDelayMs).toBe(7000);

    await browser.close();
  });

  it('opens no further context once the browser is closed', async () => {
    const { browser } = await openStepstoneContext();

    await browser.close();

    await expect(browser.contextFor({ platform: 'INDEED' })).rejects.toThrow(
      ScrapeRunBrowserClosedError,
    );
  });
});

describe('request interception', () => {
  it('installs exactly one handler per context, for every URL', async () => {
    const { browser, recorder } = await openStepstoneContext();

    expect(recorder.routePatterns).toEqual(['**/*']);
    expect(recorder.routeHandlers).toHaveLength(1);

    await browser.close();
  });

  it('drops image, font, media and stylesheet requests', async () => {
    const { browser, recorder } = await openStepstoneContext();
    const handler = recorder.routeHandlers[0];

    expect(handler).toBeDefined();

    for (const resourceType of BLOCKED_RESOURCE_TYPES) {
      const route = new FakeRoute(resourceType);

      await handler?.(route);

      expect(route.aborted).toBe(true);
      expect(route.continued).toBe(false);
    }

    await browser.close();
  });

  it('lets the document and the scripts that render the result list through', async () => {
    const { browser, recorder } = await openStepstoneContext();
    const handler = recorder.routeHandlers[0];

    for (const resourceType of ['document', 'script', 'xhr', 'fetch']) {
      const route = new FakeRoute(resourceType);

      await handler?.(route);

      expect(route.continued).toBe(true);
      expect(route.aborted).toBe(false);
    }

    await browser.close();
  });
});

describe('AdapterPage over Playwright', () => {
  it('answers a load with the end URL, the status and lowercased headers', async () => {
    const { browser, context, recorder } = await openStepstoneContext({
      navigate: () => ({
        kind: 'RESPONSE',
        status: 200,
        headers: { 'Content-Type': 'text/html', 'Retry-After': '30' },
        endUrl: 'https://www.example.com/jobs?page=1&session=1',
      }),
    });
    const page = await context.openPage();

    await expect(page.load(RESULT_LIST_URL)).resolves.toEqual({
      url: 'https://www.example.com/jobs?page=1&session=1',
      status: 200,
      headers: { 'content-type': 'text/html', 'retry-after': '30' },
    });
    expect(recorder.navigations).toEqual([
      { url: RESULT_LIST_URL, timeout: RESULT_PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' },
    ]);

    await browser.close();
  });

  it('hands the loaded HTML to the parser', async () => {
    const html = '<html lang="de"><body><article>Projektmanagerin</article></body></html>';
    const { browser, context } = await openStepstoneContext({ html });
    const page = await context.openPage();

    await page.load(RESULT_LIST_URL);

    await expect(page.html()).resolves.toBe(html);

    await browser.close();
  });

  it('reports a navigation without a main-document response as an unknown status', async () => {
    const { browser, context } = await openStepstoneContext({
      navigate: () => ({ kind: 'NULL', endUrl: RESULT_LIST_URL }),
    });
    const page = await context.openPage();

    await expect(page.load(RESULT_LIST_URL)).resolves.toEqual({
      url: RESULT_LIST_URL,
      status: null,
      headers: {},
    });

    await browser.close();
  });

  it('returns a reported rate limit as an answer rather than repeating it (13.5)', async () => {
    const { browser, context, recorder } = await openStepstoneContext({
      navigate: () => ({ kind: 'RESPONSE', status: 429, headers: { 'Retry-After': '120' } }),
    });
    const page = await context.openPage();

    await expect(page.load(RESULT_LIST_URL)).resolves.toMatchObject({ status: 429 });
    expect(recorder.navigations).toHaveLength(1);

    await browser.close();
  });

  it('paces two loads with the minimum gap of 13.2, measured from the settling', async () => {
    const { browser, context, time } = await openStepstoneContext();
    const page = await context.openPage();

    await page.load(RESULT_LIST_URL);
    await page.load('https://www.example.com/jobs?page=2');

    expect(time.waits).toEqual([MIN_REQUEST_GAP_MS]);

    await browser.close();
  });

  it('spends the repetitions of 13.4 on a failed navigation and then gives up', async () => {
    const { browser, context, recorder } = await openStepstoneContext({
      navigate: () => ({ kind: 'FAILURE', message: 'net::ERR_CONNECTION_RESET' }),
    });
    const page = await context.openPage();

    await expect(page.load(RESULT_LIST_URL)).rejects.toThrow(RequestAttemptsExhaustedError);
    expect(recorder.navigations).toHaveLength(MAX_REQUEST_ATTEMPTS);

    await browser.close();
  });

  it('answers from a repeated navigation that succeeds', async () => {
    const { browser, context, recorder } = await openStepstoneContext({
      navigate: (_url, attempt) =>
        attempt === 1
          ? { kind: 'FAILURE', message: 'Timeout 30000ms exceeded.' }
          : { kind: 'RESPONSE', status: 200 },
    });
    const page = await context.openPage();

    await expect(page.load(RESULT_LIST_URL)).resolves.toMatchObject({ status: 200 });
    expect(recorder.navigations).toHaveLength(2);

    await browser.close();
  });

  it('reports a cancelled Scrape_Run as the cancellation, not as a failed request (12.7)', async () => {
    const controller = new AbortController();
    const cancellation = new Error('Der Scrape_Run wurde abgebrochen.');
    const { browser, context, recorder } = await openStepstoneContext(
      {
        navigate: () => {
          controller.abort(cancellation);

          return { kind: 'FAILURE', message: 'Target page, context or browser has been closed' };
        },
      },
      controller.signal,
    );
    const page = await context.openPage();

    await expect(page.load(RESULT_LIST_URL)).rejects.toBe(cancellation);
    expect(recorder.navigations).toHaveLength(1);

    await browser.close();
  });

  it('exposes loading, reading, one pagination step and closing only (7.5, 7.6, 13.12)', async () => {
    const { browser, context } = await openStepstoneContext();
    const page = await context.openPage();
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(page) as object),
      ...Object.getOwnPropertyNames(page),
    ].filter((name) => name !== 'constructor');

    // This assertion is where the 7.5 and 7.6 guarantees live, so what it permits matters. Since
    // 13.12 it permits `loadMore`, which reveals a further block of a result list the adapter is
    // already reading. It still permits **no** `click`, `fill`, `type`, `press` or `evaluate`: there
    // is no member an adapter could aim at a sign-in form, a consent dialog or a Captcha. A sign-in
    // wall and a bot check are ended where they are detected (7.2, 7.6, 7.8), never clicked through.
    expect(surface.sort()).toEqual(['close', 'html', 'load', 'loadMore']);

    await browser.close();
  });
});

describe('teardown', () => {
  it('closes every page, then the context, then the browser', async () => {
    const { browser, context, recorder } = await openStepstoneContext();

    await context.openPage();
    await context.openPage();

    expect(context.openPageCount).toBe(2);

    await browser.close();

    expect(recorder.closeOrder).toEqual(['page', 'page', 'context', 'browser']);
    expect(context.openPageCount).toBe(0);
    expect(context.isClosed).toBe(true);
    expect(browser.isClosed).toBe(true);
  });

  it('closes once however often it is asked', async () => {
    const { browser, context, recorder } = await openStepstoneContext();

    await context.openPage();
    await Promise.all([browser.close(), browser.close()]);
    await browser.close();

    expect(recorder.browserCloseCount).toBe(1);
    expect(recorder.pageCloseCount).toBe(1);
  });

  it('survives a page or a browser that refuses to close', async () => {
    const { browser, context, recorder } = await openStepstoneContext({
      failPageClose: true,
      failBrowserClose: true,
    });

    await context.openPage();

    await expect(browser.close()).resolves.toBeUndefined();
    expect(recorder.closeOrder).toEqual(['page', 'context', 'browser']);
  });

  it('opens no further page once the context is closed', async () => {
    const { browser, context } = await openStepstoneContext();
    const page = await context.openPage();

    await browser.close();

    await expect(context.openPage()).rejects.toThrow(ScrapeRunBrowserClosedError);
    await expect(page.load(RESULT_LIST_URL)).rejects.toThrow(ScrapeRunBrowserClosedError);
  });

  it('closes the browser when the Scrape_Run is cancelled (12.7, 13.6)', async () => {
    const controller = new AbortController();
    const { browser, context, recorder } = await openStepstoneContext({}, controller.signal);

    await context.openPage();

    controller.abort(new Error('Die Abrufdauer von 30 Minuten wurde erreicht.'));

    // The listener cannot be awaited, so the teardown it started is awaited through `close`.
    await browser.close();

    expect(recorder.closeOrder).toEqual(['page', 'context', 'browser']);
  });
});

describe('withScrapeRunBrowser', () => {
  it('closes everything after the Scrape_Run', async () => {
    const launcher = new FakeBrowserType();
    const html = await withScrapeRunBrowser(
      { userAgent: USER_AGENT, signal: new AbortController().signal, launcher },
      async (browser) => {
        const context = await browser.contextFor({ platform: 'STEPSTONE' });
        const page = await context.openPage();

        await page.load(RESULT_LIST_URL);

        return page.html();
      },
    );

    expect(html).toContain('<html');
    expect(launcher.recorder.closeOrder).toEqual(['page', 'context', 'browser']);
  });

  it('closes everything when the retrieval throws', async () => {
    const launcher = new FakeBrowserType();
    const failure = new Error('Die Seitenstruktur von Stepstone ist unbekannt.');

    await expect(
      withScrapeRunBrowser(
        { userAgent: USER_AGENT, signal: new AbortController().signal, launcher },
        async (browser) => {
          const context = await browser.contextFor({ platform: 'STEPSTONE' });

          await context.openPage();

          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(launcher.recorder.closeOrder).toEqual(['page', 'context', 'browser']);
  });
});
