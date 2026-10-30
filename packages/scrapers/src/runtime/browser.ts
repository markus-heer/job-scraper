/**
 * The Playwright runtime of a Scrape_Run (6.2, 7.1, 7.5, 12.7, 13.6, 14.5, 14.6).
 *
 * Three nested lifetimes, each with exactly one owner:
 *
 * - one headless Chromium per Scrape_Run ({@link ScrapeRunBrowser}). One browser rather than one per
 *   Platform, because a `BrowserContext` already isolates cookies and storage, so a second process
 *   would cost memory without buying isolation;
 * - one `BrowserContext` per Platform ({@link PlatformBrowserContext}), created with a fresh storage
 *   state and the Job_Tool user agent of 14.5, so that a sign-in prompt or a cookie of one Platform
 *   cannot reach another;
 * - one page per Result_Page request, wrapped as the {@link AdapterPage} port of the adapter
 *   interface, so an adapter sees "load this URL, give me the HTML" and nothing else.
 *
 * What the runtime takes off the adapters:
 *
 * - *Pacing and repetition.* Every load goes through the {@link PlatformQueue} of its Platform, which
 *   holds the single in-flight request of 13.9, the minimum gap of 13.2, a stated crawl-delay (14.4)
 *   and the at-most-three attempts of 13.4. An adapter therefore never sleeps and never retries.
 * - *The page time limit.* A navigation that exceeds `pageTimeoutMs` — {@link RESULT_PAGE_TIMEOUT_MS}
 *   in production (6.2) — is turned into a {@link RetryableRequestError}, which is the one error the
 *   queue spends a repetition on.
 * - *Page weight.* One interception handler per context drops `image`, `font`, `media` and
 *   `stylesheet` requests, which cuts the bytes a Platform has to serve for a result list.
 * - *Teardown.* {@link withScrapeRunBrowser} closes every page, every context and the browser in a
 *   `finally` block, and the `AbortSignal` of the Scrape_Run closes the browser on its own, so
 *   neither a cancellation (12.7) nor the 30-minute deadline (13.6) can leave a Chromium behind.
 *
 * What the runtime structurally cannot do: fill a form, press a button or answer a Captcha (7.5, 7.6).
 * The Playwright surface it is typed against has no such method — see `./playwright-port.ts`.
 */

import type { Platform } from '@job-scraper/domain';

import {
  type AdapterPage,
  type AdapterPageResponse,
  RESULT_PAGE_TIMEOUT_MS,
} from '../adapter/types.js';
import {
  type Clock,
  PlatformQueue,
  RetryableRequestError,
  type Sleep,
} from '../scheduling/platform-queue.js';
import {
  defaultBrowserLauncher,
  type RuntimeBrowser,
  type RuntimeBrowserContext,
  type RuntimeBrowserType,
  type RuntimePage,
  type RuntimeRoute,
} from './playwright-port.js';

/**
 * The resource types a Result_Page retrieval drops.
 *
 * None of the four carries a Job_Posting: the eight fields of 6.3 live in the document, and an
 * adapter parses HTML, never pixels. Dropping them reduces the load the Job_Tool puts on a Platform,
 * which is the etiquette intent behind Requirement 14.
 */
export const BLOCKED_RESOURCE_TYPES = ['image', 'font', 'media', 'stylesheet'] as const;

/** One of the resource types a Result_Page retrieval drops. */
export type BlockedResourceType = (typeof BLOCKED_RESOURCE_TYPES)[number];

const BLOCKED_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(BLOCKED_RESOURCE_TYPES);

/** The URL pattern of the single interception handler: every request of the context. */
const ALL_URLS_PATTERN = '**/*';

/**
 * How far a navigation is awaited.
 *
 * `domcontentloaded` rather than `load` or `networkidle`: the result list markup an adapter parses is
 * in the document once the DOM is built, whereas `load` additionally waits for subresources — several
 * of which the interception handler has just aborted — and `networkidle` waits for analytics traffic
 * that may never settle. Waiting longer than the parser needs would spend the 30-second budget of 6.2
 * on bytes nobody reads.
 */
const PAGE_WAIT_UNTIL = 'domcontentloaded';

/**
 * How often a pagination step re-reads the document while waiting for it to grow (13.12).
 *
 * 250 ms is short enough that a fast block is noticed almost immediately and long enough that the
 * polling is not the cost. It never paces a retrieval: the 2-second gap of 13.2 is an order of
 * magnitude larger and is applied by the PlatformQueue around the whole step.
 */
const PAGINATION_POLL_INTERVAL_MS = 250;

/** Waits `ms` milliseconds. Used only by the pagination growth poll. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The runtime was used after the Scrape_Run browser had been closed or cancelled. */
export class ScrapeRunBrowserClosedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The Scrape_Run browser is closed and opens no further context or page.', options);
    this.name = 'ScrapeRunBrowserClosedError';
  }
}

/** A second `BrowserContext` was requested for a Platform that already has one. */
export class PlatformContextExistsError extends Error {
  readonly platform: Platform;

  constructor(platform: Platform) {
    super(
      `Platform ${platform} already has a BrowserContext in this Scrape_Run; exactly one is permitted.`,
    );
    this.name = 'PlatformContextExistsError';
    this.platform = platform;
  }
}

/** Construction arguments of a {@link ScrapeRunBrowser}. */
export interface ScrapeRunBrowserOptions {
  /** The unchanged Job_Tool user agent of 14.5, built by `buildUserAgent`. */
  readonly userAgent: string;
  /** Cancellation of the Scrape_Run by the user (12.7) or by the 30-minute limit (13.6). */
  readonly signal: AbortSignal;
  /** The per-Result_Page limit. Defaults to {@link RESULT_PAGE_TIMEOUT_MS} (6.2, 13.4). */
  readonly pageTimeoutMs?: number;
  /** What launches the browser. Defaults to Playwright's Chromium; the tests inject a double. */
  readonly launcher?: RuntimeBrowserType;
}

/** Arguments of one {@link PlatformBrowserContext}. */
export interface PlatformContextOptions {
  readonly platform: Platform;
  /**
   * The `Crawl-delay` the robots.txt of that Platform states for the Job_Tool's user agent, in
   * seconds (14.4). Read from the robots.txt decision, which 14.1 requires before the first page
   * request, so the pacing of the very first load already honours it.
   */
  readonly crawlDelaySeconds?: number;
  /** Time source of the queue. Defaults to the system clock; the pacing tests inject a virtual one. */
  readonly clock?: Clock;
  /** Wait implementation of the queue. Defaults to a timer. */
  readonly sleep?: Sleep;
}

/**
 * The one browser of a Scrape_Run.
 *
 * Created through {@link ScrapeRunBrowser.launch}, or better through {@link withScrapeRunBrowser},
 * which guarantees the teardown.
 */
export class ScrapeRunBrowser {
  readonly #browser: RuntimeBrowser;

  readonly #userAgent: string;

  readonly #pageTimeoutMs: number;

  readonly #signal: AbortSignal;

  /** One context per Platform (8.4). The map *is* that rule. */
  readonly #contexts = new Map<Platform, PlatformBrowserContext>();

  /** The abort listener of 8.4, kept so the teardown can detach it. */
  readonly #onAbort: () => void;

  /** The single teardown, so the abort listener and an explicit `close` never close twice. */
  #closing: Promise<void> | undefined = undefined;

  private constructor(
    browser: RuntimeBrowser,
    options: ScrapeRunBrowserOptions,
    pageTimeoutMs: number,
  ) {
    this.#browser = browser;
    this.#userAgent = options.userAgent;
    this.#pageTimeoutMs = pageTimeoutMs;
    this.#signal = options.signal;
    this.#onAbort = () => {
      // Fire and forget: an `AbortSignal` listener cannot be awaited. The promise is kept in
      // `#closing`, so a later `close()` awaits this very teardown instead of starting a second one.
      void this.close();
    };
    options.signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  /**
   * Launches the headless Chromium of one Scrape_Run.
   *
   * @throws The abort reason of `options.signal` when the Scrape_Run is already cancelled. A browser
   *   that was launched in the meantime is closed again before the rejection, so a cancellation
   *   racing the launch leaves no process behind.
   */
  static async launch(options: ScrapeRunBrowserOptions): Promise<ScrapeRunBrowser> {
    options.signal.throwIfAborted();

    const launcher = options.launcher ?? (await defaultBrowserLauncher());
    const pageTimeoutMs = options.pageTimeoutMs ?? RESULT_PAGE_TIMEOUT_MS;
    const browser = await launcher.launch({ headless: true });
    const runBrowser = new ScrapeRunBrowser(browser, options, pageTimeoutMs);

    if (options.signal.aborted) {
      await runBrowser.close();
      options.signal.throwIfAborted();
    }

    return runBrowser;
  }

  /** The unchanged user agent every context of this browser sends (14.5). */
  get userAgent(): string {
    return this.#userAgent;
  }

  /** The per-Result_Page limit every page of this browser applies (6.2). */
  get pageTimeoutMs(): number {
    return this.#pageTimeoutMs;
  }

  /** Whether the teardown has started. A closed browser opens no further context. */
  get isClosed(): boolean {
    return this.#closing !== undefined;
  }

  /** The Platform that have a `BrowserContext` in this Scrape_Run, in creation order. */
  get platformsWithContext(): readonly Platform[] {
    return [...this.#contexts.keys()];
  }

  /**
   * Creates the `BrowserContext` of one Platform: fresh storage state, the Job_Tool user agent, the
   * resource filter, and the {@link PlatformQueue} that paces every load made through it.
   *
   * @throws A {@link PlatformContextExistsError} on a second call for the same Platform, and a
   *   {@link ScrapeRunBrowserClosedError} once the browser is closed.
   */
  async contextFor(options: PlatformContextOptions): Promise<PlatformBrowserContext> {
    this.#throwIfClosed();
    this.#signal.throwIfAborted();

    if (this.#contexts.has(options.platform)) {
      throw new PlatformContextExistsError(options.platform);
    }

    const context = await this.#browser.newContext({
      userAgent: this.#userAgent,
      // A context without cookies, local storage or a session: the fresh storage state of 8.4. Spelled
      // out rather than left to the default, because "no credentials are ever supplied" (7.1, 7.5) is
      // the point of it.
      storageState: undefined,
      // A service worker could answer a navigation from its own cache, which would hide what the
      // Platform actually served — including a sign-in wall or a bot check the adapter has to detect.
      serviceWorkers: 'block',
      // All four Platform render their result lists client-side, so JavaScript has to stay on (6.2).
      javaScriptEnabled: true,
    });

    await context.route(ALL_URLS_PATTERN, blockHeavyResources);

    const platformContext = new PlatformBrowserContext({
      context,
      platform: options.platform,
      pageTimeoutMs: this.#pageTimeoutMs,
      signal: this.#signal,
      queue: new PlatformQueue({
        platform: options.platform,
        crawlDelaySeconds: options.crawlDelaySeconds,
        clock: options.clock,
        sleep: options.sleep,
      }),
      onClosed: () => {
        this.#contexts.delete(options.platform);
      },
    });

    this.#contexts.set(options.platform, platformContext);

    return platformContext;
  }

  /**
   * Closes every page, every context and the browser, in that order. Idempotent, and concurrent
   * callers share the one teardown.
   *
   * Failures of the individual close calls are swallowed on purpose: a teardown runs in a `finally`
   * block and after a cancellation, where a page or a browser is frequently already gone. Letting
   * that replace the error that ended the Scrape_Run would hide the cause the Log_Stream needs.
   */
  async close(): Promise<void> {
    this.#closing ??= this.#teardown();

    return this.#closing;
  }

  async #teardown(): Promise<void> {
    this.#signal.removeEventListener('abort', this.#onAbort);

    const contexts = [...this.#contexts.values()];

    this.#contexts.clear();

    for (const context of contexts) {
      await context.close();
    }

    await ignoreFailure(() => this.#browser.close());
  }

  #throwIfClosed(): void {
    if (this.#closing !== undefined) {
      throw new ScrapeRunBrowserClosedError();
    }
  }
}

/**
 * Construction arguments of a {@link PlatformBrowserContext}.
 *
 * Exported because the constructor is part of the emitted declarations, not because a caller outside
 * {@link ScrapeRunBrowser.contextFor} is expected to build one.
 */
export interface PlatformBrowserContextArgs {
  readonly context: RuntimeBrowserContext;
  readonly platform: Platform;
  readonly pageTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly queue: PlatformQueue;
  readonly onClosed: () => void;
}

/**
 * The `BrowserContext` of exactly one Platform, together with that Platform's request queue.
 *
 * {@link PlatformBrowserContext.openPage} has the exact signature of `AdapterContext.openPage`, so
 * the Scraper_Service hands it over unwrapped and the adapter receives the pacing, the repetitions
 * and the page time limit without knowing that any of them exist.
 */
export class PlatformBrowserContext {
  readonly #context: RuntimeBrowserContext;

  readonly #platform: Platform;

  readonly #pageTimeoutMs: number;

  readonly #signal: AbortSignal;

  readonly #queue: PlatformQueue;

  readonly #onClosed: () => void;

  /** The pages opened and not yet closed, so the teardown of 8.4 reaches every one of them. */
  readonly #pages = new Set<QueuedAdapterPage>();

  #closed = false;

  constructor(args: PlatformBrowserContextArgs) {
    this.#context = args.context;
    this.#platform = args.platform;
    this.#pageTimeoutMs = args.pageTimeoutMs;
    this.#signal = args.signal;
    this.#queue = args.queue;
    this.#onClosed = args.onClosed;
  }

  /** The Platform this context belongs to. */
  get platform(): Platform {
    return this.#platform;
  }

  /** The queue every load of this context goes through (13.2, 13.4, 13.9, 14.4). */
  get queue(): PlatformQueue {
    return this.#queue;
  }

  /** Pages opened and not yet closed. Exposed so a test can assert the teardown left none. */
  get openPageCount(): number {
    return this.#pages.size;
  }

  /** Whether this context has been closed. */
  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Opens one page in this Platform's context.
   *
   * Bound as a field rather than declared as a method so it can be handed to
   * `AdapterContext.openPage` directly, with no wrapper closure that could lose the receiver.
   *
   * @throws A {@link ScrapeRunBrowserClosedError} once this context is closed, and the abort reason
   *   of the Scrape_Run when it has been cancelled (12.7, 13.6).
   */
  readonly openPage = async (): Promise<AdapterPage> => {
    if (this.#closed) {
      throw new ScrapeRunBrowserClosedError();
    }

    this.#signal.throwIfAborted();

    const page = await this.#context.newPage();
    const adapterPage = new QueuedAdapterPage({
      page,
      queue: this.#queue,
      pageTimeoutMs: this.#pageTimeoutMs,
      signal: this.#signal,
      onClosed: (closedPage) => {
        this.#pages.delete(closedPage);
      },
    });

    this.#pages.add(adapterPage);

    return adapterPage;
  };

  /**
   * Closes every page still open and then the context. Idempotent.
   *
   * The queue is closed first, so a load that is still waiting for its slot rejects instead of
   * reaching a Platform whose context is about to disappear.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#queue.close();

    const pages = [...this.#pages];

    this.#pages.clear();

    for (const page of pages) {
      await page.close();
    }

    await ignoreFailure(() => this.#context.close());
    this.#onClosed();
  }
}

/** Construction arguments of a {@link QueuedAdapterPage}. */
interface QueuedAdapterPageArgs {
  readonly page: RuntimePage;
  readonly queue: PlatformQueue;
  readonly pageTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly onClosed: (page: QueuedAdapterPage) => void;
}

/**
 * The {@link AdapterPage} port over a Playwright page.
 *
 * Every `load` is one queued page request: the queue waits for the single in-flight slot (13.9) and
 * for the remaining gap to the previous settling (13.2, 14.4), runs the navigation under the
 * per-page limit of 6.2, and repeats it up to three times while it fails retryably (13.4). A response
 * with any HTTP status counts as an answer and is returned unchanged — a reported rate limit (13.5),
 * a sign-in redirect (7.2) and a bot check (7.6) are observations the adapter has to make, not
 * transport failures the queue should repeat.
 */
class QueuedAdapterPage implements AdapterPage {
  readonly #page: RuntimePage;

  readonly #queue: PlatformQueue;

  readonly #pageTimeoutMs: number;

  readonly #signal: AbortSignal;

  readonly #onClosed: (page: QueuedAdapterPage) => void;

  #closed = false;

  constructor(args: QueuedAdapterPageArgs) {
    this.#page = args.page;
    this.#queue = args.queue;
    this.#pageTimeoutMs = args.pageTimeoutMs;
    this.#signal = args.signal;
    this.#onClosed = args.onClosed;
  }

  async load(url: string): Promise<AdapterPageResponse> {
    this.#throwIfClosed();

    return this.#queue.request(() => this.#navigate(url), this.#signal);
  }

  async html(): Promise<string> {
    this.#throwIfClosed();

    return this.#page.content();
  }

  async loadMore(selector: string): Promise<boolean> {
    this.#throwIfClosed();

    return this.#queue.request(() => this.#operatePagination(selector), this.#signal);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#onClosed(this);
    await ignoreFailure(() => this.#page.close());
  }

  /**
   * One pagination step: operate the control and wait for the document to grow (13.12).
   *
   * Growth of the serialised document is the observable rather than the control's own state, and
   * that is deliberate. A `load-more` button reports nothing reliable about whether its request
   * succeeded — Glassdoor's carries `data-loading` and `aria-live` and stays in the DOM either way —
   * so trusting it would let a retrieval loop on a control that answers with nothing. A document
   * that did not grow is the end of the result list, which is `false` and not a failure.
   *
   * An absent or disabled control is also `false`, checked before the click so a result list that
   * ended between the reading and this call is not a timeout.
   */
  async #operatePagination(selector: string): Promise<boolean> {
    this.#throwIfClosed();
    this.#signal.throwIfAborted();

    const control = this.#page.locator(selector);

    try {
      if ((await control.count()) === 0) {
        return false;
      }

      if (!(await control.isEnabled({ timeout: this.#pageTimeoutMs }))) {
        return false;
      }

      const before = (await this.#page.content()).length;

      await control.click({ timeout: this.#pageTimeoutMs });

      return await this.#waitForGrowth(before);
    } catch (error) {
      this.#signal.throwIfAborted();

      throw new RetryableRequestError(
        `The pagination control ${selector} did not yield a further block within ${String(this.#pageTimeoutMs)} ms.`,
        { cause: error },
      );
    }
  }

  /**
   * Polls the serialised document until it is longer than `before`, or the page limit of 6.2 expires.
   *
   * Polled rather than awaited through a Playwright wait helper, so the port stays at the three
   * locator members of 13.12 and so the runtime double in the tests needs no scripting engine. The
   * interval is short relative to the 2-second gap of 13.2, so it never becomes the thing that paces
   * a retrieval.
   */
  async #waitForGrowth(before: number): Promise<boolean> {
    const deadline = Date.now() + this.#pageTimeoutMs;

    for (;;) {
      this.#signal.throwIfAborted();

      if ((await this.#page.content()).length > before) {
        return true;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      await delay(PAGINATION_POLL_INTERVAL_MS);
    }
  }

  /**
   * One navigation attempt.
   *
   * A navigation that times out or fails at the transport level becomes a
   * {@link RetryableRequestError}, which is the only error the queue spends one of the three attempts
   * of 13.4 on. A cancelled Scrape_Run is rethrown as its own reason instead: cancellation is not a
   * Platform fault and must not consume an attempt (12.7, 13.6).
   */
  async #navigate(url: string): Promise<AdapterPageResponse> {
    this.#throwIfClosed();
    this.#signal.throwIfAborted();

    try {
      const response = await this.#page.goto(url, {
        timeout: this.#pageTimeoutMs,
        waitUntil: PAGE_WAIT_UNTIL,
      });

      if (response === null) {
        // A navigation Playwright answered without a main-document response, for example one served
        // from the back-forward cache. The page still has its URL and its DOM, so the adapter can
        // parse; the status is simply unknown.
        return { url: this.#page.url(), status: null, headers: {} };
      }

      return {
        url: response.url(),
        status: response.status(),
        headers: lowercaseHeaders(await response.allHeaders()),
      };
    } catch (error) {
      this.#signal.throwIfAborted();

      throw new RetryableRequestError(
        `The Result_Page ${url} did not load within ${String(this.#pageTimeoutMs)} ms.`,
        { cause: error },
      );
    }
  }

  #throwIfClosed(): void {
    if (this.#closed) {
      throw new ScrapeRunBrowserClosedError();
    }
  }
}

/**
 * Runs `use` with the browser of one Scrape_Run and closes every page, every context and the browser
 * afterwards, whatever `use` did (8.4).
 *
 * This is the intended entry point. Calling {@link ScrapeRunBrowser.launch} directly is permitted but
 * then the caller owns the `finally` block.
 */
export async function withScrapeRunBrowser<T>(
  options: ScrapeRunBrowserOptions,
  use: (browser: ScrapeRunBrowser) => Promise<T>,
): Promise<T> {
  const browser = await ScrapeRunBrowser.launch(options);

  try {
    return await use(browser);
  } finally {
    await browser.close();
  }
}

/** The single interception handler of a context: drops the heavy resource types, passes the rest. */
async function blockHeavyResources(route: RuntimeRoute): Promise<void> {
  if (BLOCKED_RESOURCE_TYPE_SET.has(route.request().resourceType())) {
    await route.abort();

    return;
  }

  await route.continue();
}

/** Response headers under lowercased names, so a header lookup needs no case handling. */
function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/** Runs a teardown step and swallows its failure; see {@link ScrapeRunBrowser.close}. */
async function ignoreFailure(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch {
    // Intentionally ignored: see the comment on ScrapeRunBrowser.close.
  }
}
