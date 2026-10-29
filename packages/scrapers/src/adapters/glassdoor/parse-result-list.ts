/**
 * Reading one Glassdoor Result_Page: HTML plus the response that carried it, in — a classification and
 * the raw Job_Posting of that page, out.
 *
 * Pure and browser-free, which is the point of splitting Fetch from Normalize in the design: every rule
 * of 6.5, 6.7, 7.2, 7.6 and 13.5 that depends on *what the page says* is decided here and is therefore
 * testable against frozen HTML (task 23.3), while the adapter in `./index.ts` only sequences pages and
 * reports.
 *
 * Three deliberate boundaries, the same ones the Stepstone and Jobvector readers hold:
 *
 * - **Raw values only.** The seven fields of {@link RawJobPosting} are returned exactly as the page
 *   showed them, with whitespace collapsed and absent fields as `null`. Field limits, ISO dates, the
 *   discard rule of 6.5 and the "mark as empty" rule of 6.8 are applied once, by the normalization
 *   stage, so they are implemented once for all four Platform rather than per adapter.
 * - **No DOM semantics.** The parser sees markup, not a rendered page, so "an overlay covering the
 *   result list" (7.2) is detected through the markers Glassdoor renders for it, never through layout.
 * - **One decision, no side effects.** The reading reports what it found; the log entries and the
 *   Platform_Status come from the adapter, which knows the page number and the Result_Page URL.
 *
 * ## What is different about Glassdoor: the block is the expected outcome
 *
 * The design's risk note is explicit that Glassdoor operates aggressive bot protection and commonly
 * answers an automated browser — especially one that honestly identifies itself as a tool, which 14.5
 * mandates — with a Captcha, a sign-in wall or an empty result list. A permanent Platform_Status
 * `PLATFORM_BLOCKED` or `SIGN_IN_REQUIRED` is therefore a realistic and accepted outcome of this
 * adapter rather than a defect in it.
 *
 * The one capture that has been attempted did *not* hit it: on 2026-10-29 glassdoor.de answered the
 * honest Job_Tool user agent with HTTP 200 and a full result list. That is one request on one day from
 * one address and it establishes nothing about the next one. The three guarantees below are what the
 * requirements ask for either way, and the `sign-in-wall` and `captcha` fixtures are hand-authored
 * precisely because the Platform did not serve either of them.
 *
 * Three consequences are structural in this file:
 *
 * 1. **A Captcha is recognised and reported, never answered.** {@link BOT_CHECK_SELECTORS} and
 *    {@link BOT_CHECK_PHRASES} only *detect*; there is no code here or in `./index.ts` that submits a
 *    challenge form, reads a challenge token or follows a challenge redirect (7.6).
 * 2. **No sign-in form is filled and no credential exists to fill it with** (7.1, 7.5). A sign-in wall
 *    is likewise only detected, from the URL the load ended on and from the markers of the wall.
 * 3. **The bot check is classified before anything else that reads the page.** A challenge page carries
 *    a sign-in link and no job cards, so reading it in any other order would report the wrong cause.
 *
 * The honest limit of the third situation the risk note names: a result list that is empty *because* the
 * Platform decided not to serve one to this client is indistinguishable, in the markup, from a search
 * that legitimately matched nothing. The reader therefore reports what the page says — an explicit
 * "nothing matched" statement is `EMPTY_RESULT_LIST`, a page with neither postings nor an explanation is
 * the `LAYOUT_UNKNOWN` of 6.7 — and does not guess at a block it cannot see.
 *
 * ## Status of the selectors
 *
 * The selector tables are ordered candidate lists: the first selector that matches anything wins
 * ({@link queryAllFirst}, {@link queryFirst}), so a Glassdoor layout change is repaired by putting the
 * new selector in front rather than by rewriting the parser.
 *
 * **Confirmed against the capture of 2026-10-29** (`__fixtures__/result-list-page-1.html`, HTTP 200)
 * for the six selectors that carry a result list: `[data-test="jobListing"]` found all 30 cards, and
 * `job-title`, `emp-location`, `descSnippet` and `job-age` each matched on every one of them. Three
 * things the capture corrected or qualified:
 *
 * - **The employer is read by the third candidate, not the first.** Glassdoor renders no
 *   `[data-test="emp-name"]`; the name sits in `[class*="EmployerProfile_compactEmployerName"]`. The
 *   candidate list did its job, and the `data-test` candidates stay in front as the more stable shape
 *   should Glassdoor reintroduce one.
 * - **The link candidate order was wrong and is fixed.** See the comment on
 *   {@link FIELD_SELECTORS.link}.
 * - **No microdata at all.** The captured page carries no `itemtype`, no `itemprop` and no `datetime`
 *   attribute, so every schema.org candidate and the whole machine-readable date path of
 *   {@link publishedAtTextOf} were unmatched. They are kept as fallbacks, and the hand-authored
 *   `relative-dates` fixture is what exercises them.
 *
 * What the captured page states as a publication date is Glassdoor's own compact day count — `2T`,
 * `10T`, `30T+` — and nothing else. That wording is **not** in the vocabulary of
 * `../../normalize/parse-publication-date.ts`, so a Glassdoor posting currently takes the 6.9 path: the
 * publication date is marked as empty and the `posting.publicationDateUnparsable` note is written.
 * Adding the wording there is a change to the shared normalization layer and belongs with the parser
 * tests of task 23.3; the fixtures keep the raw text, so it needs no re-capture.
 *
 * The `data-test` attributes lead every table on purpose: Glassdoor renders its job cards with
 * CSS-module class names carrying a build hash (`JobsList_jobListItem__wjTHv`), which changes with every
 * deployment, while `data-test` is what its own test suite selects on and is therefore the more stable
 * of the two. The class-based candidates behind them are matched by *prefix* (`[class*="JobCard_"]`) for
 * the same reason. The schema.org microdata candidates sit between the two as the published-contract
 * fallback.
 *
 * A selector set that no longer matches does not produce wrong data: a Result_Page that yields no
 * readable Job_Posting is reported as {@link ResultPageOutcome} `LAYOUT_UNKNOWN`, which is the
 * `PAGE_LAYOUT_UNKNOWN` of 6.7.
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
  /** Glassdoor states that the search matched nothing. Not a failure. */
  | 'EMPTY_RESULT_LIST'
  /** Sign-in redirect, a covering sign-in overlay, or no postings plus a sign-in prompt (7.2). */
  | 'SIGN_IN_REQUIRED'
  /** A Captcha or bot check page, left unanswered (7.6). */
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
  /** Whether Glassdoor offers a further Result_Page, which is what ends the pagination of 13.3. */
  readonly hasNextPage: boolean;
}

/** The input of {@link readGlassdoorResultPage}. */
export interface ResultPageInput {
  /** The HTML of the Result_Page as the Platform served it. */
  readonly html: string;
  /** How the load answered, including the URL it ended on after a redirect (7.2). */
  readonly response: AdapterPageResponse;
}

/** The job cards of a Result_Page. The first selector that matches anything supplies all of them. */
export const CARD_SELECTORS = [
  '[data-test="jobListing"]',
  '[data-test="job-card"]',
  'li[class*="JobsList_jobListItem"]',
  'li.react-job-listing',
  '[itemtype*="JobPosting"]',
  'li[data-jobid]',
  'li[data-id]',
] as const;

/** Per-field selectors inside one job card, in candidate order. */
export const FIELD_SELECTORS = {
  title: [
    '[data-test="job-title"]',
    '[data-test="jobTitle"]',
    'a[class*="JobCard_jobTitle"]',
    '[itemprop="title"]',
    'h2 a',
    'h3 a',
    '.jobTitle',
  ],
  // The title anchor leads, and the capture of 2026-10-29 is why. Glassdoor renders *two* anchors per
  // card: `a[data-test="job-title"]`, whose `href` is the advertisement itself
  // (`/job-listing/…-JV_IC2610266_KO0,36_KE37,42.htm?jl=1010299809793`), and an empty overlay anchor
  // `a[data-test="job-link"]`, whose `href` is `/partner/jobListing.htm` plus nothing but the
  // per-impression click parameters of `TRACKING_QUERY_PARAMS`. Reading the second one first left all
  // 30 postings of the captured page with the same source URL — `/partner/jobListing.htm` with an
  // empty query — which no user could have opened and which carries no Posting_Id either. It is kept
  // as a later candidate, because the `href` is Glassdoor's own and a redesign may move the
  // advertisement URL back onto it.
  link: [
    'a[data-test="job-title"]',
    'a[class*="JobCard_jobTitle"]',
    'a[data-test="job-link"]',
    'a[itemprop="url"]',
    'a[href*="/job-listing/"]',
    'a[href*="/partner/jobListing"]',
    'a[href*="/Job/"]',
    'a[href]',
  ],
  employer: [
    '[data-test="emp-name"]',
    '[data-test="employer-short-name"]',
    '[class*="EmployerProfile_compactEmployerName"]',
    '[class*="JobCard_companyName"]',
    '[itemprop="hiringOrganization"] [itemprop="name"]',
    '.employerName',
  ],
  workLocation: [
    '[data-test="emp-location"]',
    '[data-test="location"]',
    '[class*="JobCard_location"]',
    '[itemprop="jobLocation"] [itemprop="addressLocality"]',
    '[itemprop="addressLocality"]',
    '.loc',
  ],
  publishedAt: [
    '[data-test="job-age"]',
    '[class*="JobCard_listingAge"]',
    '[itemprop="datePosted"]',
    'time',
    '.job-age',
  ],
  description: [
    '[data-test="descSnippet"]',
    '[class*="JobCard_jobDescriptionSnippet"]',
    '[itemprop="description"]',
    '.jobDescriptionContent',
    '.job-snippet',
  ],
} as const;

/** Card attributes that carry the Posting_Id directly, in candidate order. */
export const POSTING_ID_ATTRIBUTES = [
  'data-jobid',
  'data-job-id',
  'data-id',
  'data-joblistingid',
  'id',
] as const;

/**
 * Query parameters of a job advertisement URL that *are* the Posting_Id, in candidate order.
 *
 * Read before the path, because it is the only shape that is unambiguous: Glassdoor serves part of its
 * advertisement links as `/job-listing/…?jl=1009123456789` and its partner links as
 * `/partner/jobListing.htm?jobListingId=1009123456789`. Spelled out as an allow-list rather than "any
 * numeric parameter", because a Glassdoor result link is full of long tracking numbers that change per
 * impression, and a Posting_Id that changed per Scrape_Run would make the upsert of 9.4 insert a
 * duplicate instead of updating.
 */
export const POSTING_ID_QUERY_PARAMS = ['jobListingId', 'joblistingid', 'jl', 'jobId'] as const;

/** Elements that mean "there is a further Result_Page". */
export const NEXT_PAGE_SELECTORS = [
  '[data-test="pagination-next"]',
  'button[data-test="load-more"]',
  'link[rel="next"]',
  'a[rel="next"]',
  '[class*="pagination"] a[aria-label*="Nächste"]',
  'a[aria-label*="Weiter"]',
  'a[aria-label*="Next"]',
] as const;

/** Markers Glassdoor renders when a search matched nothing. */
export const EMPTY_RESULT_SELECTORS = [
  '[data-test="no-results"]',
  '[data-test="emptyResults"]',
  '[class*="NoResults"]',
  '.no-results',
] as const;

/**
 * Phrases that state an empty result list, for the case the markers above are absent.
 *
 * Both languages, because Glassdoor serves the same result list on a German and an English surface and
 * a redirect to the English one must not turn an empty search into a layout change.
 */
export const EMPTY_RESULT_PHRASES = [
  'keine jobs gefunden',
  'keine stellenangebote gefunden',
  'keine ergebnisse gefunden',
  'keine treffer',
  'wir haben keine jobs',
  'no jobs found',
  'no results found',
  'we found no jobs',
  'found 0 jobs',
] as const;

/**
 * Path fragments of a sign-in or registration page. Matched against the URL the load *ended* on, which
 * is how the redirect of 7.2 becomes visible without following anything.
 *
 * `/profile/login_input.htm` and `/profile/join` are Glassdoor's own two; the generic fragments behind
 * them cover the surfaces it redirects to from other entry points.
 */
export const SIGN_IN_PATH_FRAGMENTS = [
  '/profile/login_input',
  '/profile/join',
  '/member/home',
  '/login',
  '/anmelden',
  '/signin',
  '/sign-in',
  '/register',
  '/registrieren',
  '/auth/',
] as const;

/**
 * Markers of a sign-in or registration wall covering the result list (7.2).
 *
 * Glassdoor calls its own wall "hardsell" and "content wall", and both names appear in the element id
 * rather than only in a hashed class, which is why they are matched by substring.
 */
export const SIGN_IN_OVERLAY_SELECTORS = [
  '[id*="HardsellOverlay"]',
  '[class*="hardsellOverlay"]',
  '[class*="ContentWall"]',
  '[data-test="authWall"]',
  '[data-test="hardsell-modal"]',
  'dialog[class*="login"]',
] as const;

/**
 * Phrases that state the result list is only shown after sign-in.
 *
 * Deliberately long phrases rather than the bare word "Anmelden": every Glassdoor page carries a
 * sign-in link in its header, so a short phrase would report `SIGN_IN_REQUIRED` for a perfectly
 * readable result list. They are only consulted when the page yielded no readable Job_Posting, which is
 * the third characteristic 7.2 names.
 */
export const SIGN_IN_PHRASES = [
  'melden sie sich an, um',
  'melde dich an, um',
  'registrieren sie sich, um',
  'kostenlos registrieren, um',
  'anmelden, um alle jobs',
  'nur für angemeldete',
  'sign in to see',
  'log in to see',
  'create a free account to',
  'continue with google to',
] as const;

/**
 * Markers of a Captcha or bot check page (7.6).
 *
 * The first three are the bot protection Glassdoor is known to run in front of its pages; the rest are
 * the generic challenge surfaces. Detection only — nothing in this adapter answers any of them.
 */
export const BOT_CHECK_SELECTORS = [
  '[id*="px-captcha"]',
  'iframe[src*="perimeterx"]',
  'script[src*="captcha.px-cloud"]',
  '#challenge-form',
  '#cf-challenge-running',
  'iframe[src*="turnstile"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge"]',
  'form[action*="captcha"]',
] as const;

/** Phrases of a Captcha or bot check page (7.6). */
export const BOT_CHECK_PHRASES = [
  'captcha',
  'help us protect glassdoor',
  'sicherheitsüberprüfung',
  'security check',
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
 * A Glassdoor result link carries a per-impression click and attribution set, so the same Job_Posting
 * would yield a different URL on every Scrape_Run. Keeping it would change the stored source URL and
 * the Content_Hash of an unchanged posting on every run, which would defeat the hash gate of 15.4 and
 * make the "unchanged" case of the upsert unobservable. The Posting_Id and the path are what identify a
 * posting; these parameters identify the click. {@link POSTING_ID_QUERY_PARAMS} is deliberately
 * disjoint from this list.
 */
export const TRACKING_QUERY_PARAMS = [
  'src',
  'ao',
  's',
  't',
  'vt',
  'pos',
  'guid',
  'cs',
  'cb',
  'jrtk',
  'ea',
  'extr',
  'ref',
  'refid',
  'gclid',
  'fbclid',
  'msclkid',
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
 *
 * The `403` branch is the one most likely to decide a Glassdoor retrieval: a refused request is
 * reported as `BOT_CHECK`, so the Platform ends with `PLATFORM_BLOCKED` and no further request follows
 * in this Scrape_Run (7.8).
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

/**
 * Appended to every next-page selector, so only an enabled control is matched.
 *
 * Expressed in the selector rather than read back as an attribute, because Glassdoor marks its
 * pagination control with the bare boolean attribute `<button … disabled>`, whose value is the empty
 * string — and the HTML layer reports a blank attribute as absent (see `../html/html-document.ts`), so
 * an attribute read cannot tell `disabled` from "no such attribute".
 */
const ENABLED_ONLY = ':not([disabled]):not([aria-disabled="true"])';

/**
 * Whether Glassdoor offers a further Result_Page.
 *
 * A pagination control that is present but disabled, or an anchor without an `href`, is the last page:
 * a result list renders the "next" control on every page and marks it instead of removing it. A
 * `button` is accepted without an `href`, because Glassdoor's "Mehr Jobs laden" control is one.
 */
function detectNextPage(document: HtmlNode): boolean {
  for (const selector of NEXT_PAGE_SELECTORS) {
    for (const element of document.queryAll(`${selector}${ENABLED_ONLY}`)) {
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

/**
 * A digit run long enough to be a Glassdoor job listing number and *not* preceded by a letter.
 *
 * The letter boundary is the whole point and is specific to this Platform. A Glassdoor advertisement
 * path carries tokens such as `JV_IC2622109_KO0,16_KE17,28`, whose numbers are a city identifier and
 * two text offsets — shared by every posting of that city. Reading one of those as the Posting_Id would
 * give many different Job_Posting the same identifier, and the upsert of 9.4 is keyed on
 * `(platform, postingId)`, so one posting would overwrite another instead of being inserted. Requiring
 * a non-letter in front excludes `IC2622109` while accepting `…-1009123456789.htm`.
 */
const POSTING_NUMBER = /(?<![A-Za-z])\d{7,}/gu;

/** A value that is nothing but digits, as an identifier parameter carries it. */
const ONLY_DIGITS = /^\d+$/u;

/**
 * The Posting_Id carried by a Glassdoor job advertisement URL.
 *
 * Two shapes, in this order: an allow-listed identifier parameter
 * ({@link POSTING_ID_QUERY_PARAMS}, as in `?jl=1009123456789`), then the last sufficiently long digit
 * run of the path that {@link POSTING_NUMBER} accepts. Nothing else of the query string is ever read;
 * see {@link POSTING_ID_QUERY_PARAMS} for why.
 */
export function glassdoorPostingIdFromUrl(url: string): string | null {
  let path = url;
  let parameters: URLSearchParams | null = null;

  try {
    const parsed = new URL(url);

    path = parsed.pathname;
    parameters = parsed.searchParams;
  } catch {
    // A relative or malformed URL: fall back to searching the whole string as a path.
  }

  for (const name of POSTING_ID_QUERY_PARAMS) {
    const value = parameters?.get(name)?.trim();

    if (value !== undefined && ONLY_DIGITS.test(value)) {
      return value;
    }
  }

  const numbers = path.match(POSTING_NUMBER);

  return numbers === null ? null : (numbers.at(-1) ?? null);
}

/** Digits of an element id such as `job-item-1009123456`. */
const ID_DIGITS = /\d{3,}/u;

/** The Posting_Id a card carries in one of its own attributes, or `null`. */
function postingIdFromCard(card: HtmlNode): string | null {
  for (const attribute of POSTING_ID_ATTRIBUTES) {
    const value = card.attribute(attribute);

    if (value === null) {
      continue;
    }

    if (ONLY_DIGITS.test(value)) {
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
 * The publication date text of a card: the machine-readable value where Glassdoor renders one,
 * otherwise the visible text, which is usually relative such as "vor 3 Tagen" (6.4).
 *
 * `datetime` and the microdata `content` attribute are both tried, because `datePosted` is published as
 * `<meta content>` as often as it is as `<time datetime>`. The visible fallback is passed on unchanged,
 * since turning it into a date needs the Scrape_Run start time, which this layer deliberately does not
 * have. Glassdoor's own card usually shows nothing but the relative text, which is why 6.4 matters more
 * for this Platform than for Stepstone.
 */
function publishedAtTextOf(card: HtmlNode): string | null {
  return (
    attributeOf(card, ['[itemprop="datePosted"]', 'time[datetime]', '[datetime]'], 'datetime') ??
    attributeOf(card, ['[itemprop="datePosted"]'], 'content') ??
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
  const href =
    attributeOf(card, FIELD_SELECTORS.link, 'href') ??
    // Microdata publishes the advertisement URL as `<link itemprop="url" href>` on some renderings,
    // and as `<meta itemprop="url" content>` on others.
    attributeOf(card, ['[itemprop="url"]'], 'content');
  const sourceUrl = href === null ? null : cleanPostingUrl(href, pageUrl);

  return {
    postingId:
      postingIdFromCard(card) ?? (sourceUrl === null ? null : glassdoorPostingIdFromUrl(sourceUrl)),
    title: textOf(card, FIELD_SELECTORS.title),
    employer: textOf(card, FIELD_SELECTORS.employer),
    workLocation: textOf(card, FIELD_SELECTORS.workLocation),
    publishedAtText: publishedAtTextOf(card),
    sourceUrl,
    descriptionText: textOf(card, FIELD_SELECTORS.description),
  };
}

/**
 * Reads one Glassdoor Result_Page.
 *
 * Total over every input: any HTML, any status and any header set answer a {@link ResultPageReading}.
 * Nothing throws, because every failure this layer can observe already has a Platform_Status, and an
 * exception would instead end the retrieval as an unexpected error and lose the Partial_Result of 7.7.
 *
 * The classification order follows the error table, and the reason for it is that the characteristics
 * overlap: a bot check page carries a sign-in link, a sign-in wall carries no postings, and an empty
 * result list looks exactly like a broken selector unless the Platform says otherwise.
 *
 * 1. the response alone — reported rate limit, refusal (`403`, the Glassdoor case), server failure,
 *    dead URL;
 * 2. a bot check (7.6), before anything else that reads the page, since a challenge page's text says
 *    nothing about the search. Detected and reported, never answered;
 * 3. a sign-in redirect or a covering wall (7.2), which hold whether or not postings were parsed;
 * 4. a rate limit stated in the page body;
 * 5. the job cards. At least one readable Job_Posting makes the page a result list;
 * 6. with no readable Job_Posting: an explicit "nothing matched" statement is an empty result list, a
 *    sign-in prompt is the third characteristic of 7.2, and anything else is the layout change of 6.7.
 */
export function readGlassdoorResultPage(input: ResultPageInput): ResultPageReading {
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
