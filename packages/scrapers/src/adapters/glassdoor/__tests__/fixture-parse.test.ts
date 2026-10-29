/**
 * The Glassdoor parser against the frozen fixtures (6.3, 6.4, 6.5, 6.7, 6.8, 7.2, 7.6, 13.3, 13.5).
 *
 * The companion of `./parse-result-list.test.ts`: that file pins the *rules* of the reader with
 * hand-written snippets, this one reads the eight stored Result_Page of `../__fixtures__/` and compares
 * the whole reading against the expectation stored next to each document. Nothing here builds markup,
 * which is the point — when Glassdoor changes its page, the fixture and its `.expected.json` are
 * replaced together and this suite reports exactly what the parser now reads differently.
 *
 * ## One captured document and seven hand-authored ones
 *
 * Unlike the Stepstone and Jobvector folders, this one is not uniformly hand-authored:
 * `result-list-page-1` is the response glassdoor.de served on 2026-10-29 with HTTP 200 and 30 readable
 * Job_Posting, and it is the only document in the repository that proves anything about a Platform's
 * real markup. Its seven siblings pin *parser behaviour* instead, for the situations no Platform serves
 * on demand. `../__fixtures__/README.md` records which is which and why, and the provenance test below
 * asserts that record rather than trusting it, so a hand-authored document can never quietly claim to
 * be a capture.
 *
 * ## Where each requirement is observable
 *
 * The stages after the reader are exercised on the fixtures as well, because the requirements they
 * implement are only observable on a whole page — but not all of them on the *same* page, and this is
 * stated plainly rather than smoothed over:
 *
 * - **6.3 and 6.4 on the captured page.** All 30 cards carry every optional field, and every one of
 *   them states its publication date as the compact day count Glassdoor uses, including the 14 reading
 *   "30T+".
 * - **6.5 and 6.8 on `result-list-page-2`.** The captured page contains no incomplete card and no empty
 *   optional field, so neither the discard rule nor the "mark as empty" rule is observable on it. The
 *   hand-authored page 2 exists for exactly that and says so in its own `description`.
 * - **6.9 on neither.** Since the shared normalization layer learned the compact day count, every date
 *   wording that occurs on these fixtures resolves, so no stored Glassdoor card takes the
 *   unparsable-date path any more. A card that states *no* date at all is the 6.8 case and is asserted
 *   below; the 6.9 path itself is pinned where it belongs, in
 *   `../../../normalize/__tests__/parse-publication-date.test.ts`.
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
import { readGlassdoorResultPage } from '../parse-result-list.js';
import { glassdoorResultListUrl } from '../result-list-url.js';

/** The effective Search_Profile of Glassdoor as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('GLASSDOOR', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Glassdoor profile does not resolve.');
  }

  return resolution.profile;
})();

/** The cases that came from a real retrieval. Everything else is hand-authored (see the header). */
const CAPTURED_CASES: readonly string[] = ['result-list-page-1'];

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
function readFixtureCase(fixtureCase: string, pageUrl?: string) {
  const { html, expectation } = fixture(fixtureCase);

  return readGlassdoorResultPage({
    html,
    // The URL the adapter would have asked for, so the source URLs resolve against the Platform
    // origin rather than against the fixture server of the adapter tests.
    response: {
      url: pageUrl ?? glassdoorResultListUrl(PROFILE, expectation.pageNumber),
      status: expectation.response.status,
      headers: expectation.response.headers,
    },
  });
}

/** The normalized postings of a fixture, for the stages after the reader. */
function normalizeFixture(fixtureCase: string): readonly NormalizationOutcome[] {
  return readFixtureCase(fixtureCase).postings.map((posting) =>
    normalizePosting('GLASSDOOR', posting, RUN_STARTED_AT, parsePublicationDate),
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
 * The capture day of the stored page on purpose, so the compact day counts of its 30 cards resolve to
 * the days a reader of that page on that day would have arrived at.
 */
const RUN_STARTED_AT = new Date(2026, 9, 29, 9, 30);

/** Local time of one day at 09:30, which is the time of day a relative date keeps. */
function at0930(month: number, day: number): Date {
  return new Date(2026, month - 1, day, 9, 30);
}

beforeAll(async () => {
  for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
    const { html, metadata } = await readFixture({ platform: 'GLASSDOOR', fixtureCase });

    loaded.set(fixtureCase, {
      fixtureCase,
      html,
      metadata,
      expectation: await readFixtureExpectation({ platform: 'GLASSDOOR', fixtureCase }),
    });
  }
});

describe('the stored fixtures', () => {
  it('cover every case the design requires', async () => {
    const present = await listFixtureCases(platformFixtureDir('GLASSDOOR'));

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

  it('record the one real retrieval with its day, its status and the Job_Tool user agent (14.5)', () => {
    const { metadata } = fixture('result-list-page-1');

    expect(metadata?.platform).toBe('GLASSDOOR');
    expect(metadata?.capturedAt.slice(0, 10)).toBe(CAPTURE_DAY);
    expect(metadata?.httpStatus).toBe(200);
    expect(metadata?.userAgent).toMatch(/^JobTool\//);
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

describe('the captured Result_Page of 2026-10-29 (6.2, 6.3)', () => {
  it('yields 30 readable Job_Posting, every one of them with a Posting_Id of its own', () => {
    const reading = readFixtureCase('result-list-page-1');
    const ids = reading.postings.map((posting) => posting.postingId);

    expect(reading.outcome).toBe('POSTINGS');
    expect(reading.readablePostingCount).toBe(30);
    expect(reading.postings).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it('reads the Posting_Id from the card rather than out of the source URL', () => {
    // `data-jobid` on every card is what the capture established, and it is what keeps the upsert of
    // 9.4 stable across Scrape_Run even though the link carries per-impression parameters.
    for (const posting of readFixtureCase('result-list-page-1').postings) {
      expect(posting.postingId).toMatch(/^\d+$/);
    }
  });

  it('gives every posting an openable advertisement URL, not the click overlay', () => {
    // The capture corrected the candidate order here: the overlay anchor `[data-test="job-link"]`
    // points at /partner/jobListing.htm and resolved to the same unopenable URL for all 30 cards.
    for (const posting of readFixtureCase('result-list-page-1').postings) {
      expect(posting.sourceUrl).toMatch(
        /^https:\/\/www\.glassdoor\.de\/job-listing\/[^?]+\.htm\?jl=\d+$/,
      );
    }
  });

  it('accepts all 30 postings, with the eight fields of 6.3', () => {
    const outcomes = normalizeFixture('result-list-page-1');
    const accepted = outcomes.filter(isAccepted);

    expect(outcomes).toHaveLength(30);
    expect(accepted).toHaveLength(30);
    expect(accepted[0]?.posting).toEqual<NormalizedJobPosting>({
      platform: 'GLASSDOOR',
      postingId: '1010299809793',
      title: 'Projektleiter (m/w/d) im Bereich Service',
      employer: 'WISAG',
      workLocation: 'Dresden',
      publishedAt: at0930(10, 19),
      sourceUrl:
        'https://www.glassdoor.de/job-listing/projektleiter-mwd-im-bereich-service-wisag-JV_IC2610266_KO0,36_KE37,42.htm?jl=1010299809793',
      descriptionText:
        'Sicherer Umgang mit Excel, idealerweise Kenntnisse in Pro-Bau/S und SAP. Urlaubs- und Weihnachtsgeld, zusätzlich eine Leistungszulage ab dem 7.&hellip; Kenntnisse und Fähigkeiten: Kostenmanagement, SAP, Projektkoordination, Elektrotechnik, Bauleitung',
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

  it('discards no posting of the captured page (6.5)', () => {
    expect(normalizeFixture('result-list-page-1').filter(isDiscarded)).toEqual([]);
  });

  it('reads the same way when it is served from the canonical URL the Platform rewrote to', () => {
    // Glassdoor answered the request from /Job/…-jobs-SRCH_KO0,142.htm rather than from the URL the
    // adapter asked for, so the reading must not depend on which of the two it is handed.
    const canonical = fixture('result-list-page-1').metadata?.finalUrl;

    expect(canonical).toMatch(/^https:\/\/www\.glassdoor\.de\/Job\//);
    expect(readFixtureCase('result-list-page-1', canonical)).toEqual(
      readFixtureCase('result-list-page-1'),
    );
  });
});

describe('the publication dates of the captured page (6.4)', () => {
  it('resolves the compact day count of every one of the 30 cards', () => {
    const dates = acceptedPostings('result-list-page-1').map((posting) => posting.publishedAt);

    // The wording the capture found, and the only one Glassdoor states: "2T", "10T", "30T+". None of
    // the 30 cards may fall back to the empty publication date of 6.9 any more.
    expect(dates.filter((date) => date === null)).toEqual([]);
  });

  it('dates no posting after the start of the Scrape_Run', () => {
    for (const posting of acceptedPostings('result-list-page-1')) {
      expect(posting.publishedAt?.getTime()).toBeLessThanOrEqual(RUN_STARTED_AT.getTime());
    }
  });

  it('reads "30T+" as the 30 days it states, for all 14 cards that carry it', () => {
    const reading = readFixtureCase('result-list-page-1');
    const bounded = reading.postings
      .map((posting, index) => ({ posting, index }))
      .filter(({ posting }) => posting.publishedAtText === '30T+');
    const accepted = acceptedPostings('result-list-page-1');

    expect(bounded).toHaveLength(14);

    for (const { index } of bounded) {
      // A lower bound on the age resolves to the bound itself: the most recent day the statement
      // admits and the only number the page states. See ../../../normalize/parse-publication-date.ts.
      expect(accepted[index]?.publishedAt).toEqual(at0930(9, 29));
    }
  });

  it('reads a plain day count as that many calendar days before the Scrape_Run start', () => {
    const reading = readFixtureCase('result-list-page-1');
    const accepted = acceptedPostings('result-list-page-1');
    const youngest = reading.postings.findIndex((posting) => posting.publishedAtText === '2T');

    expect(youngest).toBeGreaterThanOrEqual(0);
    expect(accepted[youngest]?.publishedAt).toEqual(at0930(10, 27));
  });
});

describe('pagination across the two stored result list pages (6.3, 13.3)', () => {
  it('offers a further page on the captured page and none on page 2', () => {
    // The captured page ends in a `data-test="load-more"` button, which is Glassdoor's whole
    // pagination; page 2 is hand-authored as a last page and therefore offers none.
    expect(readFixtureCase('result-list-page-1').hasNextPage).toBe(true);
    expect(readFixtureCase('result-list-page-2').hasNextPage).toBe(false);
  });

  it('yields disjoint Posting_Id, so the pages are two pages and not the same one twice', () => {
    const first = readFixtureCase('result-list-page-1').postings.map((p) => p.postingId);
    const second = readFixtureCase('result-list-page-2').postings.map((p) => p.postingId);
    const shared = first.filter((id) => id !== null && second.includes(id));

    expect(first).toHaveLength(30);
    expect(shared).toEqual([]);
  });
});

describe('discarding incomplete postings of a stored page (6.5)', () => {
  it('discards exactly the cards missing title, source URL or Posting_Id, naming the field', () => {
    const outcomes = normalizeFixture('result-list-page-2');
    const discarded = outcomes.filter(isDiscarded);

    expect(outcomes).toHaveLength(5);
    expect(discarded.map((outcome) => outcome.field)).toEqual(['sourceUrl', 'title']);

    for (const outcome of discarded) {
      expect(outcome.code).toBe('posting.discardedMissingField');
      expect(outcome.platform).toBe('GLASSDOOR');
      // 6.5 asks for the platform name and the source URL in the Log_Stream, so a discard that names
      // neither would be unreportable.
      expect(outcome.sourceUrl === null || outcome.sourceUrl.length > 0).toBe(true);
    }
  });

  it('keeps every readable posting of that page, with the fields of 6.3', () => {
    const accepted = acceptedPostings('result-list-page-2');

    expect(accepted).toHaveLength(fixture('result-list-page-2').expectation.readablePostingCount);
    expect(accepted[0]).toEqual<NormalizedJobPosting>({
      platform: 'GLASSDOOR',
      postingId: '1010301000001',
      title: 'Projektmanagerin Pharma (m/w/d)',
      employer: 'Epsilon Pharma GmbH',
      workLocation: 'München',
      publishedAt: at0930(10, 26),
      sourceUrl:
        'https://www.glassdoor.de/job-listing/projektmanagerin-pharma-mwd-epsilon-pharma-gmbh-JV_IC2622109_KO0,27_KE28,47.htm?jl=1010301000001',
      descriptionText:
        'Sie steuern klinische Entwicklungsprojekte von der Planung bis zur Zulassung.',
    });
  });

  it('marks an absent optional field as empty and passes the posting on (6.8)', () => {
    const accepted = acceptedPostings('result-list-page-2');
    const withoutEmployer = accepted.find((posting) => posting.employer === null);
    const withoutDescription = accepted.find((posting) => posting.descriptionText === null);

    expect(withoutEmployer?.postingId).toBe('1010301000002');
    expect(withoutEmployer?.title).toBe('Teilprojektleiterin Qualitätssicherung (m/w/d)');
    expect(withoutEmployer?.workLocation).toBe('Garching bei München');
    expect(withoutDescription?.postingId).toBe('1010301000005');
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

  it('resolves the compact Glassdoor day count and its bounded form', () => {
    expect(publishedAt('1010304000001')).toEqual(at0930(10, 23));
    expect(publishedAt('1010304000002')).toEqual(at0930(9, 29));
  });

  it('resolves every spelled-out wording against the Scrape_Run start time', () => {
    expect(publishedAt('1010304000004')).toEqual(at0930(10, 26));
    expect(publishedAt('1010304000005')).toEqual(RUN_STARTED_AT);
    expect(publishedAt('1010304000006')).toEqual(at0930(10, 28));
  });

  it('reads the bounded wording the same way however the Platform abbreviates it', () => {
    // "30T+" and "vor mehr als 30 Tagen" are the same statement, so they must not resolve to two
    // different days.
    expect(publishedAt('1010304000007')).toEqual(publishedAt('1010304000002'));
  });

  it('prefers the machine-readable date of a card that carries one', () => {
    expect(publishedAt('1010304000003')).toEqual(new Date(2026, 9, 22));
  });

  it('keeps a posting that states no date at all and marks the field empty (6.8)', () => {
    const outcome = normalizeFixture('relative-dates').at(-1);

    expect(outcome?.kind).toBe('ACCEPTED');

    if (outcome?.kind !== 'ACCEPTED') {
      return;
    }

    expect(outcome.posting.postingId).toBe('1010304000008');
    expect(outcome.posting.publishedAt).toBeNull();
    // An absent value is the empty field of 6.8, not the unparsable value of 6.9, so no note is
    // written for it.
    expect(outcome.notes).toEqual([]);
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

    // The document states "142 Jobs" and renders three job cards in markup no candidate selector
    // matches. That is the 6.7 case: the page loaded, and no readable Job_Posting came out of it.
    expect(fixture('layout-changed').html).toContain('142 Jobs');
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
});
