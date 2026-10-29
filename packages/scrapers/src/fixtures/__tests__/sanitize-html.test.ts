import { describe, expect, it } from 'vitest';

import {
  isIdentifierParameter,
  isOpaqueIdentifierValue,
  isTrackingUrl,
  sanitizeFixtureHtml,
  stripIdentifierParameters,
} from '../sanitize-html.js';

/** A result list of the shape the adapters parse, with everything a real page carries around it. */
const RESULT_LIST = `<!doctype html>
<html lang="de">
  <head>
    <title>Projektmanagerin Jobs</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <link rel="canonical" href="https://www.example.com/jobs/projektmanagerin" />
    <style>.result { color: red }</style>
    <script type="application/javascript">window.__BOT_CHECK__ = 1;</script>
  </head>
  <body>
    <ol class="results">
      <li data-posting-id="12345">
        <a href="/stellenangebote--Projektmanagerin-Muenchen--12345-inline.html?sessionId=abc123def456ghi789&amp;page=1">Projektmanagerin</a>
        <span class="employer">Pharma AG</span>
      </li>
    </ol>
    <img src="/tracking/pixel.gif?visitorId=9f8e7d6c5b4a3210" width="1" height="1" alt="" />
    <iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC" width="0" height="0"></iframe>
    <script src="/assets/app.js"></script>
  </body>
</html>
`;

describe('sanitizeFixtureHtml', () => {
  it('removes scripts, styles, stylesheet links and tracking elements from a captured page', () => {
    const { html, report } = sanitizeFixtureHtml(RESULT_LIST);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('__BOT_CHECK__');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('app.css');
    expect(html).not.toContain('pixel.gif');
    expect(html).not.toContain('googletagmanager');
    expect(report).toMatchObject({
      scriptsRemoved: 2,
      stylesRemoved: 2,
      trackingPixelsRemoved: 2,
    });
  });

  it('keeps the posting markup and the fields the parser reads byte for byte', () => {
    const { html } = sanitizeFixtureHtml(RESULT_LIST);

    expect(html).toContain('<li data-posting-id="12345">');
    expect(html).toContain('>Projektmanagerin</a>');
    expect(html).toContain('<span class="employer">Pharma AG</span>');
    expect(html).toContain('<title>Projektmanagerin Jobs</title>');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('--12345-inline.html');
  });

  it('strips the session identifier from a posting link and keeps the page parameter', () => {
    const { html, report } = sanitizeFixtureHtml(RESULT_LIST);

    expect(html).not.toContain('sessionId');
    expect(html).toContain('-inline.html?page=1');
    expect(report.strippedParameters).toEqual(['sessionId']);
  });

  it('is idempotent: sanitizing a stored fixture again changes nothing', () => {
    const once = sanitizeFixtureHtml(RESULT_LIST).html;
    const twice = sanitizeFixtureHtml(once).html;

    expect(twice).toBe(once);
  });

  it('leaves a document without scripts, styles or identifiers completely unchanged', () => {
    const plain = '<!doctype html><html lang="de"><body><ol class="results"></ol></body></html>';

    expect(sanitizeFixtureHtml(plain).html).toBe(plain);
  });

  it('removes a script that the capture truncated before its end tag', () => {
    const { html, report } = sanitizeFixtureHtml('<body><p>Treffer</p><script>var a = 1;');

    expect(html).toBe('<body><p>Treffer</p>');
    expect(report.scriptsRemoved).toBe(1);
  });

  it('does not mistake a less-than sign in text content for a tag', () => {
    const text = '<p>Gehalt < 60.000 EUR</p>';

    expect(sanitizeFixtureHtml(text).html).toBe(text);
  });

  it('keeps a comment and a doctype, which belong to the captured document', () => {
    const document = '<!doctype html><!-- captured list --><body></body>';

    expect(sanitizeFixtureHtml(document).html).toBe(document);
  });

  it('keeps an image that is content rather than a measurement request', () => {
    const logo = '<img src="/logos/pharma-ag.png" width="120" height="60" alt="Pharma AG" />';

    expect(sanitizeFixtureHtml(logo).html).toBe(logo);
  });

  it('removes a hidden one-pixel image even without a tracking URL', () => {
    const pixel = '<img src="/i.gif" width="1" style="display:none" alt="" />';

    expect(sanitizeFixtureHtml(pixel).html).toBe('');
  });

  it('strips identifier parameters from a form action and leaves the query otherwise intact', () => {
    const form = '<form action="/jobs/search?utm_source=mail&amp;q=Projektmanagerin"></form>';
    const { html } = sanitizeFixtureHtml(form);

    expect(html).toBe('<form action="/jobs/search?q=Projektmanagerin"></form>');
  });

  it('drops the whole query string when every parameter was an identifier', () => {
    const link = '<a href="/jobs?sid=1&amp;trackingToken=abc">Treffer</a>';

    expect(sanitizeFixtureHtml(link).html).toBe('<a href="/jobs">Treffer</a>');
  });

  it('leaves a non-URL attribute alone even when it looks like an identifier', () => {
    const element = '<li data-posting-id="aB3xY7zQ91ttKKmm22" class="result"></li>';

    expect(sanitizeFixtureHtml(element).html).toBe(element);
  });
});

describe('stripIdentifierParameters', () => {
  it('keeps a Posting_Id parameter, because the parser has to read it', () => {
    expect(stripIdentifierParameters('/vacancy?jobId=4711&sessionId=deadbeefdeadbeef01')).toEqual({
      url: '/vacancy?jobId=4711',
      strippedParameters: ['sessionId'],
    });
  });

  it('keeps the fragment and the path of a rewritten URL', () => {
    expect(
      stripIdentifierParameters('https://www.example.com/jobs?page=2&gclid=abc123#results').url,
    ).toBe('https://www.example.com/jobs?page=2#results');
  });

  it('reports no change for a URL without a query string', () => {
    expect(stripIdentifierParameters('/jobs/projektmanagerin')).toEqual({
      url: '/jobs/projektmanagerin',
      strippedParameters: [],
    });
  });

  it('leaves the encoding of kept parameters untouched', () => {
    expect(stripIdentifierParameters('/jobs?ke=Projekt%20Managerin&uid=1234abcd5678efgh').url).toBe(
      '/jobs?ke=Projekt%20Managerin',
    );
  });
});

describe('isIdentifierParameter', () => {
  it('recognises identifier and campaign parameter names', () => {
    expect(isIdentifierParameter('sessionId', '1')).toBe(true);
    expect(isIdentifierParameter('utm_medium', 'email')).toBe(true);
    expect(isIdentifierParameter('user-id', '7')).toBe(true);
  });

  it('leaves search criteria and paging parameters alone', () => {
    expect(isIdentifierParameter('page', '2')).toBe(false);
    expect(isIdentifierParameter('radius', '50')).toBe(false);
    expect(isIdentifierParameter('ke', 'Projektmanagerin')).toBe(false);
  });

  it('strips an opaque value whatever the parameter is called', () => {
    expect(isIdentifierParameter('ctx', 'f3a9c1d84b7e2056')).toBe(true);
  });
});

describe('isOpaqueIdentifierValue', () => {
  it('accepts a long mixed token and a uuid', () => {
    expect(isOpaqueIdentifierValue('f3a9c1d84b7e2056')).toBe(true);
    expect(isOpaqueIdentifierValue('0f2c6a21-8d3e-4b55-9a77-1c0de5f4b812')).toBe(true);
  });

  it('rejects a readable value, a short value and a value with spaces', () => {
    expect(isOpaqueIdentifierValue('Projektmanagerin')).toBe(false);
    expect(isOpaqueIdentifierValue('a1b2')).toBe(false);
    expect(isOpaqueIdentifierValue('Projekt Managerin 2024')).toBe(false);
  });
});

describe('isTrackingUrl', () => {
  it('recognises measurement endpoints', () => {
    expect(isTrackingUrl('https://www.google-analytics.com/collect')).toBe(true);
    expect(isTrackingUrl('/beacon?e=1')).toBe(true);
  });

  it('leaves a content URL alone', () => {
    expect(isTrackingUrl('/assets/logo.svg')).toBe(false);
    expect(isTrackingUrl(undefined)).toBe(false);
  });
});
