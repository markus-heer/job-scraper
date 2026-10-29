/**
 * Reading one Indeed Result_Page: HTML plus the response that carried it, in — a classification and the
 * raw Job_Posting of that page, out.
 *
 * Pure and browser-free, which is the point of splitting Fetch from Normalize in the design: every rule
 * of 6.5, 6.7, 7.2, 7.6 and 13.5 that depends on *what the page says* is decided here and is therefore
 * testable against frozen HTML (task 24.3), while the adapter in `./index.ts` only sequences pages and
 * reports.
 *
 * Three deliberate boundaries, the same ones the other three readers hold:
 *
 * - **Raw values only.** The seven fields of {@link RawJobPosting} are returned exactly as the page
 *   showed them, with whitespace collapsed and absent fields as `null`. Field limits, ISO dates, the
 *   discard rule of 6.5 and the "mark as empty" rule of 6.8 are applied once, by the normalization
 *   stage, so they are implemented once for all four Platform rather than per adapter.
 * - **No DOM semantics.** The parser sees markup, not a rendered page, so "an overlay covering the
 *   result list" (7.2) is detected through the markers Indeed renders for it, never through layout.
 * - **One decision, no side effects.** The reading reports what it found; the log entries and the
 *   Platform_Status come from the adapter, which knows the page number and the Result_Page URL.
 *
 * ## What is different about Indeed: the block is the expected outcome, and it arrives as a 403 or a 503
 *
 * The design's risk note rates Indeed with Glassdoor rather than with Stepstone: it operates aggressive
 * bot protection and commonly answers an automated browser — especially one that honestly identifies
 * itself as a tool, which 14.5 mandates — with a challenge page, a sign-in wall or nothing at all. A
 * permanent Platform_Status `PLATFORM_BLOCKED` or `SIGN_IN_REQUIRED` is therefore a realistic and
 * accepted outcome of this adapter rather than a defect in it (task 24.1, Requirements 7.6, 7.8).
 *
 * **No Result_Page has ever reached this repository.** The capture of task 24.2 was refused twice — at
 * the robots.txt gate, and then, with the forbidden parameter dropped, with HTTP 403 and a Cloudflare
 * security check — so every selector and every phrase below is a candidate read from the shape of
 * Indeed's public result list, and none of them has been confirmed against a served result list. The one
 * document that did arrive is `./__fixtures__/captcha.html`, and what it confirms is the detection in
 * this file rather than the reading. A selector set that no longer matches does not produce wrong data:
 * a Result_Page that yields no readable Job_Posting is reported as {@link ResultPageOutcome}
 * `LAYOUT_UNKNOWN`, which is the `PAGE_LAYOUT_UNKNOWN` of 6.7.
 *
 * Four consequences are structural in this file:
 *
 * 1. **A Captcha is recognised and reported, never answered.** {@link BOT_CHECK_SELECTORS} and
 *    {@link BOT_CHECK_PHRASES} only *detect*; there is no code here or in `./index.ts` that submits a
 *    challenge form, reads a challenge token or follows a challenge redirect (7.6).
 * 2. **No sign-in form is filled and no credential exists to fill it with** (7.1, 7.5). A sign-in wall
 *    is likewise only detected, from the URL the load ended on and from the markers of the wall.
 * 3. **The bot check is classified before anything else that reads the page.** A challenge page carries
 *    a sign-in link and no job cards, so reading it in any other order would report the wrong cause.
 * 4. **A `503` is not taken for a Platform failure until the page has been looked at.** This is the one
 *    ordering difference to the Glassdoor reader, and it is specific to the protection Indeed runs: a
 *    challenge is served with `403` *or* with `503`, and a `503` reported as `PLATFORM_UNREACHABLE`
 *    would tell the user to try again later for a block that will answer the same way every time. So
 *    the two statuses that settle themselves — a reported rate limit and an outright `403` refusal —
 *    are read from the response, and every other unsuccessful status is held back until the markers of
 *    {@link BOT_CHECK_SELECTORS} have been looked for in the body. See {@link readIndeedResultPage}.
 *
 * The honest limit, and it is the same one Glassdoor has: a result list that is empty *because* the
 * Platform decided not to serve one to this client is indistinguishable, in the markup, from a search
 * that legitimately matched nothing. The reader therefore reports what the page says — an explicit
 * "nothing matched" statement is `EMPTY_RESULT_LIST`, a page with neither postings nor an explanation is
 * the `LAYOUT_UNKNOWN` of 6.7 — and does not guess at a block it cannot see.
 *
 * ## Status of the selectors
 *
 * The selector tables are ordered candidate lists: the first selector that matches anything wins
 * ({@link queryAllFirst}, {@link queryFirst}), so an Indeed layout change is repaired by putting the new
 * selector in front rather than by rewriting the parser.
 *
 * `data-testid` attributes lead every table on purpose: Indeed renders its result list with
 * build-hashed emotion class names (`css-1m4cuuf`), which change with every deployment, while
 * `data-testid` is what its own test suite selects on. The stable semantic class names its result cards
 * have carried for years (`job_seen_beacon`, `jobTitle`, `companyName`, `companyLocation`,
 * `job-snippet`) sit behind them, and the schema.org microdata candidates last, as the published
 * contract fallback.
 *
 * ## The publication date, and what it currently costs
 *
 * Indeed states the age of a posting as German relative text, and it wraps the statement in its own
 * frame: "Vor 3 Tagen geschaltet", "Gerade geschaltet", "Heute", "Vor mehr als 30 Tagen". The reader
 * hands that text on unchanged, because turning it into a date needs the Scrape_Run start time, which
 * this layer deliberately does not have (6.4).
 *
 * The vocabulary of `../../normalize/parse-publication-date.ts` reads all of that since task 24.2. It
 * already accepted "vor 3 Tagen", "vor mehr als 30 Tagen", "vor 30+ Tagen", "heute" and "gestern", but
 * its `RELATIVE_PATTERN` is *anchored*, so the trailing "geschaltet" made the whole value a non-match
 * and would have sent **every** Indeed Job_Posting down the 6.9 path — publication date empty, a
 * `posting.publicationDateUnparsable` note per posting, the posting kept. `POSTING_FRAME_SUFFIX` there
 * now drops that frame word from a closed list before the relative readers run, and "gerade" joins the
 * named days as 0 days. The change went into the shared normalization layer rather than into a strip
 * here, which is the route the compact Glassdoor day count took in task 23.3 and which keeps this
 * reader's "raw values only" boundary intact. The three frame words are provisional in the same sense
 * as the selectors above: the capture of 24.2 was answered with HTTP 403 and saw no Result_Page, so no
 * served page confirmed the wording — see `./__fixtures__/README.md`. An unknown wording costs the
 * publication date (6.9) and never the Job_Posting.
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
  /** Indeed states that the search matched nothing. Not a failure. */
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
  /** Whether Indeed offers a further Result_Page, which is what ends the pagination of 13.3. */
  readonly hasNextPage: boolean;
}

/** The input of {@link readIndeedResultPage}. */
export interface ResultPageInput {
  /** The HTML of the Result_Page as the Platform served it. */
  readonly html: string;
  /** How the load answered, including the URL it ended on after a redirect (7.2). */
  readonly response: AdapterPageResponse;
}

/** The job cards of a Result_Page. The first selector that matches anything supplies all of them. */
export const CARD_SELECTORS = [
  '[data-testid="slider_item"]',
  '[data-testid="jobsearch-SerpJobCard"]',
  'div.job_seen_beacon',
  'div.cardOutline',
  'td.resultContent',
  '[itemtype*="JobPosting"]',
  // Last resort: the advertisement anchor itself is the card. It carries the job key and the title and
  // nothing else, so a posting read this way is readable under 6.5 while employer and location are
  // absent, which is better than reporting a layout change for a page that does show postings.
  'a[data-jk]',
] as const;

/** Per-field selectors inside one job card, in candidate order. */
export const FIELD_SELECTORS = {
  title: [
    '[data-testid="jobTitle"]',
    'h2.jobTitle span[title]',
    'h2.jobTitle a',
    'a.jcs-JobTitle',
    '[class*="jobTitle"]',
    '[itemprop="title"]',
    'h2 a',
  ],
  link: [
    'a.jcs-JobTitle',
    'h2.jobTitle a',
    'a[data-jk]',
    'a[itemprop="url"]',
    'a[href*="/viewjob"]',
    'a[href*="/rc/clk"]',
    'a[href*="/pagead/clk"]',
    'a[href]',
  ],
  employer: [
    '[data-testid="company-name"]',
    'span.companyName',
    '[class*="companyName"]',
    '[itemprop="hiringOrganization"] [itemprop="name"]',
    '.company_location [data-testid="company-name"]',
  ],
  workLocation: [
    '[data-testid="text-location"]',
    'div.companyLocation',
    '[class*="companyLocation"]',
    '[itemprop="jobLocation"] [itemprop="addressLocality"]',
    '[itemprop="addressLocality"]',
  ],
  publishedAt: [
    '[data-testid="myJobsStateDate"]',
    'span.date',
    '[class*="jobMetaDataGroup"] [class*="date"]',
    '[itemprop="datePosted"]',
    'time',
  ],
  description: [
    '[data-testid="belowJobSnippet"]',
    'div.job-snippet',
    '[class*="jobSnippet"]',
    '[itemprop="description"]',
    '[data-testid="jobsnippet_footer"]',
  ],
} as const;

/**
 * Card attributes that carry the Posting_Id directly, in candidate order.
 *
 * `data-jk` is Indeed's own job key and the identifier the whole site is built on. Deliberately *not*
 * in this list: `data-mobtk`, `data-ci`, `data-empn` and `data-hiring-event` — the first two change per
 * impression and the others identify the employer rather than the posting, and a Posting_Id that
 * changed per Scrape_Run or that several postings shared would break the upsert of 9.4, which is keyed
 * on `(platform, postingId)`.
 */
export const POSTING_ID_ATTRIBUTES = ['data-jk', 'id'] as const;

/**
 * Query parameters of a job advertisement URL that *are* the Posting_Id, in candidate order.
 *
 * `jk` is the job key of `/viewjob?jk=…` and of the click-through `/rc/clk?jk=…`; `vjk` is the same
 * value on the result list URL of a selected posting. Spelled out as an allow-list rather than "any
 * long token", because an Indeed result link is full of per-impression tracking tokens that look
 * exactly like a job key.
 */
export const POSTING_ID_QUERY_PARAMS = ['jk', 'vjk'] as const;

/** Elements that mean "there is a further Result_Page". */
export const NEXT_PAGE_SELECTORS = [
  'a[data-testid="pagination-page-next"]',
  '[data-testid="pagination-page-next"]',
  'a[aria-label*="Nächste"]',
  'a[aria-label*="Weiter"]',
  'a[aria-label*="Next"]',
  'link[rel="next"]',
  'a[rel="next"]',
] as const;

/** Markers Indeed renders when a search matched nothing. */
export const EMPTY_RESULT_SELECTORS = [
  '[data-testid="no-results"]',
  '.jobsearch-NoResult-messageHeader',
  '[class*="NoResult"]',
  '#no_results',
] as const;

/**
 * Phrases that state an empty result list, for the case the markers above are absent.
 *
 * Both languages, because Indeed serves the same result list on a German and an English surface and a
 * redirect to the English one must not turn an empty search into a layout change.
 */
export const EMPTY_RESULT_PHRASES = [
  'keine ergebnisse ergeben',
  'ergab keine treffer',
  'keine stellenangebote gefunden',
  'keine jobs gefunden',
  'keine treffer',
  'did not match any jobs',
  'no jobs found',
  'there were no matches',
  'no results found',
] as const;

/**
 * Path fragments of a sign-in or registration page. Matched against the URL the load *ended* on, which
 * is how the redirect of 7.2 becomes visible without following anything.
 *
 * `/account/login` on `secure.indeed.com` is Indeed's own; the generic fragments behind it cover the
 * surfaces it redirects to from other entry points.
 */
export const SIGN_IN_PATH_FRAGMENTS = [
  '/account/login',
  '/account/signin',
  'secure.indeed.com',
  '/auth/',
  '/login',
  '/anmelden',
  '/signin',
  '/sign-in',
  '/register',
  '/registrieren',
] as const;

/** Markers of a sign-in or registration wall covering the result list (7.2). */
export const SIGN_IN_OVERLAY_SELECTORS = [
  '[data-testid="login-wall"]',
  '[data-testid="auth-page"]',
  '[id*="LoginWall"]',
  '[class*="loginWall"]',
  'form[action*="/account/login"]',
  'dialog[class*="login"]',
] as const;

/**
 * Phrases that state the result list is only shown after sign-in.
 *
 * Deliberately long phrases rather than the bare word "Anmelden": every Indeed page carries a sign-in
 * link in its header, so a short phrase would report `SIGN_IN_REQUIRED` for a perfectly readable result
 * list. They are only consulted when the page yielded no readable Job_Posting, which is the third
 * characteristic 7.2 names.
 */
export const SIGN_IN_PHRASES = [
  'melden sie sich an, um',
  'melde dich an, um',
  'um fortzufahren, melden sie sich an',
  'bitte melden sie sich an',
  'registrieren sie sich, um',
  'sign in to continue',
  'sign in to see',
  'log in to see',
  'create an account to',
] as const;

/**
 * Markers of a Captcha or bot check page (7.6).
 *
 * The Cloudflare challenge surfaces lead, because that is the protection Indeed is known to run in
 * front of its result list; the rest are the generic challenge surfaces. Detection only — nothing in
 * this adapter answers any of them.
 */
export const BOT_CHECK_SELECTORS = [
  '#challenge-form',
  '#cf-challenge-running',
  'iframe[src*="challenges.cloudflare.com"]',
  'script[src*="/cdn-cgi/challenge-platform/"]',
  '#cf-error-details',
  '[id*="px-captcha"]',
  'iframe[src*="perimeterx"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge"]',
  'form[action*="captcha"]',
] as const;

/** Phrases of a Captcha or bot check page (7.6). */
export const BOT_CHECK_PHRASES = [
  'captcha',
  'zusätzliche verifizierung',
  'additional verification',
  'sicherheitsüberprüfung',
  'security check',
  'bestätigen sie, dass sie ein mensch',
  'sind sie ein mensch',
  'verify you are human',
  'are you a human',
  'ungewöhnlicher datenverkehr',
  'unusual traffic',
  'zugriff verweigert',
  'access denied',
  'checking your browser',
  'performance & security by cloudflare',
  'attention required',
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
 * An Indeed result link carries a per-impression click and attribution set, so the same Job_Posting
 * would yield a different URL on every Scrape_Run. Keeping it would change the stored source URL and
 * the Content_Hash of an unchanged posting on every run, which would defeat the hash gate of 15.4 and
 * make the "unchanged" case of the upsert unobservable. The job key and the path are what identify a
 * posting; these parameters identify the click. {@link POSTING_ID_QUERY_PARAMS} is deliberately
 * disjoint from this list.
 */
export const TRACKING_QUERY_PARAMS = [
  'from',
  'tk',
  'alid',
  'advn',
  'adid',
  'ad',
  'sjdu',
  'acatk',
  'pub',
  'camk',
  'fccid',
  'vjs',
  'rtk',
  'xkcb',
  'xpse',
  'xfps',
  'mo',
  'cmpid',
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
 * The classification the response alone settles, before the body is looked at: a reported rate limit
 * (13.5), which outranks everything because `429` *is* the rate limit statement, and an outright `403`
 * refusal, which is how bot protection answers a request it will not serve (7.6).
 */
function classifyResponseFirst(response: AdapterPageResponse): ResultPageOutcome | null {
  const status = response.status;
  const unsuccessful = status !== null && status >= STATUS_CLIENT_ERROR;

  if (
    status === STATUS_TOO_MANY_REQUESTS ||
    reportsExhaustedQuota(response.headers) ||
    (unsuccessful && hasAnyHeader(response.headers, RATE_LIMIT_HEADERS))
  ) {
    return 'RATE_LIMITED';
  }

  return status === STATUS_FORBIDDEN ? 'BOT_CHECK' : null;
}

/**
 * The classification an unsuccessful status settles once the body has been looked at for a challenge.
 *
 * Held back rather than decided with {@link classifyResponseFirst} because of the Indeed-specific
 * ordering in the file comment: a Cloudflare challenge is served with a `503` as readily as with a
 * `403`, and reporting it as `PLATFORM_UNREACHABLE` would tell the user to retry later for something
 * that will answer identically every time.
 */
function classifyUnsuccessfulStatus(response: AdapterPageResponse): ResultPageOutcome | null {
  const status = response.status;

  if (status === null || status < STATUS_CLIENT_ERROR) {
    return null;
  }

  // A 404 or 410 on a result list URL the adapter built itself means the URL shape no longer holds,
  // which is the same loss as a broken selector and is reported the same way (6.7).
  return status >= STATUS_SERVER_ERROR ? 'UNREACHABLE' : 'LAYOUT_UNKNOWN';
}

/** Whether the load ended on a sign-in or registration page (the redirect of 7.2). */
function endedOnSignInPage(url: string): boolean {
  return containsAnyPhrase(url.toLowerCase(), SIGN_IN_PATH_FRAGMENTS);
}

/**
 * Appended to every next-page selector, so only an enabled control is matched.
 *
 * Expressed in the selector rather than read back as an attribute, because a pagination control is
 * marked with the bare boolean attribute `<button … disabled>`, whose value is the empty string — and
 * the HTML layer reports a blank attribute as absent (see `../html/html-document.ts`), so an attribute
 * read cannot tell `disabled` from "no such attribute".
 */
const ENABLED_ONLY = ':not([disabled]):not([aria-disabled="true"])';

/**
 * Whether Indeed offers a further Result_Page.
 *
 * A pagination control that is present but disabled, or an anchor without an `href`, is the last page: a
 * result list renders the "next" control on every page and marks it instead of removing it.
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
 * An Indeed job key: a hexadecimal token, 16 characters on every posting seen so far.
 *
 * Accepted between 10 and 24 characters so that a changed key length stays readable, and required to be
 * *whole* so that a tracking token which merely contains hexadecimal characters cannot pass. A job key
 * is the identifier the upsert of 9.4 is keyed on, so a wrong one is worse than none: it would make two
 * different Job_Posting overwrite each other.
 */
const JOB_KEY = /^[0-9a-f]{10,24}$/iu;

/** An Indeed job key inside an element id such as `job_1a2b3c4d5e6f7890` or `sj_1a2b3c4d5e6f7890`. */
const ID_JOB_KEY = /(?:^|[^0-9a-z])([0-9a-f]{10,24})$/iu;

/**
 * The query of a URL, or `null` where it has none.
 *
 * A relative or malformed href is parsed by hand rather than against an invented origin: resolving it
 * against one would mean guessing a host, and the only thing wanted here is the query string.
 */
function searchParamsOf(url: string): URLSearchParams | null {
  try {
    return new URL(url).searchParams;
  } catch {
    const queryStart = url.indexOf('?');

    return queryStart === -1 ? null : new URLSearchParams(url.slice(queryStart + 1));
  }
}

/**
 * The Posting_Id carried by an Indeed job advertisement URL.
 *
 * Only an allow-listed identifier parameter ({@link POSTING_ID_QUERY_PARAMS}) is read, and only when its
 * value is a whole job key. Nothing of the path is read: an Indeed advertisement path carries no
 * identifier of its own, and the localised slug of `/Projektmanagerin-jobs` names a search rather than a
 * posting.
 */
export function indeedPostingIdFromUrl(url: string): string | null {
  const parameters = searchParamsOf(url);

  for (const name of POSTING_ID_QUERY_PARAMS) {
    const value = parameters?.get(name)?.trim();

    if (value !== undefined && JOB_KEY.test(value)) {
      return value;
    }
  }

  return null;
}

/** The Posting_Id a card carries in one of its own attributes, or `null`. */
function postingIdFromCard(card: HtmlNode): string | null {
  for (const attribute of POSTING_ID_ATTRIBUTES) {
    const value = card.attribute(attribute);

    if (value === null) {
      continue;
    }

    if (JOB_KEY.test(value)) {
      return value;
    }

    const withinId = ID_JOB_KEY.exec(value);

    if (withinId?.[1] !== undefined) {
      return withinId[1];
    }
  }

  return null;
}

/**
 * The publication date text of a card: the machine-readable value where Indeed renders one, otherwise
 * the visible text, which is a framed relative statement ("Vor 3 Tagen geschaltet") — handed on
 * unchanged and resolved by the shared normalization layer; see the file comment.
 *
 * `datetime` and the microdata `content` attribute are both tried, because `datePosted` is published as
 * `<meta content>` as often as it is as `<time datetime>`.
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

/**
 * The title of a card.
 *
 * The `title` attribute is read first where the matched element carries one: Indeed renders the job
 * title as `<span title="Projektmanagerin (m/w/d)">` and prefixes the visible text of that span with a
 * screen-reader phrase ("Jetzt bewerben: ") on part of its layouts, so the attribute is the cleaner of
 * the two statements of the same value.
 */
function titleOf(card: HtmlNode): string | null {
  const fromSelectors =
    attributeOf(card, FIELD_SELECTORS.title, 'title') ?? textOf(card, FIELD_SELECTORS.title);

  if (fromSelectors !== null || card.tagName !== 'a') {
    return fromSelectors;
  }

  // The last candidate of {@link CARD_SELECTORS} is the advertisement anchor itself, and it has no
  // inner element to read a title from: its own `title` attribute, or failing that its own text, *is*
  // the job title. Restricted to that one case on purpose — falling back to the text of a `div` card
  // would make the whole card, employer and snippet included, the title of the Job_Posting.
  const own = card.attribute('title') ?? card.text();

  return own.length === 0 ? null : own;
}

/** One job card as a {@link RawJobPosting}. Every field is read independently, so one gap costs one field. */
function readCard(card: HtmlNode, pageUrl: string): RawJobPosting {
  const href =
    // The card itself is the anchor on the last candidate of `CARD_SELECTORS`, so its own `href` counts.
    (card.tagName === 'a' ? card.attribute('href') : null) ??
    attributeOf(card, FIELD_SELECTORS.link, 'href') ??
    // Microdata publishes the advertisement URL as `<link itemprop="url" href>` on some renderings, and
    // as `<meta itemprop="url" content>` on others.
    attributeOf(card, ['[itemprop="url"]'], 'content');
  const sourceUrl = href === null ? null : cleanPostingUrl(href, pageUrl);
  const linkJobKey =
    attributeOf(card, FIELD_SELECTORS.link, 'data-jk') ??
    (card.tagName === 'a' ? card.attribute('data-jk') : null);

  return {
    postingId:
      postingIdFromCard(card) ??
      (linkJobKey !== null && JOB_KEY.test(linkJobKey) ? linkJobKey : null) ??
      (sourceUrl === null ? null : indeedPostingIdFromUrl(sourceUrl)),
    title: titleOf(card),
    employer: textOf(card, FIELD_SELECTORS.employer),
    workLocation: textOf(card, FIELD_SELECTORS.workLocation),
    publishedAtText: publishedAtTextOf(card),
    sourceUrl,
    descriptionText: textOf(card, FIELD_SELECTORS.description),
  };
}

/**
 * Reads one Indeed Result_Page.
 *
 * Total over every input: any HTML, any status and any header set answer a {@link ResultPageReading}.
 * Nothing throws, because every failure this layer can observe already has a Platform_Status, and an
 * exception would instead end the retrieval as an unexpected error and lose the Partial_Result of 7.7.
 *
 * The classification order follows the error table, and the reason for it is that the characteristics
 * overlap: a bot check page carries a sign-in link, a sign-in wall carries no postings, and an empty
 * result list looks exactly like a broken selector unless the Platform says otherwise.
 *
 * 1. the response alone, for the two statuses that settle themselves — a reported rate limit (13.5) and
 *    an outright `403` refusal, which is the likely Indeed case;
 * 2. a bot check (7.6), before anything else that reads the page, since a challenge page's text says
 *    nothing about the search. Detected and reported, never answered;
 * 3. every other unsuccessful status: a server failure, or a dead result list URL. After step 2, so that
 *    a challenge served with a `503` is reported as the block it is — see point 4 of the file comment;
 * 4. a sign-in redirect or a covering wall (7.2), which hold whether or not postings were parsed;
 * 5. a rate limit stated in the page body;
 * 6. the job cards. At least one readable Job_Posting makes the page a result list;
 * 7. with no readable Job_Posting: an explicit "nothing matched" statement is an empty result list, a
 *    sign-in prompt is the third characteristic of 7.2, and anything else is the layout change of 6.7.
 */
export function readIndeedResultPage(input: ResultPageInput): ResultPageReading {
  const settledByResponse = classifyResponseFirst(input.response);

  if (settledByResponse !== null) {
    return withoutPostings(settledByResponse);
  }

  const document = parseHtml(input.html);
  const pageText = document.text();

  if (
    queryFirst(document, BOT_CHECK_SELECTORS) !== null ||
    containsAnyPhrase(pageText, BOT_CHECK_PHRASES)
  ) {
    return withoutPostings('BOT_CHECK');
  }

  const fromStatus = classifyUnsuccessfulStatus(input.response);

  if (fromStatus !== null) {
    return withoutPostings(fromStatus);
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
