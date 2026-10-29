/**
 * The Posting_Store states the E2E suite drives its flows against (task 21.1).
 *
 * One function per named scenario, each of them writing a complete and *fixed* Posting_Store from an
 * empty one. Fixed rather than generated, because an E2E assertion names what it expects — "the first
 * row is the newest Stepstone posting", "page 2 of 3" — and a generated data set would make a failure
 * unreadable. The arbitraries of the property tests are a different tool for a different question.
 *
 * ## What builds the rows
 *
 * `./posting-store.fixture.ts` and nothing else. Its `seedScrapeRun` and `seedJobPosting` already
 * define what a Scrape_Run and a Job_Posting look like, down to the content hash of the stored
 * relevance assessment, and the integration suite asserts against them. A second shape here would be
 * a second definition of a complete row, so the scenarios below pass overrides to those two builders
 * and add nothing of their own beyond the Platform result rows and the Log_Stream lines a run needs.
 *
 * ## Why the scenarios are what they are
 *
 * Each exists for acceptance criteria that cannot be reached any other way:
 *
 * - {@link seedEmptyStore} — 10.12 (no Job_Posting at all) and 11.6 (no completed Scrape_Run), which
 *   are states and not actions, so no flow can produce them.
 * - {@link seedCompletedRunWithoutPostings} — 2.8, a Scrape_Run that completed and found nothing. The
 *   fixture-mode retrieval always finds postings, so this one has to be seeded.
 * - {@link seedPostingOverview} — the data set of 10.1 to 10.13, 11.2 and 11.5: two completed runs so
 *   the "neu" marking of 11.2 has a reference run and a before, {@link OVERVIEW_POSTING_COUNT}
 *   postings so the pagination of 10.9 has more than one page, and at least two postings per filter
 *   value of 10.5 so every filter can be asserted to *remove* something.
 *
 * A spec that needs a further state adds a scenario here rather than writing rows of its own: the
 * seeding runs in a separate process (see `./e2e-seed.ts`), so a spec has no Prisma client to write
 * with, and that is deliberate — a flow test that reaches into the database mid-flow stops being a
 * test of the flow.
 *
 * Requirements: 2.8, 10.1 to 10.13, 11.2, 11.5, 11.6.
 */

import { computeContentHash } from '@job-scraper/domain';

import type { PrismaService } from '../prisma/prisma.service';
import type { Platform, Prisma, RelevanceVerdict } from '../prisma/prisma.types';
import { SEEDED_EFFECTIVE_PROFILE, seedJobPosting, seedScrapeRun } from './posting-store.fixture';

/** The identifier of the older of the two completed Scrape_Run of {@link seedPostingOverview}. */
export const PREVIOUS_RUN_ID = '33333333-3333-4333-8333-333333333333';

/** The identifier of the most recently completed Scrape_Run, which carries the "neu" marking (11.2). */
export const LATEST_RUN_ID = '44444444-4444-4444-8444-444444444444';

/** Start and end of the older run. */
export const PREVIOUS_RUN_STARTED_AT = new Date('2026-03-01T07:00:00.000Z');
export const PREVIOUS_RUN_FINISHED_AT = new Date('2026-03-01T07:09:00.000Z');

/** Start and end of the most recent run. */
export const LATEST_RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');
export const LATEST_RUN_FINISHED_AT = new Date('2026-03-02T08:12:00.000Z');

/**
 * How many Job_Posting {@link seedPostingOverview} writes.
 *
 * 44, and the number is derived rather than chosen. The pagination of 10.9 pages at 25, and the
 * *default view* is what a spec opening `/postings` sees — which hides every Job_Posting with the
 * Relevance_Verdict "nicht relevant" (10.6) and every one marked "nicht interessant" (10.11). The
 * pattern below hides roughly a third, so 28 postings would leave 18 visible and no second page at
 * all. 44 leaves {@link overviewDefaultViewCount} above 25, so the first page is full with the
 * default filters on and the page navigation of 10.9 is reachable without a filter being set first.
 */
export const OVERVIEW_POSTING_COUNT = 44;

/** How many of them were recorded for the first time in the most recent run, so they read "neu". */
export const OVERVIEW_NEW_POSTING_COUNT = 10;

/** The two Platform the overview data set spreads across; both have a Platform_Adapter (6.1). */
const OVERVIEW_PLATFORMS: readonly Platform[] = ['STEPSTONE', 'JOBVECTOR'];

/** The sort rank 10.7 orders the verdicts by: relevant < uncertain < not assessed < not relevant. */
const RELEVANCE_RANKS: Readonly<Record<RelevanceVerdict, number>> = {
  RELEVANT: 0,
  UNCERTAIN: 1,
  NOT_ASSESSED: 2,
  NOT_RELEVANT: 3,
};

/** Every scenario this module can seed, by name. The E2E CLI accepts exactly these. */
export const E2E_SCENARIOS = [
  'empty',
  'completed-run-without-postings',
  'posting-overview',
] as const;

/** One of {@link E2E_SCENARIOS}. */
export type E2eScenario = (typeof E2E_SCENARIOS)[number];

/** What a seeded scenario reports back, so the CLI can print something a spec can rely on. */
export interface SeededScenario {
  readonly scenario: E2eScenario;
  readonly runIds: readonly string[];
  /** How many Job_Posting were written, across every Posting_Status and marking. */
  readonly postingCount: number;
  /**
   * How many of them the posting overview shows with no filter set.
   *
   * Fewer than {@link postingCount}, because the default view hides the Relevance_Verdict "nicht
   * relevant" (10.6) and the marking "nicht interessant" (10.11). Reported rather than left to the
   * spec to work out: a spec that recomputed it would hold a second copy of the seeding rules and
   * would be wrong the moment the pattern changes.
   */
  readonly defaultViewCount: number;
}

/**
 * The empty Posting_Store: no Job_Posting, no Scrape_Run, nothing (10.12, 11.6).
 *
 * A function and not an absence, so every scenario is reached the same way and a spec never depends
 * on the harness having truncated beforehand.
 */
export const seedEmptyStore = async (_prisma: PrismaService): Promise<SeededScenario> => ({
  scenario: 'empty',
  runIds: [],
  postingCount: 0,
  defaultViewCount: 0,
});

/** A Scrape_Run that completed and stored nothing (2.8). */
export const seedCompletedRunWithoutPostings = async (
  prisma: PrismaService,
): Promise<SeededScenario> => {
  const run = await seedScrapeRun(prisma, {
    id: LATEST_RUN_ID,
    startedAt: LATEST_RUN_STARTED_AT,
    finishedAt: LATEST_RUN_FINISHED_AT,
  });

  await writePlatformResults(prisma, run.id, { newPostings: 0, updatedPostings: 0 });
  await writeRunLog(prisma, run.id, LATEST_RUN_STARTED_AT);

  return {
    scenario: 'completed-run-without-postings',
    runIds: [run.id],
    postingCount: 0,
    defaultViewCount: 0,
  };
};

/**
 * One Job_Posting of the overview data set, derived from its index.
 *
 * The derivation is the whole design of the data set, so it is written out rather than hidden in a
 * loop body: every filter value of 10.5 and every sort key of 10.7 is reachable, each filter value
 * occurs at least twice so that filtering it is observably different from not filtering, and the
 * recording times are strictly decreasing so the default sort of 10.7 has a total order with no ties
 * a test could trip over.
 */
const overviewPosting = (
  index: number,
): {
  readonly firstSeenRunId: string;
  readonly data: Partial<Prisma.JobPostingUncheckedCreateInput>;
} => {
  const isNew = index < OVERVIEW_NEW_POSTING_COUNT;
  const firstSeenRunId = isNew ? LATEST_RUN_ID : PREVIOUS_RUN_ID;
  const runStartedAt = isNew ? LATEST_RUN_STARTED_AT : PREVIOUS_RUN_STARTED_AT;
  const platform = OVERVIEW_PLATFORMS[index % OVERVIEW_PLATFORMS.length] ?? 'STEPSTONE';
  const title = overviewTitle(index);
  const description = overviewDescription(index);
  const contentHash = computeContentHash(title, description ?? '');

  // Recording times one minute apart, descending with the index, so "sorted by recording time
  // descending" is the index order and a failure names the row it means.
  const firstSeenAt = new Date(runStartedAt.getTime() - index * 60_000);

  const verdict = overviewVerdict(index);
  const assessed = verdict !== 'NOT_ASSESSED';
  // Every fourth assessed posting carries the user's own verdict, so the "manuell gesetzt" marking of
  // 10.3 and 15.15 is present and the "durch KI bewertet" one is the majority.
  const setManually = assessed && index % 4 === 3;
  const commute = overviewCommute(index);

  return {
    firstSeenRunId,
    data: {
      id: overviewPostingId(index),
      platform,
      postingId: `${platform.toLowerCase()}-${String(1000 + index)}`,
      title,
      employer: `Beispiel ${String(index + 1)} GmbH`,
      workLocation: overviewWorkLocation(index),
      // Every third posting has no publication date, which is the "unknown" end of the sort of 10.7
      // and a field 6.8 permits to be absent.
      publishedAt:
        index % 3 === 2 ? null : new Date(firstSeenAt.getTime() - (index + 1) * 86_400_000),
      sourceUrl: `https://www.${platform.toLowerCase()}.de/stellenangebote--${String(1000 + index)}`,
      descriptionText: description,

      firstSeenAt,
      lastSeenAt: runStartedAt,
      // Every fifth posting is no longer listed, so the Posting_Status filter of 10.5 and the
      // independence of the marking filter from it both have rows on each side.
      postingStatus: index % 5 === 4 ? 'NO_LONGER_LISTED' : 'LISTED',
      // Every seventh posting is marked, so the default view of 10.11 hides something and the
      // marking filter brings it back.
      interestFlag: index % 7 === 6 ? 'NOT_INTERESTING' : 'UNMARKED',

      relevanceVerdict: verdict,
      relevanceReason: assessed ? overviewRelevanceReasonDe(verdict, index) : null,
      relevanceModel: assessed && !setManually ? 'claude-sonnet-4-5' : null,
      relevanceAssessedAt: assessed ? runStartedAt : null,
      relevanceSetManually: setManually,
      relevanceRank: RELEVANCE_RANKS[verdict],
      contentHash,
      relevanceContentHash: assessed ? contentHash : null,

      ...commute,
      commuteCheckedAt: commute.bestCommuteMinutes === null ? null : runStartedAt,
    },
  };
};

/** The identifier of the overview posting at `index`; stable, so a spec can deep-link to it. */
export const overviewPostingId = (index: number): string =>
  `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`;

/**
 * The title of the overview posting at `index`.
 *
 * Every fourth one is a Werkstudent position, which is what the fixture AI_Provider assesses as
 * `NOT_RELEVANT` — so a spec that re-assesses a seeded posting sees the same verdict the seed holds.
 */
const overviewTitle = (index: number): string =>
  index % 4 === 1
    ? `Werkstudent Softwareentwicklung ${String(index + 1)}`
    : `Senior Softwareentwickler ${String(index + 1)}`;

/**
 * The description of the overview posting at `index`, or `null` for exactly one of them.
 *
 * The one without a description is 10.15: the detail view has to show a German hint in its place and
 * keep the link to the source URL. One rather than several, because the criterion is about a state
 * and a spec needs one row it can name.
 */
const overviewDescription = (index: number): string | null =>
  index === 2
    ? null
    : `Entwicklung von Services in TypeScript und PostgreSQL. Stelle ${String(index + 1)} von ${String(OVERVIEW_POSTING_COUNT)}.`;

/**
 * The work location of the overview posting at `index`.
 *
 * Three shapes, because the commute determination treats them differently: a plain municipality
 * resolves exactly, "und Umgebung" resolves to a centroid (8.12), and "Remote" resolves to nothing,
 * which is the Best_Commute_Time "unknown" of 8.5 and the "unbekannt" text of 10.1.
 */
const overviewWorkLocation = (index: number): string => {
  if (index % 6 === 5) {
    return 'Remote';
  }

  return index % 6 === 4 ? 'München und Umgebung' : 'München';
};

/** The Relevance_Verdict of the overview posting at `index`; every value occurs at least twice. */
const overviewVerdict = (index: number): RelevanceVerdict => {
  switch (index % 4) {
    case 0:
      return 'RELEVANT';
    case 1:
      return 'NOT_RELEVANT';
    case 2:
      return 'UNCERTAIN';
    default:
      return 'NOT_ASSESSED';
  }
};

/**
 * The German Relevance_Reason of a stored assessment.
 *
 * German and API_Service-owned, like every stored value: a Relevance_Reason is written by the
 * AI_Provider and displayed unchanged (10.2), so the Web_App holds no wording for it and a seeded one
 * has to read like one that was answered.
 */
const overviewRelevanceReasonDe = (verdict: RelevanceVerdict, index: number): string => {
  switch (verdict) {
    case 'RELEVANT':
      return `Passt zum Suchprofil: Backend-Entwicklung mit TypeScript, Stelle ${String(index + 1)}.`;
    case 'NOT_RELEVANT':
      return `Werkstudentenstelle statt Festanstellung, Stelle ${String(index + 1)}.`;
    default:
      return `Aus der Beschreibung lässt sich die Seniorität nicht ableiten, Stelle ${String(index + 1)}.`;
  }
};

/** The commute columns of the overview posting at `index`. */
const overviewCommute = (
  index: number,
): Pick<
  Prisma.JobPostingUncheckedCreateInput,
  | 'bicycleMinutes'
  | 'transitMinutes'
  | 'bestCommuteMinutes'
  | 'bestCommuteMode'
  | 'commutePrecision'
  | 'commuteLocationInput'
> => {
  const location = overviewWorkLocation(index);

  if (location === 'Remote') {
    // 8.5: no place reference, so nothing was determined. The overview shows "unbekannt" (10.1) and
    // the reachability filter counts it as "unbekannt" (10.5).
    return {
      bicycleMinutes: null,
      transitMinutes: null,
      bestCommuteMinutes: null,
      bestCommuteMode: null,
      commutePrecision: 'UNKNOWN',
      commuteLocationInput: location,
    };
  }

  // Alternating around the default Commute_Threshold of 60 minutes, so "gut erreichbar" and "nicht
  // gut erreichbar" each hold several rows (8.3, 10.5).
  const transitMinutes = index % 2 === 0 ? 22 + index : 95 + index;

  return {
    bicycleMinutes: transitMinutes + 15,
    transitMinutes,
    bestCommuteMinutes: transitMinutes,
    bestCommuteMode: 'TRANSIT',
    commutePrecision: location === 'München' ? 'EXACT' : 'IMPRECISE',
    commuteLocationInput: location,
  };
};

/**
 * The posting overview data set: two completed Scrape_Run and {@link OVERVIEW_POSTING_COUNT}
 * Job_Posting (10.1 to 10.13, 11.2, 11.5).
 */
export const seedPostingOverview = async (prisma: PrismaService): Promise<SeededScenario> => {
  const previous = await seedScrapeRun(prisma, {
    id: PREVIOUS_RUN_ID,
    startedAt: PREVIOUS_RUN_STARTED_AT,
    finishedAt: PREVIOUS_RUN_FINISHED_AT,
  });
  const latest = await seedScrapeRun(prisma, {
    id: LATEST_RUN_ID,
    startedAt: LATEST_RUN_STARTED_AT,
    finishedAt: LATEST_RUN_FINISHED_AT,
  });

  await writePlatformResults(prisma, previous.id, {
    newPostings: OVERVIEW_POSTING_COUNT - OVERVIEW_NEW_POSTING_COUNT,
    updatedPostings: 0,
  });
  await writePlatformResults(prisma, latest.id, {
    newPostings: OVERVIEW_NEW_POSTING_COUNT,
    updatedPostings: OVERVIEW_POSTING_COUNT - OVERVIEW_NEW_POSTING_COUNT,
  });

  await writeRunLog(prisma, previous.id, PREVIOUS_RUN_STARTED_AT);
  await writeRunLog(prisma, latest.id, LATEST_RUN_STARTED_AT);

  for (let index = 0; index < OVERVIEW_POSTING_COUNT; index += 1) {
    const { firstSeenRunId, data } = overviewPosting(index);

    await seedJobPosting(prisma, firstSeenRunId, data);
  }

  return {
    scenario: 'posting-overview',
    runIds: [previous.id, latest.id],
    postingCount: OVERVIEW_POSTING_COUNT,
    defaultViewCount: overviewDefaultViewCount(),
  };
};

/**
 * How many of the overview postings the default view shows (10.6, 10.11).
 *
 * Counted from the same derivation that writes the rows rather than stated as a number, so the two
 * cannot disagree: a change to the verdict or marking pattern changes this count with it.
 */
export const overviewDefaultViewCount = (): number => {
  let visible = 0;

  for (let index = 0; index < OVERVIEW_POSTING_COUNT; index += 1) {
    const { data } = overviewPosting(index);

    if (data.relevanceVerdict !== 'NOT_RELEVANT' && data.interestFlag !== 'NOT_INTERESTING') {
      visible += 1;
    }
  }

  return visible;
};

/** Every scenario, by name, so the CLI needs no switch of its own. */
export const E2E_SCENARIO_SEEDERS: Readonly<
  Record<E2eScenario, (prisma: PrismaService) => Promise<SeededScenario>>
> = {
  empty: seedEmptyStore,
  'completed-run-without-postings': seedCompletedRunWithoutPostings,
  'posting-overview': seedPostingOverview,
};

/** The per-Platform result rows of one Scrape_Run, one per Platform with an adapter (7.4). */
const writePlatformResults = async (
  prisma: PrismaService,
  runId: string,
  counts: { readonly newPostings: number; readonly updatedPostings: number },
): Promise<void> => {
  // Split evenly over the Platform, so the per-Platform block of the summary (12.10) has two rows
  // whose numbers add up to the run totals of 11.5.
  const perPlatform = Math.floor(counts.newPostings / OVERVIEW_PLATFORMS.length);

  for (const [index, platform] of OVERVIEW_PLATFORMS.entries()) {
    await prisma.scrapeRunPlatformResult.create({
      data: {
        runId,
        platform,
        platformStatus: 'COMPLETED',
        pagesFetched: 2,
        newPostings: index === 0 ? counts.newPostings - perPlatform : perPlatform,
        updatedPostings: index === 0 ? counts.updatedPostings : 0,
        partialResult: false,
        missingMandatoryFields: [],
        effectiveProfile: SEEDED_EFFECTIVE_PROFILE,
      },
    });
  }
};

/**
 * A short Log_Stream for one Scrape_Run, so the Log_View of a seeded run has something to show.
 *
 * Three lines per Platform plus the run's own start and end, with `sequence` strictly increasing from
 * 1 as 12.2 and 12.4 require, and German message texts because the Log_Stream text is the
 * API_Service's to own.
 */
const writeRunLog = async (
  prisma: PrismaService,
  runId: string,
  startedAt: Date,
): Promise<void> => {
  const lines: readonly {
    readonly platform: Platform | null;
    readonly code: string;
    readonly messageDe: string;
  }[] = [
    { platform: null, code: 'run.started', messageDe: 'Suchlauf gestartet.' },
    ...OVERVIEW_PLATFORMS.flatMap((platform) => [
      {
        platform,
        code: 'platform.retrievalStarted',
        messageDe: `${platform}: Abruf gestartet.`,
      },
      {
        platform,
        code: 'platform.pageFetched',
        messageDe: `${platform}: Ergebnisseite 1 gelesen.`,
      },
      {
        platform,
        code: 'platform.counters',
        messageDe: `${platform}: Abruf abgeschlossen.`,
      },
    ]),
    { platform: null, code: 'run.finished', messageDe: 'Suchlauf abgeschlossen.' },
  ];

  for (const [index, line] of lines.entries()) {
    await prisma.logMessage.create({
      data: {
        runId,
        sequence: index + 1,
        createdAt: new Date(startedAt.getTime() + index * 1_000),
        platform: line.platform,
        level: 'INFO',
        code: line.code,
        messageDe: line.messageDe,
        detail: line.platform === null ? undefined : { platform: line.platform },
      },
    });
  }
};
