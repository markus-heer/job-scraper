/**
 * A hand-written double of the Playwright surface the runtime uses, plus a recorder.
 *
 * This is the reason `./playwright-port.ts` narrows Playwright instead of importing its types: the
 * runtime tests need to observe what the runtime asked the browser to do — which launch options, which
 * context options, which interception handler, which navigation with which timeout, and in which order
 * the teardown closed things — and they must do so without a downloaded Chromium, because `pnpm test`
 * has to run on a machine where the browser binaries were never fetched.
 *
 * Not a test file itself: the Vitest `include` pattern only collects `*.test.ts`.
 */

import type {
  RuntimeBrowser,
  RuntimeBrowserContext,
  RuntimeBrowserType,
  RuntimeContextOptions,
  RuntimeGotoOptions,
  RuntimeLaunchOptions,
  RuntimeLocator,
  RuntimePage,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeRoute,
} from '../playwright-port.js';

/** How the double answers one navigation. */
export type FakeNavigationOutcome =
  | {
      readonly kind: 'RESPONSE';
      readonly status: number;
      /** Header names exactly as a Platform would send them, mixed case included. */
      readonly headers?: Record<string, string>;
      /** The URL the navigation ended on, for a redirect. Defaults to the requested URL. */
      readonly endUrl?: string;
    }
  | { readonly kind: 'NULL'; readonly endUrl?: string }
  | { readonly kind: 'FAILURE'; readonly message: string };

/** One recorded navigation, with everything the runtime passed along. */
export interface NavigationRecord {
  readonly url: string;
  readonly timeout: number | undefined;
  readonly waitUntil: string | undefined;
}

/** What the double is told to do. Every field has a benign default. */
export interface FakeBrowserBehaviour {
  /**
   * The outcome of the n-th navigation, 1-based. Defaults to a plain 200 response.
   *
   * @param url The requested URL.
   * @param attempt How many navigations have been requested so far, including this one.
   */
  readonly navigate?: (url: string, attempt: number) => FakeNavigationOutcome;
  /** What `content()` returns before any pagination step. Defaults to a minimal document. */
  readonly html?: string;
  /** How the in-page pagination control of 13.12 behaves. Defaults to no control at all. */
  readonly pagination?: FakePaginationBehaviour;
  /** Makes `page.close()` fail, which the teardown has to survive. */
  readonly failPageClose?: boolean;
  /** Makes `browser.close()` fail, which the teardown has to survive. */
  readonly failBrowserClose?: boolean;
}

/**
 * How the scripted pagination control answers, so the `loadMore` paths of 13.12 are all reachable:
 * an absent control, a disabled one, a click that fails, and a click that grows the document or
 * does not.
 */
export interface FakePaginationBehaviour {
  /** How many elements the selector matches. 0 is an absent control. Defaults to 1. */
  readonly count?: number;
  /** Whether the control is enabled. Defaults to `true`. */
  readonly enabled?: boolean;
  /**
   * The document after the n-th click, 1-based. A click past the end of this list leaves the
   * document unchanged, which is the "claimed a block and delivered none" case.
   */
  readonly blocks?: readonly string[];
  /** Makes the n-th click throw, 1-based, so the retryable path is reachable. */
  readonly failClickAt?: number;
}

/** One operation of the pagination control, as the double observed it. */
export interface PaginationClickRecord {
  readonly selector: string;
  readonly timeout: number | undefined;
}

/** Everything the double observed, shared by the browser, its contexts and its pages. */
export class FakeBrowserRecorder {
  readonly launchOptions: (RuntimeLaunchOptions | undefined)[] = [];

  readonly contextOptions: (RuntimeContextOptions | undefined)[] = [];

  readonly routePatterns: string[] = [];

  /** The interception handlers the runtime installed, in installation order. */
  readonly routeHandlers: ((route: RuntimeRoute) => Promise<void> | void)[] = [];

  readonly navigations: NavigationRecord[] = [];

  /** Every pagination control operation of 13.12, in order. */
  readonly paginationClicks: PaginationClickRecord[] = [];

  /** The selectors `locator()` was called with, so the narrowness of the port is assertable. */
  readonly locatorSelectors: string[] = [];

  /** `close` calls in the order they happened, so the teardown order is assertable. */
  readonly closeOrder: ('page' | 'context' | 'browser')[] = [];

  get pageCloseCount(): number {
    return this.closeOrder.filter((entry) => entry === 'page').length;
  }

  get contextCloseCount(): number {
    return this.closeOrder.filter((entry) => entry === 'context').length;
  }

  get browserCloseCount(): number {
    return this.closeOrder.filter((entry) => entry === 'browser').length;
  }
}

const DEFAULT_HTML = '<html lang="de"><body><ol class="results"></ol></body></html>';

/** A double of Playwright's `chromium`. */
export class FakeBrowserType implements RuntimeBrowserType {
  readonly recorder: FakeBrowserRecorder;

  readonly #behaviour: FakeBrowserBehaviour;

  #navigationCount = 0;

  constructor(behaviour: FakeBrowserBehaviour = {}, recorder = new FakeBrowserRecorder()) {
    this.#behaviour = behaviour;
    this.recorder = recorder;
  }

  async launch(options?: RuntimeLaunchOptions): Promise<RuntimeBrowser> {
    this.recorder.launchOptions.push(options);

    return new FakeBrowser(this.#behaviour, this.recorder, () => {
      this.#navigationCount += 1;

      return this.#navigationCount;
    });
  }
}

/** The next navigation ordinal, shared across every page of the fake browser. */
type NextNavigation = () => number;

class FakeBrowser implements RuntimeBrowser {
  readonly #behaviour: FakeBrowserBehaviour;

  readonly #recorder: FakeBrowserRecorder;

  readonly #nextNavigation: NextNavigation;

  constructor(
    behaviour: FakeBrowserBehaviour,
    recorder: FakeBrowserRecorder,
    nextNavigation: NextNavigation,
  ) {
    this.#behaviour = behaviour;
    this.#recorder = recorder;
    this.#nextNavigation = nextNavigation;
  }

  async newContext(options?: RuntimeContextOptions): Promise<RuntimeBrowserContext> {
    this.#recorder.contextOptions.push(options);

    return new FakeBrowserContext(this.#behaviour, this.#recorder, this.#nextNavigation);
  }

  async close(): Promise<void> {
    this.#recorder.closeOrder.push('browser');

    if (this.#behaviour.failBrowserClose === true) {
      throw new Error('The fake browser refused to close.');
    }
  }
}

class FakeBrowserContext implements RuntimeBrowserContext {
  readonly #behaviour: FakeBrowserBehaviour;

  readonly #recorder: FakeBrowserRecorder;

  readonly #nextNavigation: NextNavigation;

  constructor(
    behaviour: FakeBrowserBehaviour,
    recorder: FakeBrowserRecorder,
    nextNavigation: NextNavigation,
  ) {
    this.#behaviour = behaviour;
    this.#recorder = recorder;
    this.#nextNavigation = nextNavigation;
  }

  async route(url: string, handler: (route: RuntimeRoute) => Promise<void> | void): Promise<void> {
    this.#recorder.routePatterns.push(url);
    this.#recorder.routeHandlers.push(handler);
  }

  async newPage(): Promise<RuntimePage> {
    return new FakePage(this.#behaviour, this.#recorder, this.#nextNavigation);
  }

  async close(): Promise<void> {
    this.#recorder.closeOrder.push('context');
  }
}

class FakePage implements RuntimePage {
  readonly #behaviour: FakeBrowserBehaviour;

  readonly #recorder: FakeBrowserRecorder;

  readonly #nextNavigation: NextNavigation;

  #currentUrl = 'about:blank';

  /** Clicks performed on the pagination control, whether or not they revealed a block. */
  #clickCount = 0;

  /** Clicks that were answered with a further document; see {@link FakePage.content}. */
  #revealedBlocks = 0;

  constructor(
    behaviour: FakeBrowserBehaviour,
    recorder: FakeBrowserRecorder,
    nextNavigation: NextNavigation,
  ) {
    this.#behaviour = behaviour;
    this.#recorder = recorder;
    this.#nextNavigation = nextNavigation;
  }

  async goto(url: string, options?: RuntimeGotoOptions): Promise<RuntimeResponse | null> {
    this.#recorder.navigations.push({
      url,
      timeout: options?.timeout,
      waitUntil: options?.waitUntil,
    });

    const attempt = this.#nextNavigation();
    const outcome = this.#behaviour.navigate?.(url, attempt) ?? { kind: 'RESPONSE', status: 200 };

    if (outcome.kind === 'FAILURE') {
      throw new Error(outcome.message);
    }

    this.#currentUrl = outcome.endUrl ?? url;

    if (outcome.kind === 'NULL') {
      return null;
    }

    const endUrl = this.#currentUrl;
    const headers = outcome.headers ?? {};

    return {
      url: () => endUrl,
      status: () => outcome.status,
      allHeaders: async () => headers,
    };
  }

  async content(): Promise<string> {
    const blocks = this.#behaviour.pagination?.blocks ?? [];
    // `#revealedBlocks` counts the clicks that were *answered* with a document, so the body served
    // after n steps is blocks[n - 1]; before the first step it is the plain `html`.
    const revealed = blocks[this.#revealedBlocks - 1];

    return revealed ?? this.#behaviour.html ?? DEFAULT_HTML;
  }

  locator(selector: string): RuntimeLocator {
    this.#recorder.locatorSelectors.push(selector);

    const pagination = this.#behaviour.pagination;

    return {
      count: async () => pagination?.count ?? (pagination === undefined ? 0 : 1),
      isEnabled: async () => pagination?.enabled ?? true,
      click: async (options) => {
        this.#clickCount += 1;
        this.#recorder.paginationClicks.push({ selector, timeout: options?.timeout });

        if (pagination?.failClickAt === this.#clickCount) {
          throw new Error(
            `The fake pagination control failed on click ${String(this.#clickCount)}.`,
          );
        }

        // A click is only *answered* where the script has a further document for it. Beyond that the
        // document stays as it is, which is what `loadMore` reports as the end of the result list.
        if (this.#clickCount <= (pagination?.blocks?.length ?? 0)) {
          this.#revealedBlocks = this.#clickCount;
        }
      },
    };
  }

  url(): string {
    return this.#currentUrl;
  }

  async close(): Promise<void> {
    this.#recorder.closeOrder.push('page');

    if (this.#behaviour.failPageClose === true) {
      throw new Error('The fake page refused to close.');
    }
  }
}

/** A double of one intercepted request, recording whether it was dropped or let through. */
export class FakeRoute implements RuntimeRoute {
  readonly resourceType: string;

  aborted = false;

  continued = false;

  constructor(resourceType: string) {
    this.resourceType = resourceType;
  }

  request(): RuntimeRequest {
    return { resourceType: () => this.resourceType };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async continue(): Promise<void> {
    this.continued = true;
  }
}
