/**
 * Reading one Stepstone Result_Page: HTML plus the response that carried it, in — a classification and
 * the raw Job_Posting of that page, out.
 *
 * Pure and browser-free, which is the point of splitting Fetch from Normalize in the design: every rule
 * of 6.5, 6.7, 7.2, 7.6 and 13.5 that depends on *what the page says* is decided here and is therefore
 * testable against frozen HTML (task 9.3), while the adapter in `./index.ts` only sequences pages and
 * reports.
 *
 * Three deliberate boundaries:
 *
 * - **Raw values only.** The seven fields of {@link RawJobPosting} are returned exactly as the page
 *   showed them, with whitespace collapsed and absent fields as `null`. Field limits, ISO dates and the
 *   discard rule of 6.5 belong to the normalization stage (`../../normalize/normalize-posting.ts`), so
 *   they are implemented once for all four Platform rather than per adapter.
 * - **No DOM semantics.** The parser sees markup, not a rendered page, so "an overlay covering the
 *   result list" (7.2) is detected through the markers Stepstone renders for it, never through layout.
 * - **One decision, no side effects.** The reading reports what it found; the log entries and the
 *   Platform_Status come from the adapter, which knows the page number and the Result_Page URL.
 *
 * ## Status of the selectors
 *
 * The selector tables are ordered candidate lists: the first selector that matches anything wins
 * ({@link queryAllFirst}, {@link queryFirst}), so a Stepstone layout change is repaired by putting the
 * new selector in front rather than by rewriting the parser. They are written against the `data-at`
 * attributes Stepstone renders on its job cards and are *confirmed by the frozen fixtures of task 9.3*;
 * until then they are the best available reading of the Platform's markup. The `data-testid` variants
 * are kept as fallbacks because Stepstone serves both spellings depending on the rendering path.
 *
 * A selector set that no longer matches does not produce wrong data: a Result_Page that yields no
 * readable Job_Posting is reported as {@link ResultPageOutcome} `LAYOUT_UNKNOWN`, which is the
 * `PAGE_LAYOUT_UNKNOWN` of 6.7 — the requirement's answer to exactly this situation.
 */

import type { AdapterPageResponse, RawJobPosting } from '../../adapter/types.js';
import {
  attributeOf,
  collapseWhitespace,
  containsAnyPhrase,
  type HtmlNode,
  parseHtml,
  queryAllFirst,
  queryFirst,
  textOf,
} from '../html/html-document.js';

/**
 * What one Result_Page turned out to be.
 *
 * Every member maps onto exactly one Platform_Status in the adapter, which is why the set is closed and
 * why `EMPTY_RESULT_LIST` is told apart from `LAYOUT_UNKNOWN`: a search that legitimately matches
 * nothing is a completed retrieval (and the Web_App shows the "keine Treffer" hint of 2.8), whereas a
 * page that shows postings the parser cannot read is the layout change of 6.7.
 */
export type ResultPageOutcome =
  /** At least one readable Job_Posting was read. */
  | 'POSTINGS'
  /** Stepstone states that the search matched nothing. Not a failure. */
  | 'EMPTY_RESULT_LIST'
  /** Sign-in redirect, a covering sign-in overlay, or no postings plus a sign-in prompt (7.2). */
  | 'SIGN_IN_REQUIRED'
  /** A Captcha or bot check page (7.6). */
  | 'BOT_CHECK'
  /** The response reports an exceeded fetch rate (13.5). */
  | 'RATE_LIMITED'
  /** The Platform answered, but not with a result list: a server-side failure. */
  | 'UNREACHABLE'
  /** The page loaded and shows no readable Job_Posting and no explanation for it (6.7). */
  | 'LAYOUT_UNKNOWN';

/** What one Result_Page yielded. */
export interface ResultPageReading {
  readonly outcome: ResultPageOutcome;
  /**
   * Every Job_Posting read from the page, in page order, with raw values. Non-empty for a page that
   * also ended the retrieval, which is what keeps the Partial_Result of 7.7.
   */
  readonly postings: readonly RawJobPosting[];
  /**
   * How many of {@link postings} carry all three fields 6.5 requires — title, source URL and
   * Posting_Id. This, not `postings.length`, is the "readable Job_Posting" of 6.7: a card whose title
   * selector broke is present but unusable, and the normalization stage will discard it.
   */
  readonly readablePostingCount: number;
  /** Whether Stepstone offers a further Result_Page, which is what ends the pagination of 13.3. */
  readonly hasNextPage: boolean;
}

/** The input of {@link readStepstoneResultPage}. */
export interface ResultPageInput {
  /** The HTML of the Result_Page as the Platform served it. */
  readonly html: string;
  /** How the load answered, including the URL it ended on after a redirect (7.2). */
  readonly response: AdapterPageResponse;
}

/** The job cards of a Result_Page. The first selector that matches anything supplies all of them. */
export const CARD_SELECTORS = [
  '[data-at="job-item"]',
  '[data-testid="job-item"]',
  'article[data-genesis-element="CARD"]',
  'article[data-at="jobcard"]',
] as const;

/** Per-field selectors inside one job card, in candidate order. */
export const FIELD_SELECTORS = {
  title: ['[data-at="job-item-title"]', '[data-testid="job-item-title"]', 'h2 a', 'h2', 'h3 a'],
  link: [
    'a[data-at="job-item-title"]',
    'a[data-testid="job-item-title"]',
    'h2 a[href]',
    'a[href*="/stellenangebote"]',
    'a[href]',
  ],
  employer: [
    '[data-at="job-item-company-name"]',
    '[data-testid="job-item-company-name"]',
    '[data-at="job-item-company"]',
  ],
  workLocation: [
    '[data-at="job-item-location"]',
    '[data-at="job-item-work-location"]',
    '[data-testid="job-item-location"]',
  ],
  publishedAt: [
    '[data-at="job-item-timeago"]',
    '[data-testid="job-item-timeago"]',
    '[data-at="job-item-date"]',
    'time',
  ],
  description: [
    '[data-at="job-item-description"]',
    '[data-testid="job-item-description"]',
    '[data-at="jobcard-content"]',
  ],
} as const;

/** Card attributes that carry the Posting_Id directly, in candidate order. */
export const POSTING_ID_ATTRIBUTES = ['data-id', 'data-job-id', 'data-posting-id', 'id'] as const;

/** Elements that mean "there is a further Result_Page". */
export const NEXT_PAGE_SELECTORS = [
  '[data-at="pagination-next"]',
  '[data-testid="pagination-next"]',
  'link[rel="next"]',
  'a[rel="next"]',
  'a[aria-label*="Nächste"]',
] as const;

/** Markers Stepstone renders when a search matched nothing. */
export const EMPTY_RESULT_SELECTORS = [
  '[data-at="no-results"]',
  '[data-testid="no-results"]',
  '[data-at="search-no-results"]',
] as const;

/** Phrases that state an empty result list, for the case the markers above are absent. */
export const EMPTY_RESULT_PHRASES = [
  'keine passenden jobs',
  'keine stellenangebote gefunden',
  'keine jobs gefunden',
  'leider keine treffer',
  'keine ergebnisse gefunden',
] as const;

/**
 * Path fragments of a sign-in or registration page. Matched against the URL the load *ended* on, which
 * is how the redirect of 7.2 becomes visible without following anything.
 */
export const SIGN_IN_PATH_FRAGMENTS = [
  '/login',
  '/anmelden',
  '/signin',
  '/sign-in',
  '/registrieren',
  '/register',
  '/candidate/login',
  '/auth/',
] as const;

/** Markers of a sign-in or registration overlay covering the result list (7.2). */
export const SIGN_IN_OVERLAY_SELECTORS = [
  '[data-at="login-wall"]',
  '[data-at="registration-wall"]',
  '[data-at="signup-overlay"]',
  '[data-testid="login-wall"]',
  'dialog[data-at*="login"]',
] as const;

/**
 * Phrases that state the result list is only shown after sign-in.
 *
 * Deliberately long phrases rather than the bare word "Anmelden": every Stepstone page carries a
 * sign-in link in its header, so a short phrase would report `SIGN_IN_REQUIRED` for a perfectly
 * readable result list. They are only consulted when the page yielded no readable Job_Posting, which is
 * the third characteristic 7.2 names.
 */
export const SIGN_IN_PHRASES = [
  'nur nach anmeldung',
  'melde dich an, um',
  'melden sie sich an, um',
  'jetzt anmelden, um',
  'anmelden, um alle',
  'bitte anmelden, um',
  'kostenlos registrieren, um',
] as const;

/** Markers of a Captcha or bot check page (7.6). */
export const BOT_CHECK_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge"]',
  '#challenge-form',
  '#cf-challenge-running',
  '[data-at="captcha"]',
  'form[action*="captcha"]',
] as const;

/** Phrases of a Captcha or bot check page (7.6). */
export const BOT_CHECK_PHRASES = [
  'captcha',
  'sind sie ein mensch',
  'bist du ein mensch',
  'are you a human',
  'unusual traffic',
  'ungewöhnlicher datenverkehr',
  'zugriff verweigert',
  'access denied',
  'checking your browser',
] as const;

/** Phrases of a response that reports an exceeded fetch rate (13.5). */
export const RATE_LIMIT_PHRASES = [
  'too many requests',
  'zu viele anfragen',
  'rate limit',
  'abfragerate',
] as const;

/**
 * The header that names when a request may be repeated.
 *
 * Only read together with an unsuccessful status: `Retry-After` on a `503` is throttling, while the
 * `RateLimit-*` family is sent by some edges on *every* response, including successful ones, so the
 * mere presence of a rate-limit header says nothing. The exhausted-quota check below is the exception,
 * because a remaining count of exactly `0` does state the limit.
 */
export const RATE_LIMIT_HEADERS = ['retry-after'] as const;

/** Headers that report an exhausted quota when they read exactly `0`. */
export const REMAINING_QUOTA_HEADERS = ['x-ratelimit-remaining', 'ratelimit-remaining'] as const;

/**
 * Query parameters dropped from a posting's source URL.
 *
 * Stepstone appends a per-impression tracking parameter to every result link, so the same Job_Posting
 * yields a different URL on every Scrape_Run. Keeping it would change the stored source URL and the
 * Content_Hash of an unchanged posting on every run, which would defeat the hash gate of 15.4 and make
 * the "unchanged" case of the upsert unobservable. The Posting_Id and the path are what identify a
 * posting; these parameters identify the click.
 */
export const TRACKING_QUERY_PARAMS = [
  'rltr',
  'rtr',
  'intcid',
  'ssrc',
  'ssid',
  'suid',
  'gclid',
  'ef_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

/** HTTP status that reports an exceeded fetch rate. */
const STATUS_TOO_MANY_REQUESTS = 429;

/** HTTP status bot protection answers with when it refuses a request outright. */
const STATUS_FORBIDDEN = 403;

/** The lowest status that means the Platform itself failed rather than refused. */
const STATUS_SERVER_ERROR = 500;

/** The lowest status that is not a successful or redirected response. */
const STATUS_CLIENT_ERROR = 400;

/** A reading that carries no posting, for a page that was classified from its response alone. */
function withoutPostings(outcome: ResultPageOutcome): ResultPageReading {
  return { outcome, postings: [], readablePostingCount: 0, hasNextPage: false };
}

/** Whether any of `names` is present in the response headers. */
function hasAnyHeader(
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): boolean {
  return names.some((name) => headers[name] !== undefined);
}

/** Whether a quota header reports zero remaining requests. */
function reportsExhaustedQuota(headers: Readonly<Record<string, string>>): boolean {
  return REMAINING_QUOTA_HEADERS.some((name) => headers[name]?.trim() === '0');
}

/**
 * The classification a response alone already settles, or `null` to go on and read the HTML.
 *
 * The order is the order of the error table: a reported rate limit (13.5) outranks a refusal, because
 * `429` *is* the rate limit statement; a refusal outranks a server failure, because bot protection
 * answers `403`; everything from 500 up is the Platform failing to serve its result list, which is the
 * `PLATFORM_UNREACHABLE` of the table rather than a layout change.
 */
function classifyResponse(response: AdapterPageResponse): ResultPageOutcome | null {
  const status = response.status;
  const unsuccessful = status !== null && status >= STATUS_CLIENT_ERROR;

  if (
    status === STATUS_TOO_MANY_REQUESTS ||
    reportsExhaustedQuota(response.headers) ||
    (unsuccessful && hasAnyHeader(response.headers, RATE_LIMIT_HEADERS))
  ) {
    return 'RATE_LIMITED';
  }

  if (status === null) {
    return null;
  }

  if (status === STATUS_FORBIDDEN) {
    return 'BOT_CHECK';
  }

  if (status >= STATUS_SERVER_ERROR) {
    return 'UNREACHABLE';
  }

  if (status >= STATUS_CLIENT_ERROR) {
    // A 404 or 410 on a result list URL the adapter built itself means the URL shape no longer holds,
    // which is the same loss as a broken selector and is reported the same way (6.7).
    return 'LAYOUT_UNKNOWN';
  }

  return null;
}

/** Whether the load ended on a sign-in or registration page (the redirect of 7.2). */
function endedOnSignInPage(url: string): boolean {
  return containsAnyPhrase(url.toLowerCase(), SIGN_IN_PATH_FRAGMENTS);
}

/** Whether the element states that it is disabled, by attribute rather than by styling. */
function isDisabled(element: HtmlNode): boolean {
  return element.attribute('aria-disabled') === 'true' || element.attribute('disabled') !== null;
}

/**
 * Whether Stepstone offers a further Result_Page.
 *
 * A pagination control that is present but disabled, or an anchor without an `href`, is the last page:
 * Stepstone renders the "next" control on every page and marks it instead of removing it.
 */
function detectNextPage(document: HtmlNode): boolean {
  for (const selector of NEXT_PAGE_SELECTORS) {
    for (const element of document.queryAll(selector)) {
      if (isDisabled(element)) {
        continue;
      }

      if (element.tagName === 'a' && element.attribute('href') === null) {
        continue;
      }

      return true;
    }
  }

  return false;
}

/** The absolute source URL of a posting, with the tracking parameters of a result click removed. */
export function cleanPostingUrl(href: string, pageUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(href, pageUrl);
  } catch {
    // A `javascript:` link or a malformed href. There is no source URL to store, and 6.5 discards the
    // posting downstream.
    return null;
  }

  for (const parameter of TRACKING_QUERY_PARAMS) {
    url.searchParams.delete(parameter);
  }

  return url.toString();
}

/** Digit runs long enough to be a Stepstone posting number. */
const POSTING_NUMBER = /\d{4,}/gu;

/** The posting number Stepstone puts at the end of a job advertisement path. */
const INLINE_POSTING_NUMBER = /--(\d{4,})(?:-[a-z0-9]+)*\.html$/iu;

/**
 * The Posting_Id carried by a Stepstone job advertisement URL.
 *
 * Stepstone's advertisement paths read
 * `/stellenangebote--Projektmanagerin-Muenchen-Beispiel-GmbH--12345678-inline.html`, so the number
 * behind the last double hyphen is the identifier. Where that shape does not hold, the last long digit
 * run of the path is taken, which covers the shorter `/jobs/12345678` form.
 *
 * Only the path is searched, never the query string: a tracking parameter is full of long numbers that
 * change per impression, and a Posting_Id that changed per Scrape_Run would make the upsert of 9.4
 * insert a duplicate instead of updating.
 */
export function stepstonePostingIdFromUrl(url: string): string | null {
  let path: string;

  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }

  const inline = INLINE_POSTING_NUMBER.exec(path);

  if (inline?.[1] !== undefined) {
    return inline[1];
  }

  const numbers = path.match(POSTING_NUMBER);

  return numbers === null ? null : (numbers.at(-1) ?? null);
}

/** Digits of an element id such as `job-item-12345`. */
const ID_DIGITS = /\d{3,}/u;

/** The Posting_Id a card carries in one of its own attributes, or `null`. */
function postingIdFromCard(card: HtmlNode): string | null {
  for (const attribute of POSTING_ID_ATTRIBUTES) {
    const value = card.attribute(attribute);

    if (value === null) {
      continue;
    }

    if (/^\d+$/u.test(value)) {
      return value;
    }

    const digits = ID_DIGITS.exec(value);

    if (digits !== null) {
      return digits[0];
    }
  }

  return null;
}

/**
 * The publication date text of a card: the machine-readable `datetime` attribute where Stepstone
 * renders one, otherwise the visible relative text such as "vor 3 Tagen" (6.4).
 *
 * The attribute is preferred because it is unambiguous; the fallback is passed on unchanged, since
 * turning it into a date needs the Scrape_Run start time, which this layer deliberately does not have.
 */
function publishedAtTextOf(card: HtmlNode): string | null {
  return (
    attributeOf(card, ['time[datetime]', '[datetime]'], 'datetime') ??
    textOf(card, FIELD_SELECTORS.publishedAt)
  );
}

/** Whether a raw posting carries all three fields 6.5 requires, so it survives normalization. */
function isReadable(posting: RawJobPosting): boolean {
  return posting.title !== null && posting.sourceUrl !== null && posting.postingId !== null;
}

/** Whether a raw posting carries nothing at all, which means the element was not a job card. */
function isEmpty(posting: RawJobPosting): boolean {
  return Object.values(posting).every((value) => value === null);
}

/** One job card as a {@link RawJobPosting}. Every field is read independently, so one gap costs one field. */
function readCard(card: HtmlNode, pageUrl: string): RawJobPosting {
  const href = attributeOf(card, FIELD_SELECTORS.link, 'href');
  const sourceUrl = href === null ? null : cleanPostingUrl(href, pageUrl);

  return {
    postingId:
      postingIdFromCard(card) ?? (sourceUrl === null ? null : stepstonePostingIdFromUrl(sourceUrl)),
    title: textOf(card, FIELD_SELECTORS.title),
    employer: textOf(card, FIELD_SELECTORS.employer),
    workLocation: textOf(card, FIELD_SELECTORS.workLocation),
    publishedAtText: publishedAtTextOf(card),
    sourceUrl,
    descriptionText: textOf(card, FIELD_SELECTORS.description),
  };
}

/**
 * Reads one Stepstone Result_Page.
 *
 * Total over every input: any HTML, any status and any header set answer a {@link ResultPageReading}.
 * Nothing throws, because every failure this layer can observe already has a Platform_Status, and an
 * exception would instead end the retrieval as an unexpected error and lose the Partial_Result of 7.7.
 *
 * The classification order follows the error table, and the reason for it is that the characteristics
 * overlap: a bot check page carries a sign-in link, a sign-in wall carries no postings, and an empty
 * result list looks exactly like a broken selector unless the Platform says otherwise.
 *
 * 1. the response alone — reported rate limit, refusal, server failure, dead URL;
 * 2. a bot check (7.6), before anything else that reads the page, since a challenge page's text says
 *    nothing about the search;
 * 3. a sign-in redirect or a covering overlay (7.2), which hold whether or not postings were parsed;
 * 4. a rate limit stated in the page body;
 * 5. the job cards. At least one readable Job_Posting makes the page a result list;
 * 6. with no readable Job_Posting: an explicit "nothing matched" statement is an empty result list, a
 *    sign-in prompt is the third characteristic of 7.2, and anything else is the layout change of 6.7.
 */
export function readStepstoneResultPage(input: ResultPageInput): ResultPageReading {
  const fromResponse = classifyResponse(input.response);

  if (fromResponse !== null) {
    return withoutPostings(fromResponse);
  }

  const document = parseHtml(input.html);
  const pageText = document.text();

  if (
    queryFirst(document, BOT_CHECK_SELECTORS) !== null ||
    containsAnyPhrase(pageText, BOT_CHECK_PHRASES)
  ) {
    return withoutPostings('BOT_CHECK');
  }

  const hasNextPage = detectNextPage(document);

  if (
    endedOnSignInPage(input.response.url) ||
    queryFirst(document, SIGN_IN_OVERLAY_SELECTORS) !== null
  ) {
    return { ...withoutPostings('SIGN_IN_REQUIRED'), hasNextPage };
  }

  if (containsAnyPhrase(pageText, RATE_LIMIT_PHRASES)) {
    return { ...withoutPostings('RATE_LIMITED'), hasNextPage };
  }

  const postings = queryAllFirst(document, CARD_SELECTORS)
    .map((card) => readCard(card, collapseWhitespace(input.response.url)))
    .filter((posting) => !isEmpty(posting));
  const readablePostingCount = postings.filter(isReadable).length;

  if (readablePostingCount > 0) {
    return { outcome: 'POSTINGS', postings, readablePostingCount, hasNextPage };
  }

  const reading = { postings, readablePostingCount, hasNextPage };

  if (
    queryFirst(document, EMPTY_RESULT_SELECTORS) !== null ||
    containsAnyPhrase(pageText, EMPTY_RESULT_PHRASES)
  ) {
    return { ...reading, outcome: 'EMPTY_RESULT_LIST' };
  }

  if (containsAnyPhrase(pageText, SIGN_IN_PHRASES)) {
    return { ...reading, outcome: 'SIGN_IN_REQUIRED' };
  }

  return { ...reading, outcome: 'LAYOUT_UNKNOWN' };
}
