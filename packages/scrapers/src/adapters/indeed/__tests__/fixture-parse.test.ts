/**
 * The Indeed parser against the frozen fixtures (6.3, 6.4, 6.5, 6.7, 6.8, 7.2, 7.6, 13.5).
 *
 * The companion of `./parse-result-list.test.ts`: that file pins the *rules* of the reader with
 * hand-written snippets, this one reads the eight stored Result_Page of `../__fixtures__/` and compares
 * the whole reading against the expectation stored next to each document. Nothing here builds markup,
 * which is the point — when Indeed changes its page, the fixture and its `.expected.json` are replaced
 * together and this suite reports exactly what the parser now reads differently.
 *
 * ## One captured document, and it is the block
 *
 * This folder is the inverse of the Glassdoor one. There the readable Result_Page is the capture and the
 * blocking cases are hand-authored; here **`captcha` is the capture** — HTTP 403 and a Cloudflare
 * security check, which is what de.indeed.com served the Job_Tool on 2026-10-29 — and every readable
 * page is written by hand. No Indeed result list has ever reached this repository.
 *
 * A green run of this suite therefore says the parser is correct about documents of this *shape*. It
 * says nothing about Indeed rendering that shape. `../__fixtures__/README.md` records which document is
 * which, and the provenance block below asserts that record rather than trusting it, so a hand-authored
 * document can never quietly claim to be a capture.
 *
 * ## Where each requirement is observable
 *
 * - **6.3 and 6.4 on `result-list-page-1`**, the `data-testid` layout, whose four cards carry every
 *   optional field and state their age in the framed wording Indeed uses ("Vor 3 Tagen geschaltet").
 * - **6.5 and 6.8 on `result-list-page-2`**, the legacy `job_seen_beacon` layout, which carries the two
 *   cards the normalization stage discards and the two absent optional fields it marks as empty.
 * - **6.4 in full on `relative-dates`**, all eight wordings including the two bounded forms and the card
 *   that states no date at all.
 * - **6.9 on none of them.** Since `POSTING_FRAME_SUFFIX` entered the shared vocabulary in task 24.2,
 *   every wording these fixtures carry resolves. The unparsable-date path is pinned where it belongs, in
 *   `../../../normalize/__tests__/parse-publication-date.test.ts`.
 *
 * The one assertion worth calling out is "classifies the captured 403 from its body alone": the document
 * announces itself as a security check in its text as well as through its status, which is what the
 * Indeed-specific ordering in `../parse-result-list.ts` needs in order to report a challenge served with
 * a `503` as the block it is rather than as a Platform that is briefly unreachable.
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_OVERRIDES,
  resolveSearchProfile,
} from '@job-scraper/domain';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RawJobPosting } from '../../../adapter/types.js';
import {
  type FixtureExpectation,
  readFixtureExpectation,
} from '../../../fixtures/fixture-expectations.js';
import { listFixtureCases, readFixture } from '../../../fixtures/fixture-files.js';
import type { FixtureCaptureMetadata } from '../../../fixtures/fixture-metadata.js';
import {
  missingFixtureCases,
  platformFixtureDir,
  REQUIRED_FIXTURE_CASES,
} from '../../../fixtures/fixture-paths.js';
import {
  FIELD_LIMITS,
  type NormalizationOutcome,
  type NormalizedJobPosting,
  normalizePosting,
} from '../../../normalize/normalize-posting.js';
import { parsePublicationDate } from '../../../normalize/parse-publication-date.js';
import { readIndeedResultPage } from '../parse-result-list.js';
import { indeedResultListUrl } from '../result-list-url.js';

/** The effective Search_Profile of Indeed as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('INDEED', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Indeed profile does not resolve.');
  }

  return resolution.profile;
})();

/** The cases that came from a real retrieval. Everything else is hand-authored (see the header). */
const CAPTURED_CASES: readonly string[] = ['captcha'];

/** The day the captured document was served, as its `.capture.json` sidecar states it. */
const CAPTURE_DAY = '2026-10-29';

/** A fixture with its expectation, as the table-driven cases below read them. */
interface LoadedCase {
  readonly fixtureCase: string;
  readonly html: string;
  readonly metadata: FixtureCaptureMetadata | undefined;
  readonly expectation: FixtureExpectation;
}

const loaded = new Map<string, LoadedCase>();

/** The fixture of one case, loaded once in {@link beforeAll}. */
function fixture(fixtureCase: string): LoadedCase {
  const entry = loaded.get(fixtureCase);

  if (entry === undefined) {
    throw new Error(`The fixture ${fixtureCase} was not loaded.`);
  }

  return entry;
}

/** The reading of one fixture, with the response the expectation declares. */
function readFixtureCase(
  fixtureCase: string,
  overrides: { url?: string; status?: number | null } = {},
) {
  const { html, expectation } = fixture(fixtureCase);

  return readIndeedResultPage({
    html,
    // The URL the adapter would have asked for, so the source URLs resolve against the Platform
    // origin rather than against the fixture server of the adapter tests.
    response: {
      url: overrides.url ?? indeedResultListUrl(PROFILE, expectation.pageNumber),
      status: overrides.status === undefined ? expectation.response.status : overrides.status,
      headers: expectation.response.headers,
    },
  });
}

/** The normalized postings of a fixture, for the stages after the reader. */
function normalizeFixture(fixtureCase: string): readonly NormalizationOutcome[] {
  return readFixtureCase(fixtureCase).postings.map((posting) =>
    normalizePosting('INDEED', posting, RUN_STARTED_AT, parsePublicationDate),
  );
}

type AcceptedOutcome = Extract<NormalizationOutcome, { kind: 'ACCEPTED' }>;

type DiscardedOutcome = Extract<NormalizationOutcome, { kind: 'DISCARDED' }>;

function isAccepted(outcome: NormalizationOutcome): outcome is AcceptedOutcome {
  return outcome.kind === 'ACCEPTED';
}

function isDiscarded(outcome: NormalizationOutcome): outcome is DiscardedOutcome {
  return outcome.kind === 'DISCARDED';
}

/** The accepted Job_Posting of a fixture, in page order. */
function acceptedPostings(fixtureCase: string): readonly NormalizedJobPosting[] {
  return normalizeFixture(fixtureCase)
    .filter(isAccepted)
    .map((outcome) => outcome.posting);
}

/**
 * The Scrape_Run start time the relative dates of 6.4 are resolved against: 29.10.2026, 09:30.
 *
 * The day the one captured document was served, so the framed day counts of the hand-authored pages
 * resolve to the days a reader of such a page on that day would have arrived at.
 */
const RUN_STARTED_AT = new Date(2026, 9, 29, 9, 30);

/** Local time of one day at 09:30, which is the time of day a relative date keeps. */
function at0930(month: number, day: number): Date {
  return new Date(2026, month - 1, day, 9, 30);
}

beforeAll(async () => {
  for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
    const { html, metadata } = await readFixture({ platform: 'INDEED', fixtureCase });

    loaded.set(fixtureCase, {
      fixtureCase,
      html,
      metadata,
      expectation: await readFixtureExpectation({ platform: 'INDEED', fixtureCase }),
    });
  }
});

describe('the stored fixtures', () => {
  it('cover every case the design requires', async () => {
    const present = await listFixtureCases(platformFixtureDir('INDEED'));

    expect(missingFixtureCases(present)).toEqual([]);
  });

  it('each state which case they belong to and where they came from', () => {
    for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
      const { expectation } = fixture(fixtureCase);

      expect(expectation.case).toBe(fixtureCase);
      expect(expectation.provenance).toBe(
        CAPTURED_CASES.includes(fixtureCase) ? 'CAPTURED' : 'HAND_AUTHORED',
      );
    }
  });

  it('carry a capture sidecar exactly where they claim to be captured', () => {
    for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
      const { expectation, metadata } = fixture(fixtureCase);

      // A claimed capture without its sidecar, or a sidecar for a hand-authored document, would make
      // the provenance table of ../__fixtures__/README.md a claim nobody checks.
      expect(metadata === undefined).toBe(expectation.provenance === 'HAND_AUTHORED');
    }
  });

  it('record the one real retrieval with its day, its 403 and the Job_Tool user agent (14.5)', () => {
    const { metadata } = fixture('captcha');

    expect(metadata?.platform).toBe('INDEED');
    expect(metadata?.capturedAt.slice(0, 10)).toBe(CAPTURE_DAY);
    expect(metadata?.httpStatus).toBe(403);
    expect(metadata?.userAgent).toMatch(/^JobTool\//);
    // The probe that reached the Platform at all was the one without `radius=`; the URL it asked for
    // is the evidence behind the retrieval scope of `../result-list-url.ts`.
    expect(metadata?.requestUrl).not.toContain('radius=');
    expect(metadata?.requestUrl).not.toContain('start=');
  });

  it('claim no readable Indeed result list anywhere', () => {
    // The honest state of this Platform: the only document that came from Indeed is the block. A test
    // that asserted otherwise would be the one way this folder could start lying.
    for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
      const { expectation } = fixture(fixtureCase);

      if (expectation.readablePostingCount > 0) {
        expect(expectation.provenance).toBe('HAND_AUTHORED');
      }
    }
  });
});

describe.each(REQUIRED_FIXTURE_CASES)('the fixture %s', (fixtureCase) => {
  it('is read exactly as its expectation states', () => {
    const { expectation } = fixture(fixtureCase);
    const reading = readFixtureCase(fixtureCase);

    expect(reading.outcome).toBe(expectation.outcome);
    expect(reading.hasNextPage).toBe(expectation.hasNextPage);
    expect(reading.readablePostingCount).toBe(expectation.readablePostingCount);
    expect(reading.postings).toEqual(expectation.postings);
  });

  it('is read the same way twice, from the same bytes', () => {
    expect(readFixtureCase(fixtureCase)).toEqual(readFixtureCase(fixtureCase));
  });
});

describe('the first stored Result_Page (6.2, 6.3)', () => {
  it('yields four readable Job_Posting, every one of them with a job key of its own', () => {
    const reading = readFixtureCase('result-list-page-1');
    const ids = reading.postings.map((posting) => posting.postingId);

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.readablePostingCount).toBe(4);
    expect(reading.postings).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);

    for (const id of ids) {
      // An Indeed job key: a whole hexadecimal token. A Posting_Id read from a per-impression token
      // would make the upsert of 9.4 insert a duplicate row on every Scrape_Run.
      expect(id).toMatch(/^[0-9a-f]{16}$/u);
    }
  });

  it('strips the per-impression tracking of all three click-through link shapes', () => {
    const urls = readFixtureCase('result-list-page-1').postings.map((posting) => posting.sourceUrl);

    // `/rc/clk`, `/pagead/clk` and `/viewjob` are the three shapes the document carries, and each one
    // reduces to its job key — which is what keeps the Content_Hash of an unchanged posting stable
    // across Scrape_Run (15.4).
    expect(urls).toEqual([
      'https://de.indeed.com/rc/clk?jk=1a2b3c4d5e6f7890',
      'https://de.indeed.com/rc/clk?jk=2b3c4d5e6f7890a1',
      'https://de.indeed.com/pagead/clk?jk=3c4d5e6f7890a1b2',
      'https://de.indeed.com/viewjob?jk=4d5e6f7890a1b2c3',
    ]);
  });

  it('reads the title out of the title attribute, not out of the screen-reader text', () => {
    // One card renders its title as `<span data-testid="jobTitle" title="…">Jetzt bewerben: …</span>`,
    // so the visible text carries a phrase that is no part of the job title.
    expect(fixture('result-list-page-1').html).toContain('Jetzt bewerben: ');

    for (const posting of readFixtureCase('result-list-page-1').postings) {
      expect(posting.title).not.toContain('Jetzt bewerben');
    }
  });

  it('accepts all four postings, with the eight fields of 6.3', () => {
    const outcomes = normalizeFixture('result-list-page-1');
    const accepted = outcomes.filter(isAccepted);

    expect(outcomes).toHaveLength(4);
    expect(accepted).toHaveLength(4);
    expect(accepted[0]?.posting).toEqual<NormalizedJobPosting>({
      platform: 'INDEED',
      postingId: '1a2b3c4d5e6f7890',
      title: 'Projektmanagerin Pharma (m/w/d)',
      employer: 'Beispiel Pharma GmbH',
      workLocation: 'München',
      publishedAt: at0930(10, 26),
      sourceUrl: 'https://de.indeed.com/rc/clk?jk=1a2b3c4d5e6f7890',
      descriptionText:
        'Sie steuern klinische Entwicklungsprojekte von der Planung bis zur Zulassung und koordinieren interne wie externe Projektbeteiligte.',
    });
  });

  it('keeps every field of every posting within the upper limits of 6.3', () => {
    for (const posting of acceptedPostings('result-list-page-1')) {
      expect(posting.title.length).toBeLessThanOrEqual(FIELD_LIMITS.title);
      expect(posting.employer?.length ?? 0).toBeLessThanOrEqual(FIELD_LIMITS.employer);
      expect(posting.workLocation?.length ?? 0).toBeLessThanOrEqual(FIELD_LIMITS.workLocation);
      expect(posting.descriptionText?.length ?? 0).toBeLessThanOrEqual(
        FIELD_LIMITS.descriptionText,
      );
    }
  });

  it('discards no posting of that page (6.5)', () => {
    expect(normalizeFixture('result-list-page-1').filter(isDiscarded)).toEqual([]);
  });
});

describe('the publication dates of the first stored page (6.4)', () => {
  it('resolves the framed wording of every card', () => {
    const dates = acceptedPostings('result-list-page-1').map((posting) => posting.publishedAt);

    // The wording Indeed frames its dates in — "Vor 3 Tagen geschaltet", "Gerade geschaltet" — which
    // `POSTING_FRAME_SUFFIX` in the shared vocabulary strips. None of the cards may fall back to the
    // empty publication date of 6.9.
    expect(dates.filter((date) => date === null)).toEqual([]);
  });

  it('reads each of the four wordings as the day it states', () => {
    const accepted = acceptedPostings('result-list-page-1');

    expect(accepted[0]?.publishedAt).toEqual(at0930(10, 26)); // "Vor 3 Tagen geschaltet"
    expect(accepted[1]?.publishedAt).toEqual(RUN_STARTED_AT); // "Gerade geschaltet"
    expect(accepted[2]?.publishedAt).toEqual(at0930(9, 29)); // "Vor mehr als 30 Tagen geschaltet"
    expect(accepted[3]?.publishedAt).toEqual(RUN_STARTED_AT); // "Heute"
  });

  it('dates no posting after the start of the Scrape_Run', () => {
    for (const posting of acceptedPostings('result-list-page-1')) {
      expect(posting.publishedAt?.getTime()).toBeLessThanOrEqual(RUN_STARTED_AT.getTime());
    }
  });
});

describe('pagination across the two stored result list pages (6.3, 13.3)', () => {
  it('offers a further page on page 1 and none on page 2', () => {
    // Page 2 renders the "next" control and marks it `aria-disabled`, which is how a result list marks
    // its end rather than removing the control.
    expect(readFixtureCase('result-list-page-1').hasNextPage).toBe(true);
    expect(readFixtureCase('result-list-page-2').hasNextPage).toBe(false);
    expect(fixture('result-list-page-2').html).toContain('aria-disabled');
  });

  it('yields disjoint Posting_Id, so the pages are two pages and not the same one twice', () => {
    const first = readFixtureCase('result-list-page-1').postings.map((p) => p.postingId);
    const second = readFixtureCase('result-list-page-2').postings.map((p) => p.postingId);
    const shared = first.filter((id) => id !== null && second.includes(id));

    expect(first).toHaveLength(4);
    expect(shared).toEqual([]);
  });

  it('reads both layouts, so a layout change costs the page and not the Platform', () => {
    // Page 1 is the `data-testid` layout and page 2 the legacy `job_seen_beacon` one. The selector
    // tables carry both, in that order, which is what makes a layout change a one-line repair.
    expect(fixture('result-list-page-1').html).toContain('data-testid="slider_item"');
    expect(fixture('result-list-page-2').html).toContain('class="job_seen_beacon"');
    expect(readFixtureCase('result-list-page-1').outcome).toBe('POSTINGS');
    expect(readFixtureCase('result-list-page-2').outcome).toBe('POSTINGS');
  });
});

describe('discarding incomplete postings of a stored page (6.5)', () => {
  it('discards exactly the cards missing title, source URL or Posting_Id, naming the field', () => {
    const outcomes = normalizeFixture('result-list-page-2');
    const discarded = outcomes.filter(isDiscarded);

    expect(outcomes).toHaveLength(5);
    expect(discarded.map((outcome) => outcome.field)).toEqual(['title', 'sourceUrl']);

    for (const outcome of discarded) {
      expect(outcome.code).toBe('posting.discardedMissingField');
      expect(outcome.platform).toBe('INDEED');
      // 6.5 asks for the platform name and the source URL in the Log_Stream, so a discard that names
      // neither would be unreportable.
      expect(outcome.sourceUrl === null || outcome.sourceUrl.length > 0).toBe(true);
    }
  });

  it('keeps every readable posting of that page, with the fields of 6.3', () => {
    const accepted = acceptedPostings('result-list-page-2');

    expect(accepted).toHaveLength(fixture('result-list-page-2').expectation.readablePostingCount);
    expect(accepted[0]).toEqual<NormalizedJobPosting>({
      platform: 'INDEED',
      postingId: '5e6f7890a1b2c3d4',
      title: 'Projektmanagerin Klinische Studien (m/w/d)',
      employer: 'Epsilon Pharma GmbH',
      workLocation: 'München',
      publishedAt: at0930(10, 24),
      sourceUrl: 'https://de.indeed.com/viewjob?jk=5e6f7890a1b2c3d4',
      descriptionText:
        'Sie planen und überwachen klinische Studien der Phasen II und III und berichten an die Leitung Clinical Operations.',
    });
  });

  it('reads the Posting_Id out of the advertisement URL where the card carries no job key', () => {
    // One card of that page has no `data-jk`, so its Posting_Id comes from the `jk` parameter of its
    // own link — the allow-listed identifier parameter, never a tracking token.
    expect(fixture('result-list-page-2').html).toContain('jk=90a1b2c3d4e5f678');
    expect(acceptedPostings('result-list-page-2').at(-1)?.postingId).toBe('90a1b2c3d4e5f678');
  });

  it('marks an absent optional field as empty and passes the posting on (6.8)', () => {
    const accepted = acceptedPostings('result-list-page-2');
    const withoutEmployer = accepted.find((posting) => posting.employer === null);
    const withoutDescription = accepted.find((posting) => posting.descriptionText === null);

    expect(withoutEmployer?.postingId).toBe('6f7890a1b2c3d4e5');
    expect(withoutEmployer?.title).toBe('Teilprojektleiterin Qualitätssicherung (m/w/d)');
    expect(withoutEmployer?.workLocation).toBe('Garching bei München');
    expect(withoutDescription?.postingId).toBe('90a1b2c3d4e5f678');
    expect(withoutDescription?.title).toBe('Project Lead Biotech (m/w/d)');
  });
});

describe('the publication date wordings of a stored page (6.4, 6.8)', () => {
  /** The absolute publication date of one posting of the `relative-dates` fixture. */
  function publishedAt(postingId: string): Date | null {
    const accepted = acceptedPostings('relative-dates').find(
      (posting) => posting.postingId === postingId,
    );

    if (accepted === undefined) {
      throw new Error(`The fixture carries no readable posting ${postingId}.`);
    }

    return accepted.publishedAt;
  }

  it('resolves the framed relative statement against the Scrape_Run start time', () => {
    expect(publishedAt('a1b2c3d4e5f60001')).toEqual(at0930(10, 26)); // "Vor 3 Tagen geschaltet"
    expect(publishedAt('a1b2c3d4e5f60004')).toEqual(at0930(10, 28)); // "Gestern geschaltet"
  });

  it('reads the two wordings that state the moment of the Scrape_Run as that moment', () => {
    // "Gerade geschaltet" loses its frame word and joins the named days as 0 days, which is the same
    // statement "Heute" makes.
    expect(publishedAt('a1b2c3d4e5f60002')).toEqual(RUN_STARTED_AT);
    expect(publishedAt('a1b2c3d4e5f60003')).toEqual(RUN_STARTED_AT);
  });

  it('reads the bounded wording the same way however Indeed abbreviates it', () => {
    // "Vor mehr als 30 Tagen" and "Vor 30+ Tagen" are the same statement, so they must not resolve to
    // two different days; both take the most recent day the statement admits.
    expect(publishedAt('a1b2c3d4e5f60005')).toEqual(at0930(9, 29));
    expect(publishedAt('a1b2c3d4e5f60006')).toEqual(publishedAt('a1b2c3d4e5f60005'));
  });

  it('prefers the machine-readable date of a card that carries one', () => {
    expect(publishedAt('a1b2c3d4e5f60007')).toEqual(new Date(2026, 9, 22));
  });

  it('keeps a posting that states no date at all and marks the field empty (6.8)', () => {
    const outcome = normalizeFixture('relative-dates').at(-1);

    expect(outcome?.kind).toBe('ACCEPTED');

    if (outcome?.kind !== 'ACCEPTED') {
      return;
    }

    expect(outcome.posting.postingId).toBe('a1b2c3d4e5f60008');
    expect(outcome.posting.publishedAt).toBeNull();
    // An absent value is the empty field of 6.8, not the unparsable value of 6.9, so no note is
    // written for it.
    expect(outcome.notes).toEqual([]);
  });

  it('resolves all eight wordings, so no stored card takes the 6.9 path', () => {
    const resolved = acceptedPostings('relative-dates').filter(
      (posting) => posting.publishedAt !== null,
    );

    // Seven dates plus the one card that states none. Before `POSTING_FRAME_SUFFIX` every framed
    // wording was a non-match and six of these eight would have lost their date.
    expect(acceptedPostings('relative-dates')).toHaveLength(8);
    expect(resolved).toHaveLength(7);
  });

  it('never dates a posting after the Scrape_Run start', () => {
    for (const posting of acceptedPostings('relative-dates')) {
      const publishedAtValue = posting.publishedAt;

      expect(
        publishedAtValue === null || publishedAtValue.getTime() <= RUN_STARTED_AT.getTime(),
      ).toBe(true);
    }
  });
});

describe('a page that shows postings the parser cannot read (6.7)', () => {
  it('reports an unknown page layout rather than an empty result list', () => {
    const reading = readFixtureCase('layout-changed');

    // The document states a job count and renders three job cards in markup no candidate selector
    // matches. That is the 6.7 case: the page loaded, and no readable Job_Posting came out of it.
    expect(fixture('layout-changed').html).toContain('data-serp-card');
    expect(reading.outcome).toBe('LAYOUT_UNKNOWN');
    expect(reading.readablePostingCount).toBe(0);
  });

  it('tells it apart from a result list that legitimately matched nothing', () => {
    const empty = readFixtureCase('result-list-empty');

    expect(empty.outcome).toBe('EMPTY_RESULT_LIST');
    expect(empty.readablePostingCount).toBe(0);
    // Both pages yield no posting, so the Platform's own statement is the only thing that separates
    // them, and getting it wrong would either hide a layout change or report one that did not happen.
    expect(empty.outcome).not.toBe(readFixtureCase('layout-changed').outcome);
  });
});

describe('the blocking fixtures', () => {
  it('report a sign-in wall, a bot check and a reported rate limit rather than postings', () => {
    const readings: ReadonlyArray<[string, string]> = [
      ['sign-in-wall', 'SIGN_IN_REQUIRED'],
      ['captcha', 'BOT_CHECK'],
      ['rate-limited', 'RATE_LIMITED'],
      ['layout-changed', 'LAYOUT_UNKNOWN'],
      ['result-list-empty', 'EMPTY_RESULT_LIST'],
    ];

    for (const [fixtureCase, outcome] of readings) {
      const reading = readFixtureCase(fixtureCase);

      expect(reading.outcome).toBe(outcome);
      expect(reading.postings).toEqual<readonly RawJobPosting[]>([]);
    }
  });

  it('classifies the captured 403 from its body alone, whatever status carries it', () => {
    // The ordering `../parse-result-list.ts` depends on: Indeed serves its challenge with a `503` as
    // readily as with a `403`, and a `503` reported as `PLATFORM_UNREACHABLE` would tell the user to
    // retry later for a block that answers identically every time (7.6, 7.8).
    for (const status of [200, 503, null]) {
      expect(readFixtureCase('captcha', { status }).outcome).toBe('BOT_CHECK');
    }
  });

  it('names the security check in the captured document rather than inferring it', () => {
    const html = fixture('captcha').html;

    expect(html).toContain('Security Check');
    expect(html).toContain('Additional Verification Required');
    // Nothing in this adapter answers it: the reading reports the block and carries no challenge token
    // (7.5, 7.6).
    expect(readFixtureCase('captcha').hasNextPage).toBe(false);
  });
});
