/**
 * Reading one Stepstone Result_Page (6.3, 6.5, 6.7, 7.2, 7.6, 13.5).
 *
 * Hand-written markup, not captured fixtures: the frozen Stepstone fixtures and their expected
 * `RawJobPosting[]` are task 9.3. What is pinned here is the behaviour of the reader itself — which
 * characteristic wins when several overlap, what a raw posting looks like, and that no input makes the
 * reader throw, since every failure it can see already has a Platform_Status.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AdapterPageResponse } from '../../../adapter/types.js';
import {
  cleanPostingUrl,
  readStepstoneResultPage,
  stepstonePostingIdFromUrl,
} from '../parse-result-list.js';

const PAGE_URL = 'https://www.stepstone.de/jobs/projektmanagerin/in-muenchen';

/** A plain 200 response from the Result_Page URL. */
function ok(url = PAGE_URL): AdapterPageResponse {
  return { url, status: 200, headers: {} };
}

/** The reading of one page, with a 200 response unless one is given. */
function read(html: string, response: AdapterPageResponse = ok()) {
  return readStepstoneResultPage({ html, response });
}

/** One Stepstone job card as the Platform renders it. */
function card(
  options: {
    id?: string;
    title?: string;
    employer?: string;
    location?: string;
    published?: string;
    datetime?: string;
    description?: string;
  } = {},
): string {
  const {
    id = '12345678',
    title = 'Projektmanagerin Pharma',
    employer = 'Beispiel GmbH',
    location = 'München',
    published = 'vor 3 Tagen',
    datetime,
    description = 'Sie steuern Projekte im Bereich Life Science.',
  } = options;
  const date =
    datetime === undefined
      ? `<span data-at="job-item-timeago">${published}</span>`
      : `<time data-at="job-item-timeago" datetime="${datetime}">${published}</time>`;

  return `
    <article data-at="job-item" data-id="${id}">
      <h2><a data-at="job-item-title" href="/stellenangebote--Projektmanagerin-Muenchen--${id}-inline.html?rltr=1_2_3">${title}</a></h2>
      <span data-at="job-item-company-name">${employer}</span>
      <span data-at="job-item-location">${location}</span>
      ${date}
      <p data-at="job-item-description">${description}</p>
    </article>`;
}

/** A result list page from the given cards, with a pagination control unless suppressed. */
function resultList(cards: readonly string[], options: { nextPage?: boolean } = {}): string {
  const next =
    options.nextPage === false
      ? '<a data-at="pagination-next" aria-disabled="true">Weiter</a>'
      : '<a data-at="pagination-next" href="/jobs/projektmanagerin/in-muenchen?page=2">Weiter</a>';

  return `<html><body><main>${cards.join('')}${next}</main></body></html>`;
}

describe('a readable result list', () => {
  it('reads the seven raw fields of one Job_Posting, with the click tracking removed', () => {
    const reading = read(resultList([card()]));

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.readablePostingCount).toBe(1);
    expect(reading.postings[0]).toEqual({
      postingId: '12345678',
      title: 'Projektmanagerin Pharma',
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAtText: 'vor 3 Tagen',
      sourceUrl:
        'https://www.stepstone.de/stellenangebote--Projektmanagerin-Muenchen--12345678-inline.html',
      descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
    });
  });

  it('keeps the postings in page order and reports the pagination', () => {
    const reading = read(resultList([card({ id: '111111' }), card({ id: '222222' })]));

    expect(reading.postings.map((posting) => posting.postingId)).toEqual(['111111', '222222']);
    expect(reading.hasNextPage).toBe(true);
  });

  it('reports no further page when the pagination control is disabled', () => {
    expect(read(resultList([card()], { nextPage: false })).hasNextPage).toBe(false);
  });

  it('prefers the machine-readable date over the visible relative text (6.4)', () => {
    const reading = read(resultList([card({ datetime: '2026-10-20', published: 'vor 3 Tagen' })]));

    expect(reading.postings[0]?.publishedAtText).toBe('2026-10-20');
  });

  it('marks an absent optional field as absent and keeps the posting (6.8)', () => {
    const reading = read(
      resultList([card({ employer: '  ', location: '', published: '', description: '' })]),
    );

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.postings[0]).toMatchObject({
      employer: null,
      workLocation: null,
      publishedAtText: null,
      descriptionText: null,
      title: 'Projektmanagerin Pharma',
    });
  });

  it('hands on a card without a title as unreadable rather than discarding it (6.5)', () => {
    const html = `<html><body>
      <article data-at="job-item" data-id="999999">
        <span data-at="job-item-company-name">Beispiel GmbH</span>
      </article>
      ${card({ id: '12345678' })}
      </body></html>`;
    const reading = read(html);

    expect(reading.postings).toHaveLength(2);
    expect(reading.readablePostingCount).toBe(1);
    // The discard itself, and its Log_Stream entry, belong to the normalization stage of 6.5.
    expect(reading.postings[0]).toMatchObject({
      title: null,
      sourceUrl: null,
      employer: 'Beispiel GmbH',
    });
  });

  it('derives the Posting_Id from the advertisement URL when the card carries none', () => {
    const html = `<html><body>
      <article data-at="job-item">
        <h2><a data-at="job-item-title" href="/stellenangebote--Projektmanagerin--7654321-inline.html">Titel</a></h2>
      </article></body></html>`;

    expect(read(html).postings[0]?.postingId).toBe('7654321');
  });

  it('ignores an element of the card selector that carries no posting at all', () => {
    const html = `<html><body><div data-at="job-item"></div>${card()}</body></html>`;

    expect(read(html).postings).toHaveLength(1);
  });
});

describe('a page without a readable Job_Posting', () => {
  it('reports an empty result list when Stepstone states that nothing matched', () => {
    const html = `<html><body><div data-at="no-results">Leider keine Treffer</div></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an empty result list from the statement alone, without the marker', () => {
    const html = `<html><body><p>Wir haben keine passenden Jobs gefunden.</p></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an unknown page layout for a page that shows something unreadable (6.7)', () => {
    const html = `<html><body><main><div class="brand-new-card">Projektmanagerin</div></main></body></html>`;

    expect(read(html).outcome).toBe('LAYOUT_UNKNOWN');
  });

  it('reports a sign-in requirement for no postings plus a sign-in prompt (7.2)', () => {
    const html = `<html><body><p>Bitte anmelden, um alle Treffer zu sehen.</p></body></html>`;

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('does not mistake the sign-in link of the page header for a sign-in wall', () => {
    const html = resultList([card()]).replace('<main>', '<header><a>Anmelden</a></header><main>');

    expect(read(html).outcome).toBe('POSTINGS');
  });
});

describe('a page that ends the retrieval', () => {
  it('reports a sign-in requirement after a redirect to the sign-in page (7.2)', () => {
    const reading = read(
      resultList([card()]),
      ok('https://www.stepstone.de/candidate/login?returnUrl=/jobs'),
    );

    expect(reading.outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a sign-in requirement for an overlay covering a readable list (7.2)', () => {
    const html = resultList([card()]).replace(
      '<main>',
      '<div data-at="login-wall">Nur für angemeldete Nutzer</div><main>',
    );

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a bot check for a Captcha page (7.6)', () => {
    const html = `<html><body><form action="/captcha"><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></form></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check before anything else the challenge page says', () => {
    const html = `<html><body><h1>Sind Sie ein Mensch?</h1><p>Bitte anmelden, um alle Treffer zu sehen.</p></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check for a refused request (403)', () => {
    expect(read(resultList([card()]), { url: PAGE_URL, status: 403, headers: {} }).outcome).toBe(
      'BOT_CHECK',
    );
  });

  it('reports a fetch rate limit for status 429 (13.5)', () => {
    const reading = read(resultList([card()]), {
      url: PAGE_URL,
      status: 429,
      headers: { 'retry-after': '120' },
    });

    expect(reading.outcome).toBe('RATE_LIMITED');
    expect(reading.postings).toEqual([]);
  });

  it('reports a fetch rate limit for an exhausted quota header on a 200 response', () => {
    const reading = read(resultList([card()]), {
      url: PAGE_URL,
      status: 200,
      headers: { 'x-ratelimit-remaining': '0' },
    });

    expect(reading.outcome).toBe('RATE_LIMITED');
  });

  it('ignores a Retry-After header on a successful response', () => {
    const reading = read(resultList([card()]), {
      url: PAGE_URL,
      status: 200,
      headers: { 'retry-after': '60' },
    });

    expect(reading.outcome).toBe('POSTINGS');
  });

  it('reports a fetch rate limit stated in the page body', () => {
    const html = `<html><body><h1>Zu viele Anfragen</h1></body></html>`;

    expect(read(html).outcome).toBe('RATE_LIMITED');
  });

  it('reports the Platform as unreachable for a server-side failure', () => {
    expect(read('<html></html>', { url: PAGE_URL, status: 503, headers: {} }).outcome).toBe(
      'UNREACHABLE',
    );
  });

  it('reports an unknown layout for a result list URL the Platform no longer serves', () => {
    expect(read('<html></html>', { url: PAGE_URL, status: 404, headers: {} }).outcome).toBe(
      'LAYOUT_UNKNOWN',
    );
  });

  it('reads the page when the navigation reported no status at all', () => {
    expect(read(resultList([card()]), { url: PAGE_URL, status: null, headers: {} }).outcome).toBe(
      'POSTINGS',
    );
  });
});

describe('stepstonePostingIdFromUrl', () => {
  it('takes the number behind the last double hyphen of an advertisement path', () => {
    expect(
      stepstonePostingIdFromUrl(
        'https://www.stepstone.de/stellenangebote--Projektmanagerin-Muenchen-Beispiel-GmbH--12345678-inline.html',
      ),
    ).toBe('12345678');
  });

  it('falls back to the last long number of the path', () => {
    expect(stepstonePostingIdFromUrl('https://www.stepstone.de/jobs/98765432')).toBe('98765432');
  });

  it('never reads the query string, where a tracking value changes per impression', () => {
    expect(
      stepstonePostingIdFromUrl('https://www.stepstone.de/jobs/98765432?rltr=1_2_31415926'),
    ).toBe('98765432');
    expect(stepstonePostingIdFromUrl('https://www.stepstone.de/jobs?rltr=1_2_31415926')).toBeNull();
  });
});

describe('cleanPostingUrl', () => {
  it('resolves a relative href against the page URL and drops the tracking parameters', () => {
    expect(
      cleanPostingUrl('/stellenangebote--x--12345-inline.html?rltr=1&intcid=7&foo=bar', PAGE_URL),
    ).toBe('https://www.stepstone.de/stellenangebote--x--12345-inline.html?foo=bar');
  });

  it('answers null for an href that is no URL at all', () => {
    expect(cleanPostingUrl('http://[', PAGE_URL)).toBeNull();
    expect(cleanPostingUrl('', PAGE_URL)).toBe(PAGE_URL);
  });
});

describe('totality', () => {
  it('answers a reading for arbitrary HTML, status and headers, and never throws', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
        fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
        (html, status, headers) => {
          const reading = readStepstoneResultPage({
            html,
            response: { url: PAGE_URL, status, headers },
          });

          expect(reading.postings.length).toBeGreaterThanOrEqual(reading.readablePostingCount);
          expect(typeof reading.hasNextPage).toBe('boolean');
        },
      ),
      { numRuns: 200 },
    );
  });
});
