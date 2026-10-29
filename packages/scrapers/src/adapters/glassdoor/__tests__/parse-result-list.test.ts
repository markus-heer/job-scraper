/**
 * Reading one Glassdoor Result_Page (6.3, 6.5, 6.7, 7.2, 7.6, 13.5).
 *
 * Hand-written markup, not captured fixtures: the frozen Glassdoor fixtures and their expected
 * `RawJobPosting[]` are task 23.3. What is pinned here is the behaviour of the reader itself — which
 * characteristic wins when several overlap, what a raw posting looks like, and that no input makes the
 * reader throw, since every failure it can see already has a Platform_Status.
 *
 * The two cases the design's risk note makes the expected outcome for this Platform get the most
 * attention: a bot check page (7.6) and a sign-in wall (7.2), each in the several shapes Glassdoor is
 * known to serve them in, and each of them *detected and reported* rather than answered.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AdapterPageResponse } from '../../../adapter/types.js';
import {
  cleanPostingUrl,
  glassdoorPostingIdFromUrl,
  readGlassdoorResultPage,
} from '../parse-result-list.js';

const PAGE_URL = 'https://www.glassdoor.de/Job/jobs.htm?sc.keyword=%22Projektmanagerin%22';

/** A plain 200 response from the Result_Page URL. */
function ok(url = PAGE_URL): AdapterPageResponse {
  return { url, status: 200, headers: {} };
}

/** The reading of one page, with a 200 response unless one is given. */
function read(html: string, response: AdapterPageResponse = ok()) {
  return readGlassdoorResultPage({ html, response });
}

/** One Glassdoor job card as the Platform renders it, with its `data-test` attributes. */
function card(
  options: {
    id?: string;
    title?: string;
    employer?: string;
    location?: string;
    published?: string;
    description?: string;
  } = {},
): string {
  const {
    id = '1009123456789',
    title = 'Projektmanagerin Pharma',
    employer = 'Beispiel GmbH',
    location = 'München',
    published = 'vor 3 Tagen',
    description = 'Sie steuern Projekte im Bereich Life Science.',
  } = options;

  return `
    <li data-test="jobListing" data-jobid="${id}">
      <a data-test="job-link" href="/job-listing/projektmanagerin-beispiel-gmbh-JV_IC2622109_KO0,16.htm?jl=${id}&amp;src=GD_JOB_AD&amp;pos=101">
        <span data-test="job-title">${title}</span>
      </a>
      <span data-test="emp-name">${employer}</span>
      <div data-test="emp-location">${location}</div>
      <div data-test="job-age">${published}</div>
      <div data-test="descSnippet">${description}</div>
    </li>`;
}

/** A result list page from the given cards, with a pagination control unless suppressed. */
function resultList(cards: readonly string[], options: { nextPage?: boolean } = {}): string {
  const next =
    options.nextPage === false
      ? '<button data-test="pagination-next" disabled>Weiter</button>'
      : '<button data-test="pagination-next">Weiter</button>';

  return `<html><body><main><ul>${cards.join('')}</ul>${next}</main></body></html>`;
}

describe('a readable result list', () => {
  it('reads the seven raw fields of one Job_Posting, with the click tracking removed', () => {
    const reading = read(resultList([card()]));

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.readablePostingCount).toBe(1);
    expect(reading.postings[0]).toEqual({
      postingId: '1009123456789',
      title: 'Projektmanagerin Pharma',
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAtText: 'vor 3 Tagen',
      sourceUrl:
        'https://www.glassdoor.de/job-listing/projektmanagerin-beispiel-gmbh-JV_IC2622109_KO0,16.htm?jl=1009123456789',
      descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
    });
  });

  it('keeps the postings in page order and reports the pagination', () => {
    const reading = read(
      resultList([card({ id: '1009111111111' }), card({ id: '1009222222222' })]),
    );

    expect(reading.postings.map((posting) => posting.postingId)).toEqual([
      '1009111111111',
      '1009222222222',
    ]);
    expect(reading.hasNextPage).toBe(true);
  });

  it('reports no further page when the pagination control is disabled', () => {
    expect(read(resultList([card()], { nextPage: false })).hasNextPage).toBe(false);
  });

  it('prefers the machine-readable date over the visible relative text (6.4)', () => {
    const html = `<html><body>
      <li data-test="jobListing" data-jobid="1009123456789">
        <a data-test="job-link" href="/job-listing/x-1009123456789.htm"><span data-test="job-title">Titel</span></a>
        <time itemprop="datePosted" datetime="2026-10-20">vor 3 Tagen</time>
      </li></body></html>`;

    expect(read(html).postings[0]?.publishedAtText).toBe('2026-10-20');
  });

  it('keeps the relative date of the card unchanged where that is all Glassdoor shows (6.4)', () => {
    // Converting it needs the Scrape_Run start time, which this layer deliberately does not have.
    expect(read(resultList([card({ published: 'vor 1 Tag' })])).postings[0]?.publishedAtText).toBe(
      'vor 1 Tag',
    );
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
      <li data-test="jobListing" data-jobid="1009999999999">
        <span data-test="emp-name">Beispiel GmbH</span>
      </li>
      ${card()}
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
      <li data-test="jobListing">
        <a data-test="job-link" href="/partner/jobListing.htm?jobListingId=1009654321000"><span data-test="job-title">Titel</span></a>
      </li></body></html>`;

    expect(read(html).postings[0]?.postingId).toBe('1009654321000');
  });

  it('falls back to the hashed class names of the card when the data-test attributes are gone', () => {
    const html = `<html><body><main>
      <li class="JobsList_jobListItem__wjTHv" data-id="1009777777777">
        <a class="JobCard_jobTitle__GLyJ1" href="/job-listing/projektmanagerin-1009777777777.htm">Projektmanagerin</a>
        <span class="EmployerProfile_compactEmployerName__9MGcV">Beispiel GmbH</span>
        <div class="JobCard_location__rCz3x">München</div>
        <div class="JobCard_listingAge__Ny_nG">vor 1 Tag</div>
      </li></main></body></html>`;
    const reading = read(html);

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.postings[0]).toMatchObject({
      postingId: '1009777777777',
      title: 'Projektmanagerin',
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAtText: 'vor 1 Tag',
    });
  });

  it('reads a card published as schema.org microdata', () => {
    const html = `<html><body>
      <div itemscope itemtype="https://schema.org/JobPosting">
        <a itemprop="url" href="/job-listing/x-1009123456789.htm"><span itemprop="title">Projektmanagerin</span></a>
        <div itemprop="hiringOrganization"><span itemprop="name">Beispiel GmbH</span></div>
        <meta itemprop="datePosted" content="2026-10-18" />
      </div></body></html>`;
    const reading = read(html);

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.postings[0]).toMatchObject({
      postingId: '1009123456789',
      title: 'Projektmanagerin',
      employer: 'Beispiel GmbH',
      publishedAtText: '2026-10-18',
    });
  });

  it('ignores an element of the card selector that carries no posting at all', () => {
    const html = `<html><body><li data-test="jobListing"></li>${card()}</body></html>`;

    expect(read(html).postings).toHaveLength(1);
  });
});

describe('a page without a readable Job_Posting', () => {
  it('reports an empty result list when Glassdoor states that nothing matched', () => {
    const html = `<html><body><div data-test="no-results">Ihre Suche war erfolglos</div></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an empty result list from the statement alone, without the marker', () => {
    const html = `<html><body><p>Wir haben keine Jobs gefunden, die Ihrer Suche entsprechen.</p></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an empty result list stated on the English surface of the Platform', () => {
    const html = `<html><body><p>Sorry, no jobs found for your search.</p></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an unknown page layout for a page that shows something unreadable (6.7)', () => {
    // The honest limit of this reader: a result list Glassdoor withheld without saying so looks
    // exactly like a layout change, and 6.7 is what the requirement asks for in that case.
    const html = `<html><body><main><div class="brand-new-card">Projektmanagerin</div></main></body></html>`;

    expect(read(html).outcome).toBe('LAYOUT_UNKNOWN');
  });

  it('reports a sign-in requirement for no postings plus a sign-in prompt (7.2)', () => {
    const html = `<html><body><p>Melden Sie sich an, um alle Jobs zu sehen.</p></body></html>`;

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('does not mistake the sign-in link of the page header for a sign-in wall', () => {
    const html = resultList([card()]).replace('<main>', '<header><a>Anmelden</a></header><main>');

    expect(read(html).outcome).toBe('POSTINGS');
  });
});

describe('a sign-in wall ends the retrieval (7.2)', () => {
  it('reports a sign-in requirement after a redirect to the Glassdoor sign-in page', () => {
    const reading = read(
      resultList([card()]),
      ok('https://www.glassdoor.de/profile/login_input.htm?userOriginHook=JOB_LISTING'),
    );

    expect(reading.outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a sign-in requirement after a redirect to the registration page', () => {
    expect(
      read(resultList([card()]), ok('https://www.glassdoor.de/profile/join_input.htm')).outcome,
    ).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a sign-in requirement for the hardsell wall covering a readable list', () => {
    const html = resultList([card()]).replace(
      '<main>',
      '<div id="HardsellOverlay"><p>Weiter mit Google</p></div><main>',
    );

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a sign-in requirement for the content wall of the result list', () => {
    const html = resultList([card()]).replace(
      '<main>',
      '<div class="ContentWall_wall__3mD2x"></div><main>',
    );

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });
});

describe('a bot check ends the retrieval unanswered (7.6)', () => {
  it('reports a bot check for the Captcha element of the bot protection', () => {
    const html = `<html><body><div id="px-captcha"></div><p>Bitte bestätigen Sie, dass Sie kein Roboter sind.</p></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check for the challenge script of the bot protection', () => {
    const html = `<html><body><script src="https://captcha.px-cloud.net/main.js"></script></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check for the Glassdoor security page wording', () => {
    const html = `<html><body><h1>Help Us Protect Glassdoor</h1></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check before anything else the challenge page says', () => {
    // A challenge page carries a sign-in link and no job cards, so any other order reports the
    // wrong cause.
    const html = `<html><body><h1>Sicherheitsüberprüfung</h1><p>Melden Sie sich an, um alle Jobs zu sehen.</p></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check for a refused request (403), the likely Glassdoor case', () => {
    expect(read(resultList([card()]), { url: PAGE_URL, status: 403, headers: {} }).outcome).toBe(
      'BOT_CHECK',
    );
  });

  it('keeps the postings of the page a sign-in wall or bot check sits on available to the adapter', () => {
    // 7.7 is the adapter's rule, but it can only keep what the reader hands it: a bot check carries
    // no posting, while a wall above a parsed list is reported with the pagination state intact.
    const blocked = read(`<html><body><div id="px-captcha"></div></body></html>`);
    const walled = read(
      resultList([card()]).replace('<main>', '<div id="HardsellOverlay"></div><main>'),
    );

    expect(blocked.postings).toEqual([]);
    expect(blocked.hasNextPage).toBe(false);
    expect(walled.outcome).toBe('SIGN_IN_REQUIRED');
    expect(walled.hasNextPage).toBe(true);
  });
});

describe('a response that ends the retrieval', () => {
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

describe('glassdoorPostingIdFromUrl', () => {
  it('takes the allow-listed identifier parameter of an advertisement URL', () => {
    expect(
      glassdoorPostingIdFromUrl('https://www.glassdoor.de/job-listing/x.htm?jl=1009123456789'),
    ).toBe('1009123456789');
    expect(
      glassdoorPostingIdFromUrl(
        'https://www.glassdoor.de/partner/jobListing.htm?jobListingId=1009123456789',
      ),
    ).toBe('1009123456789');
  });

  it('takes the long number of a readable advertisement path', () => {
    expect(
      glassdoorPostingIdFromUrl(
        'https://www.glassdoor.de/job-listing/projektmanagerin-muenchen-1009123456789.htm',
      ),
    ).toBe('1009123456789');
  });

  it('never reads the city identifier of a Glassdoor path as a Posting_Id', () => {
    // `IC2622109` is the city, shared by every posting of that city: reading it would give many
    // Job_Posting the same Posting_Id and the upsert of 9.4 would overwrite one with another.
    expect(
      glassdoorPostingIdFromUrl(
        'https://www.glassdoor.de/job-listing/projektmanagerin-beispiel-JV_IC2622109_KO0,16_KE17,28.htm',
      ),
    ).toBeNull();
  });

  it('never reads a parameter that is not an identifier, where a value changes per impression', () => {
    expect(
      glassdoorPostingIdFromUrl(
        'https://www.glassdoor.de/job-listing/x.htm?src=GD_JOB_AD&pos=31415926',
      ),
    ).toBeNull();
  });

  it('searches a relative URL as a path', () => {
    expect(glassdoorPostingIdFromUrl('/job-listing/x-1009123456789.htm')).toBe('1009123456789');
  });
});

describe('cleanPostingUrl', () => {
  it('resolves a relative href against the page URL and drops the tracking parameters', () => {
    expect(
      cleanPostingUrl(
        '/job-listing/x.htm?jl=1009123456789&src=GD_JOB_AD&pos=101&guid=0000018b&utm_source=mail',
        PAGE_URL,
      ),
    ).toBe('https://www.glassdoor.de/job-listing/x.htm?jl=1009123456789');
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
          const reading = readGlassdoorResultPage({
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
