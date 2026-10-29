/**
 * The read layer of the Web_App, executed through the booted schema (10.1 to 10.9, 11.2, 11.3,
 * 11.5, 11.6, 12.5, 12.9, 14.8, 4.11).
 *
 * The schema is not built by hand here: a Nest application with the real `GraphQLModule`
 * configuration boots over the real resolvers, services and repository, with the Posting_Store
 * replaced by the in-memory delegates below. That is what makes the questions of this suite
 * answerable at all — each resolver's own test sees its service without the schema in front of it,
 * and a schema plus a service that are each correct can still be connected wrongly.
 *
 * The three questions that need the whole wiring:
 *
 * - **Does a page's grouping agree with its rows' marking (11.2, 11.3)?** Both are derived from the
 *   identifier of the most recently completed Scrape_Run, and the request resolves it *once*. The
 *   count of selections below is the assertion: one per request, not one per row.
 * - **Is the `firstSeenRun` edge batched (design: DataLoader)?** A page of several postings must
 *   cost one Scrape_Run query for the edge, whatever the number of rows.
 * - **Do the remaining read queries answer at all?** `jobPosting`, `latestScrapeRun` with its 11.6
 *   null, `activeScrapeRun`, `scrapeRuns` with the `platformResults` edge, `searchCriteria` and
 *   `appInfo` are each one forwarding call, and the one thing that can break them is the wiring.
 *
 * Operations are executed in-process against that schema rather than over HTTP: the transport is
 * configured in `app.module.ts` and asserted there, and exercising it here would test Apollo.
 *
 * Requirements: 4.11, 4.12, 8.4, 8.13, 10.1, 10.8, 10.9, 11.2, 11.3, 11.5, 11.6, 12.5, 12.9, 14.8.
 */

import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLModule, GraphQLSchemaHost } from '@nestjs/graphql';
import { execute, type ExecutionResult, type GraphQLSchema, parse } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppInfoResolver } from '../app-info/app-info.resolver';
import { AppInfoService } from '../app-info/app-info.service';
import { AppConfigService } from '../config/config.service';
import { GRAPHQL_BUILD_SCHEMA_OPTIONS, GRAPHQL_PATH } from '../graphql/schema-options';
import { EMPLOYMENT_TYPE_LABELS_DE } from '../platform-config/criterion-value-text';
import { DOMAIN_PLATFORM_CONFIGURATION_INPUTS } from '../platform-config/platform-config.module';
import { PlatformConfigResolver } from '../platform-config/platform-config.resolver';
import {
  PLATFORM_CONFIGURATION_INPUTS,
  PlatformConfigurationService,
} from '../platform-config/platform-config.service';
import { PostingRepository } from '../posting/posting.repository';
import { PostingReadContextFactory } from '../posting/posting-read.context';
import { PostingReadResolver } from '../posting/posting-read.resolver';
import { PostingReadService } from '../posting/posting-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RelevanceService } from '../relevance/relevance.service';
import { ScrapeRunPlatformResultResolver } from '../scrape-run/scrape-run-platform-result.resolver';
import { ScrapeRunReadContextFactory } from '../scrape-run/scrape-run-read.context';
import { ScrapeRunReadResolver } from '../scrape-run/scrape-run-read.resolver';
import { ScrapeRunReadService } from '../scrape-run/scrape-run-read.service';
import { createReadStore, type ReadStoreFixture } from './read-store.fixture';

/** The Commute_Threshold in force for these reads (8.10). */
const THRESHOLD_MINUTES = 60;

/**
 * The application under test: the real GraphQL configuration of `app.module.ts` over the read
 * layer, with the Posting_Store and the two configuration holders replaced.
 *
 * `autoSchemaFile: true` keeps the generated schema in memory — the file the API_Service writes is
 * build output and a test must not overwrite it. `PrismaService` is bound to the stand-in delegates
 * because it is the injection token every read names; `AppConfigService` and `RelevanceService` are
 * bound to the two values the read layer asks them for, so this suite needs neither an environment
 * file nor an AI_Provider.
 */
const rootModuleFor = (store: ReadStoreFixture) => {
  @Module({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        path: GRAPHQL_PATH,
        buildSchemaOptions: GRAPHQL_BUILD_SCHEMA_OPTIONS,
        sortSchema: true,
        playground: false,
      }),
    ],
    providers: [
      { provide: PrismaService, useValue: store.store },
      { provide: AppConfigService, useValue: store.config },
      { provide: RelevanceService, useValue: { activated: false } },
      { provide: PLATFORM_CONFIGURATION_INPUTS, useValue: DOMAIN_PLATFORM_CONFIGURATION_INPUTS },
      PlatformConfigurationService,
      PostingRepository,
      PostingReadService,
      PostingReadContextFactory,
      PostingReadResolver,
      ScrapeRunReadService,
      ScrapeRunReadContextFactory,
      ScrapeRunReadResolver,
      ScrapeRunPlatformResultResolver,
      PlatformConfigResolver,
      AppInfoResolver,
      AppInfoService,
    ],
  })
  class RootModule {}

  return RootModule;
};

const POSTINGS = parse(`
  query Postings($sort: JobPostingSortInput) {
    jobPostings(sort: $sort) {
      totalCount
      pageCount
      page
      items {
        id
        title
        isNew
        bestCommuteLabelDe
        firstSeenRun {
          id
          runOutcome
        }
      }
    }
  }
`);

const POSTING = parse(`
  query Posting($id: ID!) {
    jobPosting(id: $id) {
      id
      descriptionText
      sourceUrl
      isNew
    }
  }
`);

const RUNS = parse(`
  query Runs {
    scrapeRuns(limit: 5) {
      id
      status
      runOutcome
      platformResults {
        platform
        platformStatus
        newPostings
      }
    }
    activeScrapeRun {
      id
      status
    }
    latestScrapeRun {
      id
      runOutcome
      newPostings
      resightedPostings
      totalPostings
    }
  }
`);

/**
 * The one named Scrape_Run the Log_View is opened on, with everything its summary states (7.4,
 * 12.10).
 *
 * The three German fields are the point of this selection: a Run_Outcome and a Platform_Status are
 * closed vocabularies whose labels live in `../common/error-mapping.ts`, and the incompleteness hint
 * of 7.4 is a whole sentence about stored values. The Web_App holds no copy of any of them, so if
 * one of these fields stopped arriving, a summary in the browser would silently lose a word it
 * cannot reproduce.
 */
const RUN_SUMMARY = parse(`
  query RunSummary($id: ID!) {
    scrapeRun(id: $id) {
      id
      status
      startedAt
      finishedAt
      runOutcome
      runOutcomeLabelDe
      resultIncompleteHintDe
      platformResults {
        platform
        platformStatus
        platformStatusLabelDe
        newPostings
        updatedPostings
        partialResult
      }
    }
  }
`);

const CRITERIA_AND_INFO = parse(`
  query CriteriaAndInfo {
    searchCriteria {
      platform
      activated
      platformStatus
      platformStatusLabelDe
      configurationHintDe
      missingMandatoryFields
      criteria {
        field
        valueText
        provenance
      }
    }
    appInfo {
      relevanceServiceActivated
      homeAddress
      commuteThresholdMinutes
      privateUseNoticeDe
    }
  }
`);

interface PostingsData {
  readonly jobPostings: {
    readonly totalCount: number;
    readonly pageCount: number;
    readonly page: number;
    readonly items: readonly {
      readonly id: string;
      readonly title: string;
      readonly isNew: boolean;
      readonly bestCommuteLabelDe: string;
      readonly firstSeenRun: { readonly id: string; readonly runOutcome: string | null };
    }[];
  };
}

let app: INestApplication;
let schema: GraphQLSchema;
let fixture: ReadStoreFixture;

const run = (
  document: ReturnType<typeof parse>,
  variableValues: Record<string, unknown> = {},
): Promise<ExecutionResult> =>
  Promise.resolve(execute({ schema, document, variableValues, contextValue: {} }));

beforeEach(async () => {
  fixture = createReadStore(THRESHOLD_MINUTES);

  fixture.seedRun({
    id: 'run-old',
    startedAt: '2026-03-01T06:00:00.000Z',
    finishedAt: '2026-03-01T06:20:00.000Z',
    status: 'FINISHED',
    runOutcome: 'COMPLETED',
  });
  fixture.seedRun({
    id: 'run-latest',
    startedAt: '2026-03-02T06:00:00.000Z',
    finishedAt: '2026-03-02T06:25:00.000Z',
    status: 'FINISHED',
    runOutcome: 'COMPLETED',
  });
  fixture.seedRun({
    id: 'run-running',
    startedAt: '2026-03-03T06:00:00.000Z',
    finishedAt: null,
    status: 'RUNNING',
    runOutcome: null,
  });

  fixture.seedPlatformResult({
    runId: 'run-latest',
    platform: 'STEPSTONE',
    platformStatus: 'COMPLETED',
    newPostings: 2,
    updatedPostings: 1,
  });
  fixture.seedPlatformResult({
    runId: 'run-old',
    platform: 'INDEED',
    platformStatus: 'FAILED',
    newPostings: 0,
    updatedPostings: 0,
  });

  fixture.seedPosting({
    id: 'posting-new',
    title: 'Projektmanagerin Pharma',
    firstSeenRunId: 'run-latest',
    bestCommuteMinutes: 38,
    bestCommuteMode: 'BICYCLE',
  });
  fixture.seedPosting({
    id: 'posting-old',
    title: 'Projektleiterin Medizintechnik',
    firstSeenRunId: 'run-old',
    bestCommuteMinutes: null,
    bestCommuteMode: null,
    descriptionText: 'Vollständige Beschreibung der Stelle.',
  });
  fixture.seedPosting({
    id: 'posting-old-2',
    title: 'Teamleitung Qualität',
    firstSeenRunId: 'run-old',
    bestCommuteMinutes: 95,
    bestCommuteMode: 'TRANSIT',
  });

  app = await NestFactory.create(rootModuleFor(fixture), { logger: false });
  await app.init();

  schema = app.get(GraphQLSchemaHost).schema;
});

afterEach(async () => {
  await app.close();
});

describe('jobPostings through the booted schema', () => {
  it('marks only the postings of the most recently completed Scrape_Run as "neu" (11.2)', async () => {
    const result = await run(POSTINGS, { sort: { field: 'PUBLISHED_AT', direction: 'ASC' } });

    expect(result.errors).toBeUndefined();

    const page = (result.data as PostingsData | undefined)?.jobPostings;

    expect(page?.totalCount).toBe(3);
    expect(page?.page).toBe(1);
    expect(page?.pageCount).toBe(1);
    expect(page?.items.map((item) => [item.id, item.isNew])).toEqual([
      ['posting-new', true],
      ['posting-old', false],
      ['posting-old-2', false],
    ]);
  });

  it('resolves the reference run once per request rather than once per row (11.2, 11.3)', async () => {
    await run(POSTINGS, { sort: { field: 'PUBLISHED_AT', direction: 'ASC' } });

    // One selection for the three rows and the page read together: the grouping of the page and the
    // marking of its rows are the same identifier, and resolving it per row would be three queries
    // for one answer that cannot change inside one request.
    expect(fixture.completedRunSelections()).toBe(1);
  });

  it('loads the firstSeenRun edge in one batched query (design: DataLoader)', async () => {
    const result = await run(POSTINGS, { sort: { field: 'PUBLISHED_AT', direction: 'ASC' } });

    const page = (result.data as PostingsData | undefined)?.jobPostings;

    expect(page?.items.map((item) => item.firstSeenRun.id)).toEqual([
      'run-latest',
      'run-old',
      'run-old',
    ]);

    // Three rows referencing two Scrape_Run: one query, not three and not two.
    expect(fixture.runBatchReads()).toEqual([['run-latest', 'run-old']]);
  });

  it('states the Best_Commute_Time as German text, with the hint of 8.13 for an unknown one', async () => {
    const result = await run(POSTINGS, { sort: { field: 'PUBLISHED_AT', direction: 'ASC' } });

    const page = (result.data as PostingsData | undefined)?.jobPostings;

    expect(page?.items.map((item) => item.bestCommuteLabelDe)).toEqual([
      '38 Min. (Fahrrad)',
      'Erreichbarkeit unbekannt',
      '95 Min. (öffentliche Verkehrsmittel)',
    ]);
  });

  it('reads the page in the default grouping where the user chose no sorting (11.3)', async () => {
    const result = await run(POSTINGS);

    expect(result.errors).toBeUndefined();

    // Two group counts instead of one unsplit count: the marked group is read before the unmarked
    // one, which is what puts the postings of the reference run above the rest.
    expect(fixture.postingCountFilters()).toHaveLength(2);
    expect((result.data as PostingsData | undefined)?.jobPostings.items.at(0)?.id).toBe(
      'posting-new',
    );
  });
});

describe('jobPosting through the booted schema', () => {
  it('answers with the stored Job_Posting including its description and link (10.8)', async () => {
    const result = await run(POSTING, { id: 'posting-old' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.jobPosting).toEqual({
      id: 'posting-old',
      descriptionText: 'Vollständige Beschreibung der Stelle.',
      sourceUrl: 'https://www.stepstone.de/stellenangebote--posting-old',
      isNew: false,
    });
  });

  it('answers an unknown identifier with null (10.8)', async () => {
    const result = await run(POSTING, { id: 'posting-missing' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.jobPosting).toBeNull();
  });
});

describe('the Scrape_Run queries through the booted schema', () => {
  it('answers the run list, the running run and the completed run with its counters', async () => {
    const result = await run(RUNS);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      scrapeRuns: [
        {
          id: 'run-running',
          status: 'RUNNING',
          runOutcome: null,
          platformResults: [],
        },
        {
          id: 'run-latest',
          status: 'FINISHED',
          runOutcome: 'COMPLETED',
          platformResults: [{ platform: 'STEPSTONE', platformStatus: 'COMPLETED', newPostings: 2 }],
        },
        {
          id: 'run-old',
          status: 'FINISHED',
          runOutcome: 'COMPLETED',
          platformResults: [{ platform: 'INDEED', platformStatus: 'FAILED', newPostings: 0 }],
        },
      ],
      activeScrapeRun: { id: 'run-running', status: 'RUNNING' },
      latestScrapeRun: {
        id: 'run-latest',
        runOutcome: 'COMPLETED',
        newPostings: 2,
        resightedPostings: 1,
        totalPostings: 3,
      },
    });
  });

  it('loads the platformResults edge in one batched query (design: DataLoader)', async () => {
    await run(RUNS);

    expect(fixture.platformResultBatchReads()).toEqual([['run-running', 'run-latest', 'run-old']]);
  });

  it('answers one named Scrape_Run with the German labels of its summary (7.4, 12.10)', async () => {
    const result = await run(RUN_SUMMARY, { id: 'run-old' });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      scrapeRun: {
        id: 'run-old',
        status: 'FINISHED',
        startedAt: '2026-03-01T06:00:00.000Z',
        finishedAt: '2026-03-01T06:20:00.000Z',
        runOutcome: 'COMPLETED',
        runOutcomeLabelDe: 'abgeschlossen',

        // 7.4: Indeed ended with the Platform_Status "failed", so the result list of this
        // Scrape_Run is incomplete and says so in one German sentence.
        resultIncompleteHintDe:
          'Die Trefferliste ist unvollständig, weil mindestens eine Plattform nicht vollständig ' +
          'abgefragt werden konnte. Bitte den Suchlauf später wiederholen.',
        platformResults: [
          {
            platform: 'INDEED',
            platformStatus: 'FAILED',
            platformStatusLabelDe: 'fehlgeschlagen',
            newPostings: 0,
            updatedPostings: 0,
            partialResult: false,
          },
        ],
      },
    });
  });

  it('reports a completely queried Scrape_Run without the incompleteness hint (7.4)', async () => {
    const result = await run(RUN_SUMMARY, { id: 'run-latest' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.scrapeRun).toMatchObject({
      id: 'run-latest',
      runOutcomeLabelDe: 'abgeschlossen',

      // Every requested Platform completed, so there is nothing missing to report — and the absence
      // is `null` rather than an empty sentence the Web_App would have to test for.
      resultIncompleteHintDe: null,
      platformResults: [
        {
          platform: 'STEPSTONE',
          platformStatusLabelDe: 'vollständig abgefragt',
          newPostings: 2,
          updatedPostings: 1,
        },
      ],
    });
  });

  it('answers a running Scrape_Run with no Run_Outcome label and no hint (12.10)', async () => {
    const result = await run(RUN_SUMMARY, { id: 'run-running' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.scrapeRun).toMatchObject({
      id: 'run-running',
      status: 'RUNNING',
      finishedAt: null,

      // A run that is still going has no outcome to label, and no Platform has reported yet, so
      // nothing is known to be missing either. The Log_View shows no summary in this state.
      runOutcome: null,
      runOutcomeLabelDe: null,
      resultIncompleteHintDe: null,
      platformResults: [],
    });
  });

  it('answers an identifier no Scrape_Run carries with null (12.10)', async () => {
    const result = await run(RUN_SUMMARY, { id: 'run-does-not-exist' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.scrapeRun).toBeNull();
  });

  it('answers latestScrapeRun with null while no Scrape_Run has completed (11.6)', async () => {
    const empty = createReadStore(THRESHOLD_MINUTES);

    empty.seedRun({
      id: 'run-cancelled',
      startedAt: '2026-03-01T06:00:00.000Z',
      finishedAt: '2026-03-01T06:02:00.000Z',
      status: 'FINISHED',
      runOutcome: 'CANCELLED_BY_USER',
    });

    const other = await NestFactory.create(rootModuleFor(empty), { logger: false });

    await other.init();

    const otherSchema = other.get(GraphQLSchemaHost).schema;
    const result = await Promise.resolve(
      execute({ schema: otherSchema, document: RUNS, contextValue: {} }),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.latestScrapeRun).toBeNull();
    expect(result.data?.activeScrapeRun).toBeNull();

    await other.close();
  });
});

describe('searchCriteria and appInfo through the booted schema', () => {
  it('answers one read-only block per Platform and the state of the Job_Tool (4.11, 4.12, 14.8)', async () => {
    const result = await run(CRITERIA_AND_INFO);

    expect(result.errors).toBeUndefined();

    const criteria = result.data?.searchCriteria as readonly {
      readonly platform: string;
      readonly platformStatusLabelDe: string;
      readonly criteria: readonly {
        readonly field: string;
        readonly valueText: string;
        readonly provenance: string;
      }[];
    }[];

    // One block per supported Platform, deactivated ones included: 4.11 scopes the view to every
    // supported Platform and 19.1 shows the state of each.
    expect(criteria).toHaveLength(4);
    expect(criteria.every((block) => block.criteria.length > 0)).toBe(true);
    expect(
      criteria.every((block) =>
        block.criteria.every((criterion) => ['DEFAULT', 'OVERRIDE'].includes(criterion.provenance)),
      ),
    ).toBe(true);

    // Every Platform_Status arrives as German text, so the Web_App holds no label table (4.7, 4.9).
    expect(criteria.every((block) => block.platformStatusLabelDe.length > 0)).toBe(true);

    // And no resolved value reaches the user as an English enum literal or as a unitless number: the
    // delivered constants carry `employmentType: 'PERMANENT'` and `searchRadiusKm: 50`.
    const valueTextOf = (field: string): readonly string[] =>
      criteria.flatMap((block) =>
        block.criteria.filter((criterion) => criterion.field === field).map((c) => c.valueText),
      );

    expect(
      valueTextOf('employmentType').every((text) => text === EMPLOYMENT_TYPE_LABELS_DE.PERMANENT),
    ).toBe(true);
    // The radius differs per Platform — Stepstone's Platform_Override sets 30 km — so the assertion
    // is the unit rather than one value.
    const radiusTexts = valueTextOf('searchRadiusKm');

    expect(radiusTexts.length).toBeGreaterThan(0);
    expect(radiusTexts.every((text) => /^\d+ km$/u.test(text))).toBe(true);

    expect(result.data?.appInfo).toEqual({
      relevanceServiceActivated: false,
      homeAddress: 'Hörkherstraße 1d, 80689 München',
      commuteThresholdMinutes: THRESHOLD_MINUTES,
      privateUseNoticeDe: expect.stringContaining('privaten Gebrauch'),
    });
  });
});
