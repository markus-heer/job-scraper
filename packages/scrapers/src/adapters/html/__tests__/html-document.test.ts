/**
 * The HTML reading layer the adapter parsers sit on.
 *
 * The two properties the parsers depend on are pinned here: the layer is total over arbitrary input
 * (so an unreadable Result_Page becomes `PAGE_LAYOUT_UNKNOWN` instead of a thrown error, 6.7), and
 * text and attributes arrive collapsed with "blank" reported as absent (6.8).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  attributeOf,
  collapseWhitespace,
  containsAnyPhrase,
  parseHtml,
  queryAllFirst,
  queryFirst,
  textOf,
} from '../html-document.js';

const CARD_HTML = `
<html>
  <head>
    <style>.card { color: red }</style>
    <script>const prompt = "Bitte anmelden, um alle Treffer zu sehen";</script>
  </head>
  <body>
    <article data-at="job-item" data-id="12345">
      <h2><a data-at="job-item-title" href="/stellenangebote--Projektmanagerin--12345-inline.html">
        Projektmanagerin&nbsp;Pharma
      </a></h2>
      <span data-at="job-item-company-name">   </span>
      <a class="no-target">Mehr</a>
      <a class="no-target" href="/jobs?page=2">Weiter</a>
    </article>
    <article data-at="job-item" data-id="67890">
      <h2><a data-at="job-item-title" href="/stellenangebote--Projektleiter--67890-inline.html">Projektleiter</a></h2>
    </article>
  </body>
</html>`;

describe('parseHtml', () => {
  it('collapses the text of an element and decodes its entities', () => {
    const document = parseHtml(CARD_HTML);

    expect(textOf(document, ['[data-at="job-item-title"]'])).toBe('Projektmanagerin Pharma');
  });

  it('keeps script and style content out of the text, so a phrase cannot match code', () => {
    const document = parseHtml(CARD_HTML);

    expect(document.text()).not.toContain('Bitte anmelden');
    expect(document.text()).not.toContain('color: red');
    expect(containsAnyPhrase(document.text(), ['bitte anmelden, um'])).toBe(false);
  });

  it('reports a whitespace-only text and a whitespace-only attribute as absent', () => {
    const document = parseHtml(CARD_HTML);

    expect(textOf(document, ['[data-at="job-item-company-name"]'])).toBeNull();
    expect(
      parseHtml('<div data-at="x" data-id="   ">text</div>')
        .query('[data-at="x"]')
        ?.attribute('data-id'),
    ).toBeNull();
  });

  it('lowercases tag names', () => {
    expect(parseHtml('<SECTION><P>t</P></SECTION>').query('p')?.tagName).toBe('p');
  });

  it('answers an empty tree for empty and for malformed HTML instead of throwing', () => {
    expect(parseHtml('').text()).toBe('');
    expect(parseHtml('<<< <div class="a">b').text()).toContain('b');
    expect(parseHtml('<div><span>unclosed').query('span')?.text()).toBe('unclosed');
  });

  it('is total over arbitrary input: no string makes the reading layer throw', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const document = parseHtml(html);

        expect(typeof document.text()).toBe('string');
        expect(queryAllFirst(document, ['[data-at="job-item"]', 'article'])).toBeInstanceOf(Array);
        expect(attributeOf(document, ['a'], 'href')).toSatisfy(
          (value: unknown) => value === null || typeof value === 'string',
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe('selector candidate lists', () => {
  it('queryFirst takes the first selector that matches, not the first element in the document', () => {
    const document = parseHtml(CARD_HTML);

    expect(queryFirst(document, ['.missing', 'a.no-target', 'h2'])?.tagName).toBe('a');
    expect(queryFirst(document, ['.missing', '.also-missing'])).toBeNull();
  });

  it('queryAllFirst takes every element of one selector, never mixing two candidate sets', () => {
    const document = parseHtml(CARD_HTML);
    const cards = queryAllFirst(document, ['.missing', '[data-at="job-item"]', 'h2']);

    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.attribute('data-id'))).toEqual(['12345', '67890']);
    expect(queryAllFirst(document, ['.missing'])).toEqual([]);
  });

  it('attributeOf skips matching elements that do not carry the attribute', () => {
    const document = parseHtml(CARD_HTML);

    expect(attributeOf(document, ['a.no-target'], 'href')).toBe('/jobs?page=2');
    expect(attributeOf(document, ['a.no-target'], 'data-missing')).toBeNull();
  });
});

describe('collapseWhitespace', () => {
  it('replaces every whitespace run, including a non-breaking space, with one space', () => {
    expect(collapseWhitespace('  a\n\t b\u00a0c  ')).toBe('a b c');
    expect(collapseWhitespace(' \n ')).toBe('');
  });
});

describe('containsAnyPhrase', () => {
  it('compares case-insensitively and reports no phrase as no match', () => {
    expect(containsAnyPhrase('Bitte ANMELDEN, um alle Treffer zu sehen', ['anmelden, um'])).toBe(
      true,
    );
    expect(containsAnyPhrase('Projektmanagerin', ['captcha'])).toBe(false);
    expect(containsAnyPhrase('Projektmanagerin', [])).toBe(false);
  });
});
