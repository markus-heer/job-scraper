/**
 * The slice of Playwright the Scrape_Run runtime actually uses, as structural types.
 *
 * Why not import Playwright's own types here: the runtime is the only module in the package that
 * touches a browser, and the handful of calls it makes (`launch`, `newContext`, `route`, `newPage`,
 * `goto`, `content`, `close`) is small enough to write down. Writing it down buys two things:
 *
 * - the runtime unit tests drive a hand-written double, so they neither launch Chromium nor need a
 *   downloaded browser binary, which keeps `pnpm test` free of a 150 MB prerequisite;
 * - the surface the runtime is permitted to use is visible. There is no `click`, no `fill` and no
 *   `type` in these types, so the prohibition of 7.5 and 7.6 — never fill or submit a sign-in or
 *   registration form, never answer a Captcha — is a property of the type, not of a review comment.
 *
 * The types are kept *narrower* than Playwright's, never wider, and {@link defaultBrowserLauncher}
 * returns the real `chromium` as a {@link RuntimeBrowserType}. That return type is the compile-time
 * check that the narrowing is still a faithful subset: if Playwright changes one of these signatures,
 * `pnpm check-types` fails here rather than at runtime in a Scrape_Run.
 */

/** The response of a main-document navigation, as far as the runtime reads it. */
export interface RuntimeResponse {
  /** The URL the navigation ended on, which differs from the requested one after a redirect (7.2). */
  url(): string;
  status(): number;
  /** Response headers with lowercased names. */
  allHeaders(): Promise<Record<string, string>>;
}

/** The request behind an intercepted route, as far as the resource filter reads it. */
export interface RuntimeRequest {
  /** Playwright's resource type, for example `document`, `image` or `stylesheet`. */
  resourceType(): string;
}

/** One intercepted request, which the resource filter either drops or lets through. */
export interface RuntimeRoute {
  request(): RuntimeRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

/** The navigation options the runtime passes; a wider set is accepted and ignored. */
export interface RuntimeGotoOptions {
  /** The per-Result_Page limit of 6.2 and 13.4, in milliseconds. */
  readonly timeout?: number;
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

/** One browser page. Deliberately without any input-performing method; see the file comment. */
export interface RuntimePage {
  goto(url: string, options?: RuntimeGotoOptions): Promise<RuntimeResponse | null>;
  /** The current DOM serialised to HTML, which is the input of an adapter's parser. */
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

/** The `BrowserContext` options the runtime sets; see `browser.ts` for why each one is set. */
export interface RuntimeContextOptions {
  readonly userAgent?: string;
  /** `undefined` means a context without cookies or storage, which is the fresh state of 8.4. */
  readonly storageState?: undefined;
  readonly serviceWorkers?: 'allow' | 'block';
  readonly javaScriptEnabled?: boolean;
}

/** One `BrowserContext`: exactly one per Platform and Scrape_Run. */
export interface RuntimeBrowserContext {
  /**
   * Installs a request interception handler. The runtime installs exactly one, matching every URL,
   * which drops the heavy resource types listed in `browser.ts`.
   *
   * The result is `unknown` because Playwright resolves this with a handle for removing the route
   * again, which the runtime never needs: the handler lives exactly as long as its context.
   */
  route(url: string, handler: (route: RuntimeRoute) => Promise<void> | void): Promise<unknown>;
  newPage(): Promise<RuntimePage>;
  close(): Promise<void>;
}

/** One browser process: exactly one per Scrape_Run, shared by every Platform_Adapter. */
export interface RuntimeBrowser {
  newContext(options?: RuntimeContextOptions): Promise<RuntimeBrowserContext>;
  close(): Promise<void>;
}

/** The launch options the runtime sets. Headless is not negotiable: no Scrape_Run shows a window. */
export interface RuntimeLaunchOptions {
  readonly headless?: boolean;
}

/** What launches the one browser of a Scrape_Run. In production this is Playwright's `chromium`. */
export interface RuntimeBrowserType {
  launch(options?: RuntimeLaunchOptions): Promise<RuntimeBrowser>;
}

/**
 * Playwright's Chromium, as a {@link RuntimeBrowserType}.
 *
 * Imported dynamically for two reasons: the runtime tests inject their own launcher and then never
 * pay for loading the library, and the API_Service can start, validate its configuration and serve
 * the Web_App without Playwright being loaded at all — the browser is needed by a Scrape_Run, not by
 * startup. Chromium is the engine Requirement 6.2 and the design name.
 */
export async function defaultBrowserLauncher(): Promise<RuntimeBrowserType> {
  const { chromium } = await import('playwright');

  return chromium;
}
