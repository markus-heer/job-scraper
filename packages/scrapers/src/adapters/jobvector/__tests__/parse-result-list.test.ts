/**
 * Reading one Jobvector Result_Page (6.3, 6.5, 6.7, 7.2, 7.6, 13.5).
 *
 * Hand-written markup, not captured fixtures: the frozen Jobvector fixtures and their expected
 * `RawJobPosting[]` are task 10.3. What is pinned here is the behaviour of the reader itself — which
 * characteristic wins when several overlap, what a raw posting looks like, and that no input makes the
 * reader throw, since every failure it can see already has a Platform_Status.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AdapterPageResponse } from '../../../adapter/types.js';
import {
  cleanPostingUrl,
  jobvectorPostingIdFromUrl,
  readJobvectorResultPage,
} from '../parse-result-list.js';

const PAGE_URL = 'https://www.jobvector.de/jobs/?keyword=%22Projektmanagerin%22';

/** A plain 200 response from the Result_Page URL. */
function ok(url = PAGE_URL): AdapterPageResponse {
  return { url, status: 200, headers: {} };
}

/** The reading of one page, with a 200 response unless one is given. */
function read(html: string, response: AdapterPageResponse = ok()) {
  return readJobvectorResultPage({ html, response });
}

/** One Jobvector job card as the Platform publishes it, with the JobPosting microdata. */
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
    id = '123456',
    title = 'Projektmanagerin Pharma',
    employer = 'Beispiel GmbH',
    location = 'München',
    published = 'vor 3 Tagen',
    datetime,
    description = 'Sie steuern Projekte im Bereich Life Science.',
  } = options;
  const date =
    datetime === undefined
      ? `<span itemprop="datePosted">${published}</span>`
      : `<time itemprop="datePosted" datetime="${datetime}">${published}</time>`;

  return `
    <li itemscope itemtype="https://schema.org/JobPosting" data-jobid="${id}">
      <h2><a itemprop="url" href="/stellenangebote/${id}-projektmanagerin/?ref=jobliste"><span itemprop="title">${title}</span></a></h2>
      <div itemprop="hiringOrganization"><span itemprop="name">${employer}</span></div>
      <div itemprop="jobLocation"><span itemprop="addressLocality">${location}</span></div>
      ${date}
      <p itemprop="description">${description}</p>
    </li>`;
}

/** A result list page from the given cards, with a pagination control unless suppressed. */
function resultList(cards: readonly string[], options: { nextPage?: boolean } = {}): string {
  const next =
    options.nextPage === false
      ? '<a rel="next" aria-disabled="true">Weiter</a>'
      : '<a rel="next" href="/jobs/?keyword=x&amp;page=2">Weiter</a>';

  return `<html><body><main><ul>${cards.join('')}</ul>${next}</main></body></html>`;
}

describe('a readable result list', () => {
  it('reads the seven raw fields of one Job_Posting, with the click tracking removed', () => {
    const reading = read(resultList([card()]));

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.readablePostingCount).toBe(1);
    expect(reading.postings[0]).toEqual({
      postingId: '123456',
      title: 'Projektmanagerin Pharma',
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAtText: 'vor 3 Tagen',
      sourceUrl: 'https://www.jobvector.de/stellenangebote/123456-projektmanagerin/',
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

  it('reads the publication date from the microdata content attribute as well', () => {
    const html = `<html><body>
      <li itemscope itemtype="https://schema.org/JobPosting" data-jobid="123456">
        <h2><a itemprop="url" href="/stellenangebote/123456-x/"><span itemprop="title">Titel</span></a></h2>
        <meta itemprop="datePosted" content="2026-10-18" />
      </li></body></html>`;

    expect(read(html).postings[0]?.publishedAtText).toBe('2026-10-18');
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
      <li itemscope itemtype="https://schema.org/JobPosting" data-jobid="999999">
        <div itemprop="hiringOrganization"><span itemprop="name">Beispiel GmbH</span></div>
      </li>
      ${card({ id: '123456' })}
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
      <li itemscope itemtype="https://schema.org/JobPosting">
        <h2><a itemprop="url" href="/jobs/?jobId=654321"><span itemprop="title">Titel</span></a></h2>
      </li></body></html>`;

    expect(read(html).postings[0]?.postingId).toBe('654321');
  });

  it('reads the advertisement URL from a microdata content attribute', () => {
    const html = `<html><body>
      <li itemscope itemtype="https://schema.org/JobPosting" data-jobid="123456">
        <span itemprop="title">Titel</span>
        <meta itemprop="url" content="https://www.jobvector.de/stellenangebote/123456-x/" />
      </li></body></html>`;

    expect(read(html).postings[0]?.sourceUrl).toBe(
      'https://www.jobvector.de/stellenangebote/123456-x/',
    );
  });

  it('falls back to the class-based selectors when the microdata is gone', () => {
    const html = `<html><body><main>
      <article class="job-item" data-job-id="777777">
        <h2><a href="/stellenangebote/777777-projektmanagerin/">Projektmanagerin</a></h2>
        <span class="company">Beispiel GmbH</span>
        <span class="location">München</span>
        <span class="date">vor 1 Tag</span>
      </article></main></body></html>`;
    const reading = read(html);

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.postings[0]).toMatchObject({
      postingId: '777777',
      title: 'Projektmanagerin',
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAtText: 'vor 1 Tag',
    });
  });

  it('ignores an element of the card selector that carries no posting at all', () => {
    const html = `<html><body><li itemscope itemtype="https://schema.org/JobPosting"></li>${card()}</body></html>`;

    expect(read(html).postings).toHaveLength(1);
  });
});

describe('a page without a readable Job_Posting', () => {
  it('reports an empty result list when Jobvector states that nothing matched', () => {
    const html = `<html><body><div class="no-results">Ihre Suche war erfolglos</div></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an empty result list from the statement alone, without the marker', () => {
    const html = `<html><body><p>Wir haben keine Stellenangebote gefunden.</p></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an empty result list stated on the English surface of the Platform', () => {
    const html = `<html><body><p>Sorry, no jobs found for your search.</p></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an unknown page layout for a page that shows something unreadable (6.7)', () => {
    const html = `<html><body><main><div class="brand-new-card">Projektmanagerin</div></main></body></html>`;

    expect(read(html).outcome).toBe('LAYOUT_UNKNOWN');
  });

  it('reports a sign-in requirement for no postings plus a sign-in prompt (7.2)', () => {
    const html = `<html><body><p>Bitte anmelden, um alle Stellenangebote zu sehen.</p></body></html>`;

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
      ok('https://www.jobvector.de/bewerberlogin/?returnUrl=/jobs/'),
    );

    expect(reading.outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a sign-in requirement for an overlay covering a readable list (7.2)', () => {
    const html = resultList([card()]).replace(
      '<main>',
      '<div class="login-wall">Nur für angemeldete Nutzer</div><main>',
    );

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a bot check for a Captcha page (7.6)', () => {
    const html = `<html><body><form action="/captcha"><iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe></form></body></html>`;

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

describe('jobvectorPostingIdFromUrl', () => {
  it('takes the allow-listed identifier parameter of a query-shaped advertisement URL', () => {
    expect(jobvectorPostingIdFromUrl('https://www.jobvector.de/jobs/?jobId=123456')).toBe('123456');
  });

  it('takes the last long number of a readable advertisement path', () => {
    expect(
      jobvectorPostingIdFromUrl(
        'https://www.jobvector.de/stellenangebote/123456-projektmanagerin-muenchen/',
      ),
    ).toBe('123456');
  });

  it('never reads a parameter that is not an identifier, where a value changes per impression', () => {
    expect(
      jobvectorPostingIdFromUrl('https://www.jobvector.de/jobs/98765432?ref=1_2_31415926'),
    ).toBe('98765432');
    expect(jobvectorPostingIdFromUrl('https://www.jobvector.de/jobs/?ref=31415926')).toBeNull();
  });

  it('searches a relative URL as a path', () => {
    expect(jobvectorPostingIdFromUrl('/stellenangebote/123456-x/')).toBe('123456');
  });
});

describe('cleanPostingUrl', () => {
  it('resolves a relative href against the page URL and drops the tracking parameters', () => {
    expect(
      cleanPostingUrl(
        '/stellenangebote/123456-x/?ref=liste&utm_source=mail&jobId=123456',
        PAGE_URL,
      ),
    ).toBe('https://www.jobvector.de/stellenangebote/123456-x/?jobId=123456');
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
          const reading = readJobvectorResultPage({
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
