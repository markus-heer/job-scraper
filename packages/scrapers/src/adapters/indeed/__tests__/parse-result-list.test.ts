/**
 * Reading one Indeed Result_Page (6.3, 6.5, 6.7, 7.2, 7.6, 13.5).
 *
 * Hand-written markup, not captured fixtures: the frozen Indeed fixtures and their expected
 * `RawJobPosting[]` are tasks 24.2 and 24.3. What is pinned here is the behaviour of the reader itself —
 * which characteristic wins when several overlap, what a raw posting looks like, and that no input makes
 * the reader throw, since every failure it can see already has a Platform_Status.
 *
 * The two cases the design's risk note makes the expected outcome for this Platform get the most
 * attention: a bot check page (7.6) and a sign-in wall (7.2), each in the several shapes Indeed is known
 * to serve them in, and each of them *detected and reported* rather than answered. One of those shapes
 * is Indeed's own: the Cloudflare challenge arrives with a `503` as readily as with a `403`, and the
 * test "reports a bot check for a challenge served with a 503" is what keeps that from being reported as
 * a Platform that is merely temporarily unreachable.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AdapterPageResponse } from '../../../adapter/types.js';
import {
  cleanPostingUrl,
  indeedPostingIdFromUrl,
  readIndeedResultPage,
} from '../parse-result-list.js';

const PAGE_URL = 'https://de.indeed.com/jobs?q=%22Projektmanagerin%22&l=M%C3%BCnchen';

/** An Indeed job key: 16 hexadecimal characters. */
const JOB_KEY = '1a2b3c4d5e6f7890';

/** A plain 200 response from the Result_Page URL. */
function ok(url = PAGE_URL): AdapterPageResponse {
  return { url, status: 200, headers: {} };
}

/** The reading of one page, with a 200 response unless one is given. */
function read(html: string, response: AdapterPageResponse = ok()) {
  return readIndeedResultPage({ html, response });
}

/** One Indeed job card as the Platform renders it, with its own class names and job key. */
function card(
  options: {
    jobKey?: string;
    title?: string;
    employer?: string;
    location?: string;
    published?: string;
    description?: string;
  } = {},
): string {
  const {
    jobKey = JOB_KEY,
    title = 'Projektmanagerin Pharma',
    employer = 'Beispiel GmbH',
    location = 'München',
    published = 'Vor 3 Tagen geschaltet',
    description = 'Sie steuern Projekte im Bereich Life Science.',
  } = options;

  return `
    <li>
      <div class="job_seen_beacon">
        <h2 class="jobTitle">
          <a class="jcs-JobTitle" data-jk="${jobKey}" href="/rc/clk?jk=${jobKey}&amp;from=serp&amp;tk=1iabcdef1234567890&amp;vjs=3">
            <span title="${title}">${title}</span>
          </a>
        </h2>
        <span data-testid="company-name">${employer}</span>
        <div data-testid="text-location">${location}</div>
        <span class="date">${published}</span>
        <div class="job-snippet">${description}</div>
      </div>
    </li>`;
}

/** A result list page from the given cards, with a pagination control unless suppressed. */
function resultList(cards: readonly string[], options: { nextPage?: boolean } = {}): string {
  const next =
    options.nextPage === false
      ? '<button data-testid="pagination-page-next" disabled>Weiter</button>'
      : '<a data-testid="pagination-page-next" href="/jobs?start=10">Weiter</a>';

  return `<html><body><main><ul>${cards.join('')}</ul><nav>${next}</nav></main></body></html>`;
}

describe('a readable result list', () => {
  it('reads the seven raw fields of one Job_Posting, with the click tracking removed', () => {
    const reading = read(resultList([card()]));

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.readablePostingCount).toBe(1);
    expect(reading.postings[0]).toEqual({
      postingId: JOB_KEY,
      title: 'Projektmanagerin Pharma',
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAtText: 'Vor 3 Tagen geschaltet',
      sourceUrl: `https://de.indeed.com/rc/clk?jk=${JOB_KEY}`,
      descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
    });
  });

  it('keeps the postings in page order and reports the pagination', () => {
    const reading = read(
      resultList([card({ jobKey: 'aaaa1111bbbb2222' }), card({ jobKey: 'cccc3333dddd4444' })]),
    );

    expect(reading.postings.map((posting) => posting.postingId)).toEqual([
      'aaaa1111bbbb2222',
      'cccc3333dddd4444',
    ]);
    expect(reading.hasNextPage).toBe(true);
  });

  it('reports no further page when the pagination control is disabled', () => {
    expect(read(resultList([card()], { nextPage: false })).hasNextPage).toBe(false);
  });

  it('prefers the machine-readable date over the visible relative text (6.4)', () => {
    const html = `<html><body>
      <div class="job_seen_beacon">
        <h2 class="jobTitle"><a class="jcs-JobTitle" data-jk="${JOB_KEY}" href="/viewjob?jk=${JOB_KEY}"><span title="Titel">Titel</span></a></h2>
        <time itemprop="datePosted" datetime="2026-10-20">Vor 3 Tagen geschaltet</time>
      </div></body></html>`;

    expect(read(html).postings[0]?.publishedAtText).toBe('2026-10-20');
  });

  it('keeps the relative date of the card unchanged, including the frame Indeed puts round it', () => {
    // Converting it needs the Scrape_Run start time, which this layer deliberately does not have (6.4).
    // The trailing "geschaltet" is the shared vocabulary's business: `POSTING_FRAME_SUFFIX` in
    // `../../../normalize/parse-publication-date.ts` strips it before the relative readers run, which
    // is where `./fixture-parse.test.ts` pins the resolved day.
    const reading = read(resultList([card({ published: 'Gerade geschaltet' })]));

    expect(reading.postings[0]?.publishedAtText).toBe('Gerade geschaltet');
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
      <div class="job_seen_beacon">
        <span data-testid="company-name">Beispiel GmbH</span>
      </div>
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

  it('derives the Posting_Id from the advertisement URL when no element carries the job key', () => {
    const html = `<html><body>
      <div class="job_seen_beacon">
        <h2 class="jobTitle"><a class="jcs-JobTitle" href="/viewjob?jk=abcdef0123456789&amp;from=serp"><span title="Titel">Titel</span></a></h2>
      </div></body></html>`;

    expect(read(html).postings[0]?.postingId).toBe('abcdef0123456789');
  });

  it('never reads a per-impression tracking token as a Posting_Id', () => {
    // `tk` changes on every impression, so a Posting_Id taken from it would make the upsert of 9.4
    // insert a duplicate row on every Scrape_Run instead of updating the one that is there.
    const html = `<html><body>
      <div class="job_seen_beacon">
        <h2 class="jobTitle"><a class="jcs-JobTitle" href="/rc/clk?tk=1iabcdef1234567890&amp;from=serp"><span title="Titel">Titel</span></a></h2>
      </div></body></html>`;
    const reading = read(html);

    expect(reading.postings[0]?.postingId).toBeNull();
    expect(reading.readablePostingCount).toBe(0);
  });

  it('reads the job key out of the element id of an older card layout', () => {
    const html = `<html><body>
      <div class="job_seen_beacon" id="job_fedcba9876543210">
        <h2 class="jobTitle"><a class="jcs-JobTitle" href="/rc/clk?from=serp"><span title="Titel">Titel</span></a></h2>
      </div></body></html>`;

    expect(read(html).postings[0]?.postingId).toBe('fedcba9876543210');
  });

  it('falls back to the advertisement anchor as the card where the cards themselves are gone', () => {
    const html = `<html><body><main>
      <a data-jk="${JOB_KEY}" href="/viewjob?jk=${JOB_KEY}" class="css-1m4cuuf">Projektmanagerin</a>
      </main></body></html>`;
    const reading = read(html);

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.postings[0]).toMatchObject({
      postingId: JOB_KEY,
      title: 'Projektmanagerin',
      sourceUrl: `https://de.indeed.com/viewjob?jk=${JOB_KEY}`,
      employer: null,
    });
  });

  it('reads a card published as schema.org microdata', () => {
    const html = `<html><body>
      <div itemscope itemtype="https://schema.org/JobPosting">
        <a itemprop="url" href="/viewjob?jk=${JOB_KEY}"><span itemprop="title">Projektmanagerin</span></a>
        <div itemprop="hiringOrganization"><span itemprop="name">Beispiel GmbH</span></div>
        <meta itemprop="datePosted" content="2026-10-18" />
      </div></body></html>`;
    const reading = read(html);

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.postings[0]).toMatchObject({
      postingId: JOB_KEY,
      title: 'Projektmanagerin',
      employer: 'Beispiel GmbH',
      publishedAtText: '2026-10-18',
    });
  });

  it('ignores an element of the card selector that carries no posting at all', () => {
    const html = `<html><body><div class="job_seen_beacon"></div>${card()}</body></html>`;

    expect(read(html).postings).toHaveLength(1);
  });
});

describe('a page without a readable Job_Posting', () => {
  it('reports an empty result list when Indeed states that nothing matched', () => {
    const html = `<html><body><div class="jobsearch-NoResult-messageHeader">Ihre Suche war erfolglos</div></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an empty result list from the statement alone, without the marker', () => {
    const html = `<html><body><p>Die Suche hat keine Ergebnisse ergeben.</p></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an empty result list stated on the English surface of the Platform', () => {
    const html = `<html><body><p>The search did not match any jobs.</p></body></html>`;

    expect(read(html).outcome).toBe('EMPTY_RESULT_LIST');
  });

  it('reports an unknown page layout for a page that shows something unreadable (6.7)', () => {
    // The honest limit of this reader: a result list Indeed withheld without saying so looks exactly
    // like a layout change, and 6.7 is what the requirement asks for in that case.
    const html = `<html><body><main><div class="brand-new-card">Projektmanagerin</div></main></body></html>`;

    expect(read(html).outcome).toBe('LAYOUT_UNKNOWN');
  });

  it('reports a sign-in requirement for no postings plus a sign-in prompt (7.2)', () => {
    const html = `<html><body><p>Melden Sie sich an, um alle Stellenangebote zu sehen.</p></body></html>`;

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('does not mistake the sign-in link of the page header for a sign-in wall', () => {
    const html = resultList([card()]).replace('<main>', '<header><a>Anmelden</a></header><main>');

    expect(read(html).outcome).toBe('POSTINGS');
  });
});

describe('a sign-in wall ends the retrieval (7.2)', () => {
  it('reports a sign-in requirement after a redirect to the Indeed sign-in page', () => {
    const reading = read(
      resultList([card()]),
      ok('https://secure.indeed.com/account/login?hl=de&continue=%2Fjobs'),
    );

    expect(reading.outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a sign-in requirement for a wall covering a readable list', () => {
    const html = resultList([card()]).replace(
      '<main>',
      '<div data-testid="login-wall"><p>Weiter mit Google</p></div><main>',
    );

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });

  it('reports a sign-in requirement for the sign-in form served in place of the list', () => {
    const html = `<html><body><form action="/account/login" method="post"></form></body></html>`;

    expect(read(html).outcome).toBe('SIGN_IN_REQUIRED');
  });
});

describe('a bot check ends the retrieval unanswered (7.6)', () => {
  it('reports a bot check for the Cloudflare challenge form', () => {
    const html = `<html><body><form id="challenge-form" action="/cdn-cgi/l/chk_jschl"></form></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check for the Cloudflare challenge script', () => {
    const html = `<html><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check for the German wording of the verification page', () => {
    const html = `<html><body><h1>Zusätzliche Verifizierung erforderlich</h1></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check before anything else the challenge page says', () => {
    // A challenge page carries a sign-in link and no job cards, so any other order reports the wrong
    // cause.
    const html = `<html><body><h1>Sicherheitsüberprüfung</h1><p>Melden Sie sich an, um alle Stellenangebote zu sehen.</p></body></html>`;

    expect(read(html).outcome).toBe('BOT_CHECK');
  });

  it('reports a bot check for a refused request (403), the likely Indeed case', () => {
    expect(read(resultList([card()]), { url: PAGE_URL, status: 403, headers: {} }).outcome).toBe(
      'BOT_CHECK',
    );
  });

  it('reports a bot check for a challenge served with a 503, not an unreachable Platform', () => {
    // The Indeed-specific ordering: reporting this as `PLATFORM_UNREACHABLE` would tell the user to
    // retry later for a block that answers identically every time, and 7.8 says the Job_Tool stops
    // asking instead.
    const html = `<html><body><h1>Just a moment...</h1><div id="cf-challenge-running"></div></body></html>`;

    expect(read(html, { url: PAGE_URL, status: 503, headers: {} }).outcome).toBe('BOT_CHECK');
  });

  it('keeps the postings of the page a sign-in wall or bot check sits on available to the adapter', () => {
    // 7.7 is the adapter's rule, but it can only keep what the reader hands it: a bot check carries no
    // posting, while a wall above a parsed list is reported with the pagination state intact.
    const blocked = read(`<html><body><form id="challenge-form"></form></body></html>`);
    const walled = read(
      resultList([card()]).replace('<main>', '<div data-testid="login-wall"></div><main>'),
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

  it('reports the Platform as unreachable for a server-side failure that is no challenge', () => {
    const html = `<html><body><h1>Service Unavailable</h1></body></html>`;

    expect(read(html, { url: PAGE_URL, status: 503, headers: {} }).outcome).toBe('UNREACHABLE');
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

describe('indeedPostingIdFromUrl', () => {
  it('takes the job key of an advertisement URL', () => {
    expect(indeedPostingIdFromUrl(`https://de.indeed.com/viewjob?jk=${JOB_KEY}`)).toBe(JOB_KEY);
    expect(indeedPostingIdFromUrl(`https://de.indeed.com/rc/clk?jk=${JOB_KEY}&from=serp`)).toBe(
      JOB_KEY,
    );
  });

  it('takes the job key of the result list URL of a selected posting', () => {
    expect(indeedPostingIdFromUrl(`https://de.indeed.com/jobs?q=x&vjk=${JOB_KEY}`)).toBe(JOB_KEY);
  });

  it('never reads a parameter that is not an identifier', () => {
    expect(
      indeedPostingIdFromUrl(
        'https://de.indeed.com/rc/clk?tk=1iabcdef1234567890&advn=123456789012',
      ),
    ).toBeNull();
  });

  it('never reads a value that is not a whole job key', () => {
    expect(indeedPostingIdFromUrl('https://de.indeed.com/viewjob?jk=nicht-hexadezimal')).toBeNull();
    expect(indeedPostingIdFromUrl('https://de.indeed.com/viewjob?jk=abc')).toBeNull();
  });

  it('reads the query of a relative URL', () => {
    expect(indeedPostingIdFromUrl(`/viewjob?jk=${JOB_KEY}`)).toBe(JOB_KEY);
    expect(indeedPostingIdFromUrl('/viewjob')).toBeNull();
  });
});

describe('cleanPostingUrl', () => {
  it('resolves a relative href against the page URL and drops the tracking parameters', () => {
    expect(
      cleanPostingUrl(
        `/rc/clk?jk=${JOB_KEY}&from=serp&tk=1iabcdef1234567890&vjs=3&fccid=abc&utm_source=mail`,
        PAGE_URL,
      ),
    ).toBe(`https://de.indeed.com/rc/clk?jk=${JOB_KEY}`);
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
          const reading = readIndeedResultPage({
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
