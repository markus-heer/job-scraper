/**
 * The Stepstone parser against the frozen fixtures (6.3, 6.5, 6.7, 6.10, 7.2, 7.6, 13.5).
 *
 * The companion of `./parse-result-list.test.ts`: that file pins the *rules* of the reader with
 * hand-written snippets, this one reads the eight stored Result_Page of
 * `../__fixtures__/` and compares the whole reading against the expectation stored next to each
 * document. Nothing here builds markup, which is the point — when Stepstone changes its page, the
 * fixture and its `.expected.json` are replaced together and this suite reports exactly what the
 * parser now reads differently.
 *
 * Every fixture is currently hand-authored; `../__fixtures__/README.md` states what that does and does
 * not establish.
 *
 * The two stages after the reader are exercised on the fixtures as well, because the requirements they
 * implement are only observable on a whole page: the discard rule of 6.5 needs a page that contains
 * incomplete cards (`result-list-page-2`), and the relative dates of 6.4 need a page that states them
 * in every wording the Platform uses (`relative-dates`).
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
import { listFixtureCases, readFixtureHtml } from '../../../fixtures/fixture-files.js';
import {
  missingFixtureCases,
  platformFixtureDir,
  REQUIRED_FIXTURE_CASES,
} from '../../../fixtures/fixture-paths.js';
import {
  type NormalizationOutcome,
  type NormalizedJobPosting,
  normalizePosting,
} from '../../../normalize/normalize-posting.js';
import { parsePublicationDate } from '../../../normalize/parse-publication-date.js';
import { readStepstoneResultPage } from '../parse-result-list.js';
import { stepstoneResultListUrl } from '../result-list-url.js';

/** The effective Search_Profile of Stepstone as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('STEPSTONE', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Stepstone profile does not resolve.');
  }

  return resolution.profile;
})();

/** A fixture with its expectation, as the table-driven cases below read them. */
interface LoadedCase {
  readonly fixtureCase: string;
  readonly html: string;
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
function readFixtureCase(fixtureCase: string) {
  const { html, expectation } = fixture(fixtureCase);

  return readStepstoneResultPage({
    html,
    // The URL the adapter would have asked for, so the source URLs resolve against the Platform
    // origin rather than against the fixture server of the adapter tests.
    response: {
      url: stepstoneResultListUrl(PROFILE, expectation.pageNumber),
      status: expectation.response.status,
      headers: expectation.response.headers,
    },
  });
}

/** The normalized postings of a fixture, for the stages after the reader. */
function normalizeFixture(fixtureCase: string): readonly NormalizationOutcome[] {
  return readFixtureCase(fixtureCase).postings.map((posting) =>
    normalizePosting('STEPSTONE', posting, RUN_STARTED_AT, parsePublicationDate),
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

/** The Scrape_Run start time the relative dates of 6.4 are resolved against: 27.10.2026, 09:30. */
const RUN_STARTED_AT = new Date(2026, 9, 27, 9, 30);

/** Local time of one day at 09:30, which is the time of day a relative date keeps. */
function at0930(month: number, day: number): Date {
  return new Date(2026, month - 1, day, 9, 30);
}

beforeAll(async () => {
  for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
    loaded.set(fixtureCase, {
      fixtureCase,
      html: await readFixtureHtml({ platform: 'STEPSTONE', fixtureCase }),
      expectation: await readFixtureExpectation({ platform: 'STEPSTONE', fixtureCase }),
    });
  }
});

describe('the stored fixtures', () => {
  it('cover every case the design requires', async () => {
    const present = await listFixtureCases(platformFixtureDir('STEPSTONE'));

    expect(missingFixtureCases(present)).toEqual([]);
  });

  it('each state which case they belong to and where they came from', () => {
    for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
      const { expectation } = fixture(fixtureCase);

      expect(expectation.case).toBe(fixtureCase);
      expect(expectation.provenance).toBe('HAND_AUTHORED');
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

describe('pagination across the two stored result list pages (6.10, 13.3)', () => {
  it('offers a further page on page 1 and none on page 2', () => {
    expect(readFixtureCase('result-list-page-1').hasNextPage).toBe(true);
    expect(readFixtureCase('result-list-page-2').hasNextPage).toBe(false);
  });

  it('yields disjoint Posting_Id, so the pages are two pages and not the same one twice', () => {
    const first = readFixtureCase('result-list-page-1').postings.map((p) => p.postingId);
    const second = readFixtureCase('result-list-page-2').postings.map((p) => p.postingId);
    const shared = first.filter((id) => id !== null && second.includes(id));

    expect(first).toHaveLength(4);
    expect(shared).toEqual([]);
  });
});

describe('discarding incomplete postings of a stored page (6.5)', () => {
  it('discards exactly the cards missing title, source URL or Posting_Id, naming the field', () => {
    const outcomes = normalizeFixture('result-list-page-2');
    const discarded = outcomes.filter(isDiscarded);

    expect(outcomes).toHaveLength(5);
    expect(discarded.map((outcome) => outcome.field)).toEqual(['title', 'sourceUrl', 'postingId']);

    for (const outcome of discarded) {
      expect(outcome.code).toBe('posting.discardedMissingField');
      expect(outcome.platform).toBe('STEPSTONE');
    }
  });

  it('keeps every readable posting of that page, with the fields of 6.3', () => {
    const accepted = normalizeFixture('result-list-page-2')
      .filter(isAccepted)
      .map((outcome) => outcome.posting);

    expect(accepted).toHaveLength(fixture('result-list-page-2').expectation.readablePostingCount);
    expect(accepted[0]).toEqual<NormalizedJobPosting>({
      platform: 'STEPSTONE',
      postingId: '9865500',
      title: 'Teilprojektleiterin Qualitätssicherung (m/w/d)',
      employer: 'Delta Pharm GmbH',
      workLocation: 'München',
      publishedAt: at0930(10, 15),
      sourceUrl:
        'https://www.stepstone.de/stellenangebote--Teilprojektleiterin-Qualitaetssicherung-Muenchen-Delta-Pharm-GmbH--9865500-inline.html',
      descriptionText:
        'Sie begleiten Qualifizierungsprojekte in der Sterilherstellung und stimmen sich mit den Behörden ab.',
    });
  });

  it('reports no posting of the readable page as discarded', () => {
    const outcomes = normalizeFixture('result-list-page-1');

    expect(outcomes.every((outcome) => outcome.kind === 'ACCEPTED')).toBe(true);
  });
});

describe('the relative publication dates of a stored page (6.4, 6.9)', () => {
  /** The absolute publication date of one posting of the `relative-dates` fixture. */
  function publishedAt(postingId: string): Date | null {
    const accepted = normalizeFixture('relative-dates')
      .filter(isAccepted)
      .map((outcome) => outcome.posting)
      .find((posting) => posting.postingId === postingId);

    if (accepted === undefined) {
      throw new Error(`The fixture carries no readable posting ${postingId}.`);
    }

    return accepted.publishedAt;
  }

  it('resolves every wording of the page against the Scrape_Run start time', () => {
    expect(publishedAt('9850001')).toEqual(RUN_STARTED_AT);
    expect(publishedAt('9850002')).toEqual(at0930(10, 26));
    expect(publishedAt('9850003')).toEqual(new Date(2026, 9, 27, 4, 30));
    expect(publishedAt('9850004')).toEqual(at0930(10, 24));
    expect(publishedAt('9850005')).toEqual(at0930(10, 20));
    expect(publishedAt('9850006')).toEqual(at0930(9, 27));
  });

  it('prefers the machine-readable date of a card that carries one', () => {
    expect(publishedAt('9850007')).toEqual(new Date(2026, 9, 15));
  });

  it('keeps a posting whose date wording is unparsable and marks the field empty (6.9)', () => {
    const outcome = normalizeFixture('relative-dates').at(-1);

    expect(outcome?.kind).toBe('ACCEPTED');

    if (outcome?.kind !== 'ACCEPTED') {
      return;
    }

    expect(outcome.posting.postingId).toBe('9850008');
    expect(outcome.posting.publishedAt).toBeNull();
    expect(outcome.notes).toEqual(['posting.publicationDateUnparsable']);
  });

  it('never dates a posting after the Scrape_Run start', () => {
    const dates = normalizeFixture('relative-dates')
      .filter(isAccepted)
      .map((outcome) => outcome.posting.publishedAt);

    for (const date of dates) {
      expect(date === null || date.getTime() <= RUN_STARTED_AT.getTime()).toBe(true);
    }
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
