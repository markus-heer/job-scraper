/**
 * The slice of Playwright the Scrape_Run runtime actually uses, as structural types.
 *
 * Why not import Playwright's own types here: the runtime is the only module in the package that
 * touches a browser, and the handful of calls it makes (`launch`, `newContext`, `route`, `newPage`,
 * `goto`, `content`, `close`) is small enough to write down. Writing it down buys two things:
 *
 * - the runtime unit tests drive a hand-written double, so they neither launch Chromium nor need a
 *   downloaded browser binary, which keeps `pnpm test` free of a 150 MB prerequisite;
 * - the surface the runtime is permitted to use is visible. There is no `fill` and no `type` in
 *   these types, so the prohibition of 7.5 — never fill or submit a sign-in or registration form,
 *   never supply a credential — is a property of the type rather than of a review comment.
 *
 * ## Where the no-interaction guarantee lives now
 *
 * Until 13.12 this file had no `click` either, and that was the whole argument for 7.5 and 7.6. It
 * has one now, because a Platform that paginates through a `load-more` control leaves the rest of
 * its result list reachable in no other way, and 13.3 asks for the result list to be read to its
 * end.
 *
 * The guarantee therefore moved up one layer rather than being dropped, and it is worth knowing
 * exactly where it sits: **no Platform_Adapter can reach these types.** An adapter sees `AdapterPage`
 * (`../adapter/types.ts`), whose only interactive member is `loadMore(selector)` — one step of a
 * result list it is already reading, reporting whether the document grew. There is no `click` an
 * adapter can aim at a sign-in button, a consent dialog or a Captcha, and the three narrowed members
 * of {@link RuntimeLocator} are all a `loadMore` implementation needs.
 *
 * So 7.5 and 7.6 are still type-level properties, now of `AdapterPage`; `RuntimeLocator` is the
 * private means by which the runtime honours `loadMore`. A sign-in wall and a bot check are *ended*
 * where they are detected (7.2, 7.6, 7.8), never clicked through, and no code path in this package
 * operates a control on a page that was classified as either.
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

/** The options a locator call of the pagination step passes. */
export interface RuntimeLocatorOptions {
  readonly timeout?: number;
}

/**
 * One element selection, narrowed to the three questions the pagination step of 13.12 asks.
 *
 * Reachable only from this package's runtime, never from a Platform_Adapter; see the file comment
 * for why that distinction carries the 7.5 and 7.6 guarantees.
 */
export interface RuntimeLocator {
  /** How many elements the selector matches. 0 means the control is absent: end of the result list. */
  count(): Promise<number>;
  /** Whether the first match is enabled. A disabled control is also the end of the result list. */
  isEnabled(options?: RuntimeLocatorOptions): Promise<boolean>;
  /** Operates the control, which is the one interaction the Job_Tool performs (13.12). */
  click(options?: RuntimeLocatorOptions): Promise<void>;
}

/** One browser page. Without `fill` or `type`, and with `locator` only; see the file comment. */
export interface RuntimePage {
  goto(url: string, options?: RuntimeGotoOptions): Promise<RuntimeResponse | null>;
  /** The current DOM serialised to HTML, which is the input of an adapter's parser. */
  content(): Promise<string>;
  /** Selects the pagination control of 13.12. The only element access the runtime performs. */
  locator(selector: string): RuntimeLocator;
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

/**
 * The launch options the runtime sets.
 *
 * `headless: false` is the production value since 14.13: the Scrape_Run shows its window, because
 * the single user starts each run by hand at this machine and 14.13 asks them to be able to watch it
 * and to end it by closing the window. An earlier revision launched headless and called it
 * non-negotiable; that was a decision about an unattended crawler, which this is not.
 */
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
