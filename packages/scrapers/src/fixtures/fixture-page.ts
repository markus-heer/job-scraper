/**
 * The {@link AdapterPage} port over a {@link FixtureServer}, so a Platform_Adapter parser can be
 * tested with no browser and no network (design, Testing Strategy).
 *
 * The adapter builds its Result_Page URL from the effective Search_Profile, which points at the real
 * Platform host — that is its job, and 14.7 documents those paths. A parser test must not send that
 * request anywhere, so this page rewrites the URL onto the fixture server while keeping the path, the
 * query and the fragment: the adapter still builds, paginates and resolves exactly as it does in
 * production, and the bytes come from a frozen file.
 *
 * What it reproduces of the production page (`../runtime/browser.ts`):
 *
 * - a response with a status and lowercased headers, so the rate-limit signals of 13.5 and the
 *   sign-in redirect of 7.2 are observable;
 * - the per-Result_Page time limit of 6.2, which turns into the {@link RetryableRequestError} the
 *   PlatformQueue spends one of the three attempts of 13.4 on — exercised against
 *   {@link NEVER_RESPONDING_PATH};
 * - the cancellation behaviour of 12.7 and 13.6: an aborted Scrape_Run rethrows its own reason and
 *   never consumes an attempt;
 * - optionally the PlatformQueue itself, so a test that asserts the 2-second gap of 13.2 or the
 *   crawl-delay of 14.4 drives the same queue the runtime uses.
 *
 * What it deliberately does not reproduce: JavaScript execution. {@link FixtureAdapterPage.html}
 * returns the served document, not a rendered DOM. A parser test is about selectors over frozen
 * markup; whether a Platform renders client-side is a question for the `@live` smoke test of 9.5.
 */

import {
  type AdapterPage,
  type AdapterPageResponse,
  RESULT_PAGE_TIMEOUT_MS,
} from '../adapter/types.js';
import { type PlatformQueue, RetryableRequestError } from '../scheduling/platform-queue.js';
import { NEVER_RESPONDING_PATH } from './fixture-server.js';

/** The part of a `fetch` response this page reads; the global `fetch` satisfies the port. */
export interface FixtureFetchResponse {
  readonly status: number;
  /** The URL the response came from, after any redirect (7.2). */
  readonly url: string;
  readonly headers: { get: (name: string) => string | null } & Iterable<[string, string]>;
  text: () => Promise<string>;
}

/** The injected retrieval function. Production of this module is a test, so `fetch` is the default. */
export type FixtureFetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<FixtureFetchResponse>;

/** One load this page performed, so a test can assert pagination and the page budget of 13.3. */
export interface FixtureLoadRecord {
  /** The URL the adapter asked for, that is the real Platform URL it built. */
  readonly requestedUrl: string;
  /** The URL that was actually retrieved, on the fixture server. */
  readonly fixtureUrl: string;
  readonly status: number;
}

/** Construction arguments of a {@link FixtureAdapterPage}. */
export interface FixturePageOptions {
  /** Origin of the fixture server, for example `server.origin`. */
  readonly origin: string;
  /** The per-Result_Page limit. Defaults to {@link RESULT_PAGE_TIMEOUT_MS} (6.2); tests shorten it. */
  readonly timeoutMs?: number;
  /** Cancellation of the surrounding run (12.7, 13.6). */
  readonly signal?: AbortSignal;
  /** The retrieval function. Defaults to the global `fetch`. */
  readonly fetch?: FixtureFetch;
  /**
   * The queue every load goes through. Optional: a plain parser test needs no pacing, while a test
   * of 13.2, 13.4 or 14.4 passes a queue with a virtual clock and reads the gaps off it.
   */
  readonly queue?: PlatformQueue;
  /** Maps the URL the adapter built onto the fixture server. Defaults to {@link rewriteToOrigin}. */
  readonly rewrite?: (requestedUrl: string) => string;
  /** The user agent the request carries, so a test can assert 14.5 against `server.requests`. */
  readonly userAgent?: string;
}

/**
 * Keeps path, query and fragment and swaps the origin for the fixture server's.
 *
 * @param origin The fixture server origin.
 * @returns A rewrite function; a value that is no URL is passed through unchanged, so a test may also
 *   hand a bare path to {@link FixtureAdapterPage.load}.
 */
export function rewriteToOrigin(origin: string): (requestedUrl: string) => string {
  return (requestedUrl) => {
    try {
      const requested = new URL(requestedUrl, origin);
      const target = new URL(origin);

      requested.protocol = target.protocol;
      requested.host = target.host;

      return requested.toString();
    } catch {
      return requestedUrl;
    }
  };
}

/** The {@link AdapterPage} a parser test hands to an adapter. */
export class FixtureAdapterPage implements AdapterPage {
  readonly #origin: string;

  readonly #timeoutMs: number;

  readonly #signal: AbortSignal | undefined;

  readonly #fetch: FixtureFetch;

  readonly #queue: PlatformQueue | undefined;

  readonly #rewrite: (requestedUrl: string) => string;

  readonly #userAgent: string | undefined;

  readonly #loads: FixtureLoadRecord[] = [];

  #html: string | undefined;

  #closed = false;

  constructor(options: FixturePageOptions) {
    this.#origin = options.origin;
    this.#timeoutMs = options.timeoutMs ?? RESULT_PAGE_TIMEOUT_MS;
    this.#signal = options.signal;
    this.#fetch = options.fetch ?? defaultFixtureFetch;
    this.#queue = options.queue;
    this.#rewrite = options.rewrite ?? rewriteToOrigin(options.origin);
    this.#userAgent = options.userAgent;
  }

  /** Every load this page performed, in order. */
  get loads(): readonly FixtureLoadRecord[] {
    return this.#loads;
  }

  /** The URL of the route that is never answered, for the timeout path of 6.2 and 13.4. */
  get neverRespondingUrl(): string {
    return new URL(NEVER_RESPONDING_PATH, this.#origin).toString();
  }

  async load(url: string): Promise<AdapterPageResponse> {
    this.#throwIfClosed();

    if (this.#queue === undefined) {
      return this.#retrieve(url);
    }

    return this.#queue.request(() => this.#retrieve(url), this.#signal);
  }

  async html(): Promise<string> {
    this.#throwIfClosed();

    if (this.#html === undefined) {
      throw new Error('The fixture page has not loaded a Result_Page yet, so it has no HTML.');
    }

    return this.#html;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /**
   * One retrieval attempt against the fixture server.
   *
   * @throws A {@link RetryableRequestError} when the response did not arrive within the page limit or
   *   the transport failed, and the abort reason of the run when it was cancelled meanwhile.
   */
  async #retrieve(url: string): Promise<AdapterPageResponse> {
    this.#signal?.throwIfAborted();

    const fixtureUrl = this.#rewrite(url);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`The fixture page ${fixtureUrl} exceeded the page time limit.`));
    }, this.#timeoutMs);
    const forwardAbort = (): void => {
      controller.abort(this.#signal?.reason);
    };

    this.#signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const response = await this.#fetch(fixtureUrl, {
        headers: this.#userAgent === undefined ? {} : { 'user-agent': this.#userAgent },
        signal: controller.signal,
      });

      this.#html = await response.text();
      this.#loads.push({ requestedUrl: url, fixtureUrl, status: response.status });

      return {
        url: response.url,
        status: response.status,
        headers: collectHeaders(response.headers),
      };
    } catch (error) {
      this.#signal?.throwIfAborted();

      throw new RetryableRequestError(
        `The Result_Page ${fixtureUrl} did not load within ${String(this.#timeoutMs)} ms.`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      this.#signal?.removeEventListener('abort', forwardAbort);
    }
  }

  #throwIfClosed(): void {
    if (this.#closed) {
      throw new Error('The fixture page is closed.');
    }
  }
}

/** A fixture page factory with the exact signature of `AdapterContext.openPage`. */
export interface FixturePageFactory {
  /** Hand this to `AdapterContext.openPage`. */
  readonly openPage: () => Promise<AdapterPage>;
  /** The pages opened so far, so a test can read their load records. */
  readonly pages: readonly FixtureAdapterPage[];
}

/**
 * Builds the `openPage` an {@link AdapterContext} needs for a fixture-backed run.
 *
 * Every call opens a fresh page, as the production runtime does, and the pages stay reachable through
 * {@link FixturePageFactory.pages} so an assertion over all loads of a run does not depend on how
 * many pages the adapter opened.
 */
export function createFixturePageFactory(options: FixturePageOptions): FixturePageFactory {
  const pages: FixtureAdapterPage[] = [];

  return {
    pages,
    openPage: async () => {
      const page = new FixtureAdapterPage(options);

      pages.push(page);

      return page;
    },
  };
}

/** Response headers under lowercased names, matching what the production page returns. */
function collectHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  return Object.fromEntries([...headers].map(([name, value]) => [name.toLowerCase(), value]));
}

/** The default retrieval: the global `fetch`, which satisfies {@link FixtureFetch}. */
const defaultFixtureFetch: FixtureFetch = (url, init) => fetch(url, init);
