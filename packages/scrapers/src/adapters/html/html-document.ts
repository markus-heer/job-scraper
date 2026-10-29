/**
 * The HTML reading layer every Platform_Adapter parser sits on.
 *
 * A Platform_Adapter receives the HTML of a Result_Page as a string ({@link AdapterPage.html}) and has
 * to pull the eight fields of 6.3 out of it. That needs a parser with CSS selector support, and this
 * module is the one place in the repository that knows which parser that is.
 *
 * ## Why a façade rather than importing the parser everywhere
 *
 * Four adapters will read four result lists, and the design expects their selectors to drift (Risk 12)
 * and to be repaired against frozen fixtures. Two things follow:
 *
 * - every adapter needs the same three operations — "find the elements matching this selector", "give
 *   me the collapsed text of this element", "give me this attribute" — so they are written once here;
 * - a parser swap stays a change to this file. The adapters are typed against {@link HtmlNode}, which
 *   names no library type, so nothing outside this module mentions the dependency.
 *
 * ## Why `node-html-parser`
 *
 * Decided here as the repository precedent, because this is the first module that needs an HTML parser:
 *
 * - *It parses a string, not a stream, and returns a queryable tree.* That is exactly the shape of the
 *   problem: the Playwright runtime already handed over a finished document.
 * - *Small dependency surface.* Two runtime dependencies (`css-select` for the selector engine,
 *   `entities` for entity decoding). `cheerio`, the obvious alternative, pulls `parse5`, `htmlparser2`,
 *   `undici`, `whatwg-mimetype` and more — an HTTP client and a spec-complete tree builder the Job_Tool
 *   has no use for, since Playwright does the fetching and the markup comes from a real browser.
 * - *Tolerant of broken markup, and non-throwing.* A captured Result_Page is frequently truncated or
 *   malformed; a parser that threw would turn a layout change (6.7, `PAGE_LAYOUT_UNKNOWN`) into an
 *   unexpected adapter error. `parseHtml('')` answers an empty tree, which is the behaviour this layer
 *   relies on and which its test pins down.
 * - *Native ESM with bundled type declarations*, so it fits the package without a `@types` entry.
 *
 * What it deliberately is not: a DOM. There is no layout, no `getComputedStyle` and no script
 * execution, so "an overlay covering the result list" (7.2) can only ever be detected structurally, by
 * the markers a Platform renders. That limitation belongs to the adapters and is noted in their
 * detection tables rather than worked around here.
 *
 * ## Conventions this module fixes
 *
 * - **Text is collapsed and trimmed.** Every run of whitespace — including the `&nbsp;` a Platform uses
 *   for layout — becomes one space. A Result_Page is pretty-printed markup, so the raw text of a cell
 *   is full of newlines and indentation that no Job_Posting field should carry.
 * - **Blank is absent.** A text or attribute that is empty after trimming is reported as `null`, which
 *   is the "field the Platform does not show" of {@link RawJobPosting} and the "marked as empty" of 6.8.
 * - **`<script>` and `<style>` text is not text.** Their content is dropped at parse time, so a
 *   detection phrase such as "Anmelden" cannot match a JavaScript string literal instead of the page.
 */

import { type HTMLElement as ParsedElement, parse } from 'node-html-parser';

/**
 * Parse options of {@link parseHtml}.
 *
 * `blockTextElements` with `false` per tag is what keeps script, style and noscript *content* out of
 * the text of the document; `pre` stays `true` because a preformatted block can carry a description
 * text. Comments are dropped: no Job_Posting field is ever inside one, and keeping them would let a
 * commented-out sign-in banner trip a detection phrase.
 */
const PARSE_OPTIONS = {
  comment: false,
  // A captured or truncated Result_Page frequently ends mid-element. Parsing the unclosed tag still
  // yields the job card it opened, which is one posting more than dropping it would.
  parseNoneClosedTags: true,
  blockTextElements: { script: false, style: false, noscript: false, pre: true },
} as const;

/**
 * One element of a parsed Result_Page, reduced to what a parser reads from it.
 *
 * Named after what it is for rather than after the library behind it: an adapter parser types against
 * this interface only, which is what makes the parser choice above replaceable and lets a test hand in
 * a hand-written tree if it ever needs to.
 */
export interface HtmlNode {
  /** The lowercased tag name, for example `article`. */
  readonly tagName: string;
  /** The first descendant matching `selector`, or `null`. */
  query(selector: string): HtmlNode | null;
  /** Every descendant matching `selector`, in document order. */
  queryAll(selector: string): readonly HtmlNode[];
  /** The attribute value, collapsed and trimmed, or `null` where it is absent or blank. */
  attribute(name: string): string | null;
  /** The text of this element and its descendants, collapsed and trimmed. May be empty. */
  text(): string;
}

/** Every run of whitespace, including the non-breaking space a Platform uses for layout. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * `value` with every whitespace run replaced by one space and the ends trimmed.
 *
 * Exported because the adapters need the same normalization on text they did not get through an
 * {@link HtmlNode} — the page URL, a response header, a phrase they compare against.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').trim();
}

/** The collapsed value, or `null` where there was nothing but whitespace. */
function blankToNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const collapsed = collapseWhitespace(value);

  return collapsed.length === 0 ? null : collapsed;
}

/** {@link HtmlNode} over one element of the parsed tree. The only place the library type appears. */
class ParsedHtmlNode implements HtmlNode {
  readonly #element: ParsedElement;

  constructor(element: ParsedElement) {
    this.#element = element;
  }

  get tagName(): string {
    // The parser reports tag names uppercased; lowercase is what HTML authors and selectors read like.
    return this.#element.tagName.toLowerCase();
  }

  query(selector: string): HtmlNode | null {
    const found = this.#element.querySelector(selector);

    return found === null ? null : new ParsedHtmlNode(found);
  }

  queryAll(selector: string): readonly HtmlNode[] {
    return this.#element.querySelectorAll(selector).map((element) => new ParsedHtmlNode(element));
  }

  attribute(name: string): string | null {
    return blankToNull(this.#element.getAttribute(name));
  }

  text(): string {
    return collapseWhitespace(this.#element.text);
  }
}

/**
 * Parses the HTML of one Result_Page into a queryable tree.
 *
 * Total over every input: malformed, truncated and empty HTML all answer a tree rather than throwing,
 * so an unreadable page becomes the `PAGE_LAYOUT_UNKNOWN` of 6.7 instead of an unexpected error.
 *
 * @param html The HTML as the Platform served it.
 * @returns The document root. Its {@link HtmlNode.query} searches the whole document.
 */
export function parseHtml(html: string): HtmlNode {
  return new ParsedHtmlNode(parse(html, PARSE_OPTIONS));
}

/**
 * The first element matching any of `selectors`, trying them in order.
 *
 * The ordered list is how an adapter survives a partial layout change: the selector a Platform
 * currently renders comes first, the ones it rendered before stay behind it as fallbacks. Order is
 * selector precedence, not document order — the first *selector* that matches anything wins, even if a
 * later selector would match an earlier element.
 */
export function queryFirst(root: HtmlNode, selectors: readonly string[]): HtmlNode | null {
  for (const selector of selectors) {
    const found = root.query(selector);

    if (found !== null) {
      return found;
    }
  }

  return null;
}

/**
 * Every element matching the first of `selectors` that matches anything, in document order.
 *
 * Used for the posting cards of a Result_Page: all cards come from one selector, so a stale fallback
 * selector cannot mix a second, differently shaped set of elements into the same page.
 */
export function queryAllFirst(root: HtmlNode, selectors: readonly string[]): readonly HtmlNode[] {
  for (const selector of selectors) {
    const found = root.queryAll(selector);

    if (found.length > 0) {
      return found;
    }
  }

  return [];
}

/** The collapsed text of the first matching element, or `null` where none matched or it was blank. */
export function textOf(root: HtmlNode, selectors: readonly string[]): string | null {
  const found = queryFirst(root, selectors);

  if (found === null) {
    return null;
  }

  const text = found.text();

  return text.length === 0 ? null : text;
}

/**
 * The attribute of the first element that matches a selector *and* carries that attribute.
 *
 * Both conditions together, because a selector list for an href walks over `<a>` elements that may
 * carry none; stopping at the first match would then report `null` while a later candidate holds the
 * value.
 */
export function attributeOf(
  root: HtmlNode,
  selectors: readonly string[],
  attribute: string,
): string | null {
  for (const selector of selectors) {
    for (const element of root.queryAll(selector)) {
      const value = element.attribute(attribute);

      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}

/** Whether `haystack` contains any of `phrases`, compared case-insensitively. */
export function containsAnyPhrase(haystack: string, phrases: readonly string[]): boolean {
  const lowered = haystack.toLowerCase();

  return phrases.some((phrase) => lowered.includes(phrase.toLowerCase()));
}
