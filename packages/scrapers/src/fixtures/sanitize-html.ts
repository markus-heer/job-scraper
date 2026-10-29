/**
 * What a captured Result_Page is stripped of before it is frozen into the repository (design,
 * Testing Strategy; 14.5).
 *
 * Four classes of content go, and each for a stated reason rather than for tidiness:
 *
 * - `<script>` elements, because a fixture is parser input, never executed code. Keeping them would
 *   freeze a Platform's tracking and bot-detection code into the repository and would let a fixture
 *   served to a real browser phone home from a test run.
 * - `<style>` elements and stylesheet-ish `<link>` elements, because the eight fields of 6.3 live in
 *   the markup, so styling is bulk that makes every fixture diff unreadable.
 * - tracking pixels, because they are requests, not content: a 1×1 image or a beacon frame exists to
 *   be fetched, and a fixture must not carry one.
 * - identifier-like query parameters in URL attributes, because a captured page carries session,
 *   visitor and click identifiers of the one real retrieval that produced it, and those are both
 *   personal to the capturing machine and meaningless to a parser.
 *
 * Everything else is copied through byte for byte. That is the point of the hand-written scanner
 * below rather than a parse-and-serialise round trip through an HTML library: a serialiser normalises
 * attribute quoting, entity spelling and whitespace, so the fixture would stop being the document the
 * Platform served and a selector fix could no longer be reasoned about from the diff. The scanner
 * emits slices of the input and rewrites exactly the spans it decided to change.
 *
 * The one deliberate exception to "strip what looks like an identifier": a Posting_Id that a Platform
 * carries in a *named* query parameter is page data the parser has to read (6.3, 6.5), so the names in
 * {@link PRESERVED_PARAMETER_NAMES} survive. See the note there.
 */

/** Elements whose content is text rather than markup, so the scanner must not parse inside them. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);

/** Elements that are removed with their content. */
const REMOVED_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

/** `rel` values that make a `<link>` a styling or preloading instruction rather than metadata. */
const REMOVED_LINK_RELS: ReadonlySet<string> = new Set([
  'stylesheet',
  'preload',
  'prefetch',
  'preconnect',
  'dns-prefetch',
  'modulepreload',
]);

/** Attributes whose value is a URL and therefore gets its query parameters inspected. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'action',
  'cite',
  'data-href',
  'data-src',
  'data-url',
  'formaction',
  'href',
  'poster',
  'src',
]);

/**
 * Name segments that make a query parameter an identifier.
 *
 * Matched per segment rather than as a substring, because a substring match would strip `keywords`
 * for containing `key` and keep `sessionId` for not containing `session_id`. A parameter name is
 * split on `.`, `_`, `-` and on camel-case boundaries, so `sessionId`, `user-id`, `tracking_token`,
 * `rid` and `utm_medium` all produce a matching segment while `page`, `radius` and `keywords` do not.
 */
export const IDENTIFIER_NAME_SEGMENTS: ReadonlySet<string> = new Set([
  'candidate',
  'cid',
  'client',
  'correlation',
  'device',
  'eid',
  'fbclid',
  'fingerprint',
  'gclid',
  'guid',
  'hash',
  'id',
  'ids',
  'impression',
  'key',
  'member',
  'msclkid',
  'nonce',
  'ref',
  'referer',
  'referrer',
  'rid',
  'secret',
  'session',
  'sid',
  'sig',
  'signature',
  'ssid',
  'tid',
  'token',
  'track',
  'tracker',
  'tracking',
  'trk',
  'uid',
  'user',
  'utm',
  'uuid',
  'visitor',
]);

/**
 * Parameter names that survive even though {@link IDENTIFIER_PARAMETER_PATTERN} matches them.
 *
 * A Platform that puts the Posting_Id of a Job_Posting into the result list link as `?jobId=…` makes
 * that parameter page data: 6.5 discards a Job_Posting without a Posting_Id, so a capture that
 * stripped it would turn every posting of that Platform into a discarded one and the fixture would
 * test the wrong thing. The names here are the ones that denote the advertisement rather than the
 * visitor; a session or click identifier is never among them.
 *
 * Captured fixtures are reviewed in the diff (design, fixture refresh), which is where a Platform
 * that needs a further name gets noticed.
 */
export const PRESERVED_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'id',
  'jobid',
  'job_id',
  'jobnumber',
  'listingid',
  'listing_id',
  'offerid',
  'offer_id',
  'postingid',
  'posting_id',
  'vacancyid',
  'vacancy_id',
]);

/** Minimum length at which an opaque parameter value counts as an identifier on its own. */
const OPAQUE_VALUE_MIN_LENGTH = 16;

/** A value made only of URL-safe identifier characters, the shape every opaque token has. */
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Hosts and paths that only ever serve a measurement request. */
const TRACKING_URL_PATTERN =
  /(?:google-analytics|googletagmanager|googleadservices|doubleclick|facebook\.com\/tr|connect\.facebook|scorecardresearch|quantserve|hotjar|matomo|piwik|segment\.io|mixpanel|optimizely|criteo|bing\.com\/bat|linkedin\.com\/px|\/b\/ss\/|__utm\.gif|\/(?:pixel|pixels|beacon|track|tracker|tracking|collect|impression|telemetry)(?:[./?]|$)|\/1x1\.|\/p\.gif)/i;

/** Dimension values at which an image is a measurement request rather than a picture. */
const TINY_DIMENSION_MAX = 1;

/** Inline styles that hide an element, which a pixel is always given. */
const HIDDEN_STYLE_PATTERN = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/i;

/** What one sanitization removed, so the capture metadata can record it and a review can read it. */
export interface FixtureSanitizationReport {
  readonly scriptsRemoved: number;
  readonly stylesRemoved: number;
  readonly trackingPixelsRemoved: number;
  /** The query parameter names that were stripped, deduplicated and sorted. */
  readonly strippedParameters: readonly string[];
}

/** A captured document after sanitization, together with what was taken out of it. */
export interface SanitizedFixture {
  readonly html: string;
  readonly report: FixtureSanitizationReport;
}

/** One attribute of a start tag, with the absolute span of its raw value in the source. */
interface ScannedAttribute {
  /** Lowercased attribute name. */
  readonly name: string;
  /** The raw value as written, without the surrounding quotes, or `null` for a bare attribute. */
  readonly value: string | null;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** Internal mutable counterpart of {@link FixtureSanitizationReport}. */
interface SanitizationTally {
  scriptsRemoved: number;
  stylesRemoved: number;
  trackingPixelsRemoved: number;
  readonly strippedParameters: Set<string>;
}

/**
 * Strips scripts, styles, tracking pixels and identifier-like query parameters from a captured
 * Result_Page and leaves every other byte in place.
 *
 * @param html The document as the Platform served it.
 * @returns The fixture content to write, plus the report of what was removed.
 */
export function sanitizeFixtureHtml(html: string): SanitizedFixture {
  const tally: SanitizationTally = {
    scriptsRemoved: 0,
    stylesRemoved: 0,
    trackingPixelsRemoved: 0,
    strippedParameters: new Set<string>(),
  };

  const parts: string[] = [];
  let index = 0;

  while (index < html.length) {
    const tagStart = html.indexOf('<', index);

    if (tagStart === -1) {
      parts.push(html.slice(index));
      break;
    }

    parts.push(html.slice(index, tagStart));
    index = emitFrom(html, tagStart, parts, tally);
  }

  return {
    html: parts.join(''),
    report: {
      scriptsRemoved: tally.scriptsRemoved,
      stylesRemoved: tally.stylesRemoved,
      trackingPixelsRemoved: tally.trackingPixelsRemoved,
      strippedParameters: [...tally.strippedParameters].sort(),
    },
  };
}

/**
 * Handles the markup construct beginning at `tagStart` and appends what survives of it.
 *
 * @returns The index to continue scanning from, always greater than `tagStart` so the loop
 *   terminates.
 */
function emitFrom(
  html: string,
  tagStart: number,
  parts: string[],
  tally: SanitizationTally,
): number {
  if (html.startsWith('<!--', tagStart)) {
    return emitVerbatimUntil(html, tagStart, '-->', parts);
  }

  // A doctype, a processing instruction or an end tag: nothing in them can be a resource or a URL.
  if (html.startsWith('<!', tagStart) || html.startsWith('</', tagStart)) {
    return emitVerbatimUntil(html, tagStart, '>', parts);
  }

  const name = startTagName(html, tagStart);

  if (name === undefined) {
    // A stray `<` in text content. Copied unchanged, because it is text.
    parts.push('<');

    return tagStart + 1;
  }

  const tagEnd = findTagEnd(html, tagStart);

  if (tagEnd === -1) {
    parts.push(html.slice(tagStart));

    return html.length;
  }

  const attributes = scanAttributes(html, tagStart + 1 + name.length, tagEnd);

  if (REMOVED_ELEMENTS.has(name)) {
    tallyRemovedElement(name, tally);

    return skipElement(html, name, tagEnd + 1);
  }

  if (name === 'link' && isRemovedLink(attributes)) {
    tally.stylesRemoved += 1;

    return tagEnd + 1;
  }

  if (name === 'img' && isTrackingPixel(attributes)) {
    tally.trackingPixelsRemoved += 1;

    return tagEnd + 1;
  }

  if ((name === 'iframe' || name === 'frame') && isTrackingFrame(attributes)) {
    tally.trackingPixelsRemoved += 1;

    return skipElement(html, name, tagEnd + 1);
  }

  parts.push(rewriteTag(html, tagStart, tagEnd, attributes, tally));

  // A raw text element that is kept — `<title>` or `<textarea>` — has its content copied without
  // being scanned, so a `<` inside it is never mistaken for a tag.
  if (RAW_TEXT_ELEMENTS.has(name)) {
    const contentEnd = rawTextEnd(html, name, tagEnd + 1);

    parts.push(html.slice(tagEnd + 1, contentEnd));

    return contentEnd;
  }

  return tagEnd + 1;
}

/** Counts a removed `<script>` or `<style>` element in the right bucket of the report. */
function tallyRemovedElement(name: string, tally: SanitizationTally): void {
  if (name === 'script') {
    tally.scriptsRemoved += 1;

    return;
  }

  tally.stylesRemoved += 1;
}

/** Copies the construct from `start` through the first `terminator` after it. */
function emitVerbatimUntil(
  html: string,
  start: number,
  terminator: string,
  parts: string[],
): number {
  const end = html.indexOf(terminator, start);

  if (end === -1) {
    parts.push(html.slice(start));

    return html.length;
  }

  const next = end + terminator.length;

  parts.push(html.slice(start, next));

  return next;
}

/** The lowercased element name of the start tag at `tagStart`, or `undefined` if there is none. */
function startTagName(html: string, tagStart: number): string | undefined {
  const match = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(tagStart, tagStart + 64));

  return match?.[1]?.toLowerCase();
}

/**
 * The index of the `>` that closes the tag starting at `tagStart`, or -1 for an unterminated tag.
 *
 * Quote-aware, so a `>` inside an attribute value — common in a `data-*` payload — does not end the
 * tag early.
 */
function findTagEnd(html: string, tagStart: number): number {
  let quote: string | undefined;

  for (let index = tagStart + 1; index < html.length; index += 1) {
    const character = html[index];

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;

      continue;
    }

    if (character === '>') {
      return index;
    }
  }

  return -1;
}

/** Every attribute between `from` and the tag's closing `>`, with absolute value spans. */
function scanAttributes(html: string, from: number, tagEnd: number): readonly ScannedAttribute[] {
  const source = html.slice(from, tagEnd);
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const attributes: ScannedAttribute[] = [];

  for (const match of source.matchAll(pattern)) {
    const name = match[1];

    if (name === undefined) {
      continue;
    }

    const quoted = match[2] ?? match[3];
    const value = quoted ?? match[4] ?? null;
    const base = from + (match.index ?? 0);
    const valueStart =
      value === null
        ? base
        : base +
          (quoted === undefined ? match[0].lastIndexOf(value) : openingQuoteOffset(match[0]));

    attributes.push({
      name: name.toLowerCase(),
      value,
      valueStart,
      valueEnd: valueStart + (value?.length ?? 0),
    });
  }

  return attributes;
}

/** Offset of the first character after the opening quote of a quoted attribute. */
function openingQuoteOffset(raw: string): number {
  const doubleQuote = raw.indexOf('"');
  const singleQuote = raw.indexOf("'");
  const first =
    doubleQuote === -1
      ? singleQuote
      : singleQuote === -1
        ? doubleQuote
        : Math.min(doubleQuote, singleQuote);

  return first + 1;
}

/** The value of one attribute, or `undefined` when the tag does not carry it. */
function attributeValue(attributes: readonly ScannedAttribute[], name: string): string | undefined {
  return attributes.find((attribute) => attribute.name === name)?.value ?? undefined;
}

/** Whether a `<link>` points at styling or preloading rather than at metadata. */
function isRemovedLink(attributes: readonly ScannedAttribute[]): boolean {
  const rel = attributeValue(attributes, 'rel');

  if (rel === undefined) {
    return false;
  }

  return rel
    .toLowerCase()
    .split(/\s+/)
    .some((token) => REMOVED_LINK_RELS.has(token));
}

/** Whether a dimension attribute states a size no picture is served at. */
function isTinyDimension(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed <= TINY_DIMENSION_MAX;
}

/** Whether a URL only ever serves a measurement request. */
export function isTrackingUrl(url: string | undefined): boolean {
  return url !== undefined && TRACKING_URL_PATTERN.test(url);
}

/**
 * Whether an `<img>` is a tracking pixel.
 *
 * Three signals, any of which is decisive: both dimensions are at most one pixel, the source is a
 * known measurement endpoint, or the element is hidden and has at least one pixel-sized dimension.
 */
function isTrackingPixel(attributes: readonly ScannedAttribute[]): boolean {
  const tinyWidth = isTinyDimension(attributeValue(attributes, 'width'));
  const tinyHeight = isTinyDimension(attributeValue(attributes, 'height'));
  const hidden = HIDDEN_STYLE_PATTERN.test(attributeValue(attributes, 'style') ?? '');

  return (
    (tinyWidth && tinyHeight) ||
    isTrackingUrl(attributeValue(attributes, 'src')) ||
    ((tinyWidth || tinyHeight) && hidden)
  );
}

/** Whether a frame element loads a measurement endpoint rather than content. */
function isTrackingFrame(attributes: readonly ScannedAttribute[]): boolean {
  return (
    isTrackingUrl(attributeValue(attributes, 'src')) ||
    (isTinyDimension(attributeValue(attributes, 'width')) &&
      isTinyDimension(attributeValue(attributes, 'height')))
  );
}

/** Emits a kept start tag, with the query parameters of its URL attributes stripped where needed. */
function rewriteTag(
  html: string,
  tagStart: number,
  tagEnd: number,
  attributes: readonly ScannedAttribute[],
  tally: SanitizationTally,
): string {
  let rewritten = '';
  let cursor = tagStart;

  for (const attribute of attributes) {
    if (attribute.value === null || !URL_ATTRIBUTES.has(attribute.name)) {
      continue;
    }

    const stripped = stripIdentifierParameters(attribute.value);

    if (stripped.url === attribute.value) {
      continue;
    }

    for (const parameter of stripped.strippedParameters) {
      tally.strippedParameters.add(parameter);
    }

    rewritten += html.slice(cursor, attribute.valueStart) + stripped.url;
    cursor = attribute.valueEnd;
  }

  return rewritten + html.slice(cursor, tagEnd + 1);
}

/** The end of the raw text content that follows the start tag of a raw text element. */
function rawTextEnd(html: string, name: string, from: number): number {
  const closing = new RegExp(`</${name}\\b`, 'i').exec(html.slice(from));

  return closing === null ? html.length : from + closing.index;
}

/** Skips an element with its content, from just after its start tag past its end tag. */
function skipElement(html: string, name: string, from: number): number {
  const contentEnd = rawTextEnd(html, name, from);

  if (contentEnd === html.length) {
    return html.length;
  }

  const tagEnd = findTagEnd(html, contentEnd);

  return tagEnd === -1 ? html.length : tagEnd + 1;
}

/** A URL after the identifier-like query parameters were removed from it. */
export interface StrippedUrl {
  readonly url: string;
  /** The names that were removed, in the order they appeared. */
  readonly strippedParameters: readonly string[];
}

/**
 * Removes the identifier-like query parameters from a URL and leaves everything else as written.
 *
 * Works on the query string textually rather than through `URL`, for two reasons: a relative URL has
 * no origin to parse against, and a round trip through `URLSearchParams` would re-encode the
 * parameters it keeps — turning `%20` into `+` and reordering nothing but changing bytes. Splitting
 * on `&` and keeping the untouched pairs verbatim leaves the kept part of the query identical to what
 * the Platform served.
 *
 * @param url The attribute value as written: absolute, protocol-relative or relative.
 */
export function stripIdentifierParameters(url: string): StrippedUrl {
  const queryStart = url.indexOf('?');

  if (queryStart === -1) {
    return { url, strippedParameters: [] };
  }

  const fragmentStart = url.indexOf('#', queryStart);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  const query = url.slice(queryStart + 1, queryEnd);

  if (query.length === 0) {
    return { url, strippedParameters: [] };
  }

  const strippedParameters: string[] = [];
  const keptPairs = splitQuery(query).filter((pair) => {
    const separator = pair.text.indexOf('=');
    const name = decodeParameterPart(separator === -1 ? pair.text : pair.text.slice(0, separator));
    const value = separator === -1 ? '' : decodeParameterPart(pair.text.slice(separator + 1));

    if (!isIdentifierParameter(name, value)) {
      return true;
    }

    strippedParameters.push(name);

    return false;
  });

  if (strippedParameters.length === 0) {
    return { url, strippedParameters: [] };
  }

  const prefix = url.slice(0, queryStart);
  const fragment = fragmentStart === -1 ? '' : url.slice(fragmentStart);
  const rebuiltQuery = keptPairs
    .map((pair, position) => (position === 0 ? pair.text : `${pair.separator}${pair.text}`))
    .join('');

  return {
    url: `${prefix}${rebuiltQuery.length === 0 ? '' : `?${rebuiltQuery}`}${fragment}`,
    strippedParameters,
  };
}

/** One query parameter with the separator that preceded it, which is `&` or the encoded `&amp;`. */
interface QueryPair {
  readonly separator: string;
  readonly text: string;
}

/**
 * Splits a query string into its parameters, keeping each separator as written.
 *
 * A captured document carries its parameter separators HTML-encoded — `&amp;` rather than `&` — so a
 * plain split on `&` would leave an `amp;` glued to the front of every following parameter name. The
 * separator travels with the pair so the rebuilt query keeps the spelling the Platform used.
 */
function splitQuery(query: string): readonly QueryPair[] {
  const pairs: QueryPair[] = [];
  const pattern = /&(?:amp;)?/g;
  let cursor = 0;
  let separator = '';

  for (const match of query.matchAll(pattern)) {
    pairs.push({ separator, text: query.slice(cursor, match.index) });
    separator = match[0];
    cursor = match.index + match[0].length;
  }

  pairs.push({ separator, text: query.slice(cursor) });

  return pairs;
}

/** A query parameter part with its percent and plus encoding resolved, or the raw text if it fails. */
function decodeParameterPart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/**
 * Whether a query parameter identifies the one retrieval that produced the capture.
 *
 * @param name The decoded parameter name.
 * @param value The decoded parameter value, which decides for parameters whose name says nothing —
 *   an opaque token of sufficient length is an identifier whatever it is called.
 */
export function isIdentifierParameter(name: string, value: string): boolean {
  if (PRESERVED_PARAMETER_NAMES.has(name.toLowerCase())) {
    return false;
  }

  return isIdentifierParameterName(name) || isOpaqueIdentifierValue(value);
}

/**
 * Whether a parameter name says that its value identifies something.
 *
 * Two rules: any segment of the name is one of {@link IDENTIFIER_NAME_SEGMENTS}, or the name ends in
 * `id`. The second rule catches the all-lowercase spellings a segment match misses — `visitorid`,
 * `sessid`, `clid` — and its false positives are words that end in `id` and would be a search
 * criterion, of which the four Platform have none. A Posting_Id parameter reaches this function only
 * if it is not in {@link PRESERVED_PARAMETER_NAMES}, which is where that exception is decided.
 */
export function isIdentifierParameterName(name: string): boolean {
  const segments = parameterNameSegments(name);

  if (segments.some((segment) => IDENTIFIER_NAME_SEGMENTS.has(segment))) {
    return true;
  }

  const last = segments.at(-1);

  return last !== undefined && last.length >= 3 && last.endsWith('id');
}

/** A parameter name split on `.`, `_`, `-` and camel-case boundaries, lowercased. */
function parameterNameSegments(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0);
}

/**
 * Whether a value is an opaque identifier: long enough, URL-safe throughout, and mixing letters and
 * digits the way a generated token does and a human-readable search term does not.
 */
export function isOpaqueIdentifierValue(value: string): boolean {
  return (
    value.length >= OPAQUE_VALUE_MIN_LENGTH &&
    OPAQUE_VALUE_PATTERN.test(value) &&
    /[0-9]/.test(value) &&
    /[A-Za-z]/.test(value)
  );
}
