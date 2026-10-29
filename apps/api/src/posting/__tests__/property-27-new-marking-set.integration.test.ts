/**
 * Property 27 of the job-search-tool design: the marking "neu" is exactly the Job_Posting of the
 * most recently completed Scrape_Run (11.2, 11.4, 11.6, 11.7).
 *
 * Four claims about *all* Scrape_Run histories at once, which is what makes this a property rather
 * than the by-example runs of `../../scrape-run/__tests__/scrape-run-read.service.test.ts`: the
 * marked set is exactly the set recorded by the completed Scrape_Run with the latest end time
 * (11.2), it moves to a further completed Scrape_Run without a single write to a Job_Posting (11.4),
 * it is empty while no Scrape_Run has completed (11.6), and a Scrape_Run that ended with any other
 * Run_Outcome never becomes the reference, so its own Job_Posting are stored and listed but unmarked
 * (11.7).
 *
 * **Where the predicate is evaluated, and why.** Against real PostgreSQL, through
 * `ScrapeRunReadService` on a seeded store, with `isNewPosting` applied to the rows the store hands
 * back — the same two steps the read layer takes (`PostingReadContextFactory` resolves the
 * identifier once per request and `PostingReadResolver.isNew` compares it). The alternative, the
 * pure predicate over a hand-written in-memory run store, was rejected: `isNewPosting` is a single
 * equality and already covered by example, while every one of the four claims above is a statement
 * about *which* Scrape_Run the reference is — the `where` of the selection (11.6, 11.7), its
 * `orderBy` (11.2) and the absence of any caching (11.4). A fake `scrapeRun.findFirst` would have to
 * reimplement that filter and that three-key descending sort, so the test would compare the
 * selection rule against a second copy of itself and a misreading shared by both would pass
 * unnoticed. `../posting.repository.new-first-page.test.ts` already evaluates the grouping of 11.3
 * that way, against in-memory delegates, because that one *is* arithmetic over counts.
 *
 * `pnpm test` stays offline: the file is an `*.integration.test.ts` and therefore excluded from the
 * unit configuration, like Properties 7 to 9 and Property 24.
 *
 * **The oracle** is computed from the generated history: the reference is the Scrape_Run with the
 * Run_Outcome "completed" and the latest end time, and the expected marked set is every generated
 * Job_Posting assigned to it. The oracle resolves an equal end time by the later start time and then
 * by the identifier, which is more than 11.2 words. That is deliberate rather than an oracle written
 * from the implementation: `finishedAt` has millisecond precision, the generator produces end-time
 * ties in most iterations, and a tie left to the query plan would make the marking of 11.2
 * non-deterministic. Asserting the prescribed order asserts that determinism. The identifiers are
 * `run-00` … `run-06`, equal in length and ASCII-only, so the engine's collation cannot make its
 * `id` comparison disagree with the oracle's.
 *
 * The generated history mixes all five end states a Scrape_Run can be in — completed, cancelled by
 * the user, ended by the 30-minute retrieval limit of 13.6, closed by the stale-run recovery with
 * `closedByRecovery` and still running — so the iterations that hold no completed run at all are the
 * 11.6 case, and every other kind standing above the reference run in time is the 11.7 case.
 *
 * Two things are asserted beyond the set comparison, because the comparison alone would let each
 * pass:
 *
 * - **11.4 needs no write.** Every Job_Posting row is read before the further Scrape_Run is appended
 *   and compared column by column afterwards. The marking moves because the compared identifier
 *   moved, and `firstSeenRunId` stays where it was (11.8). The same `ScrapeRunReadService` instance
 *   answers before and after, so a cached identifier — the stale answer 11.4 forbids — fails here.
 * - **The counters reference the same Scrape_Run.** `latestScrapeRunSummary` is about the same run
 *   the marking compares against, before and after the append, and is absent exactly when the
 *   marking is (11.6). That the three numbers equal the stored data is Property 29.
 *
 * Each iteration clears the store and writes its own runs, because a Job_Posting needs its recording
 * Scrape_Run as a restricted foreign key (11.1). The marked set is read from the whole `JobPosting`
 * table rather than through `PostingRepository.findPage`, so the default view of 10.6 and 10.11
 * cannot hide a row the claim is about — filtering is Property 24.
 */

// Feature: job-search-tool, Property 27 - The "neu" marking is exactly the postings of the most recently completed Scrape_Run

import { computeContentHash } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JobPosting, RunOutcome, RunStatus } from '../../prisma/prisma.types';
import { ScrapeRunReadService } from '../../scrape-run/scrape-run-read.service';
import { usePostgres } from '../../testing/postgres-harness';
import { isNewPosting } from '../new-marking';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** Scrape_Run per generated history, before the appended one. */
const MAX_RUNS = 7;

/** Job_Posting the generated history records, spread over its runs. */
const MAX_POSTINGS = 10;

/** Job_Posting the appended Scrape_Run records for the first time. */
const MAX_APPENDED_POSTINGS = 3;

/** The instant every generated time is measured from. */
const BASE_TIME = new Date('2026-03-02T08:00:00.000Z');

/**
 * Minutes after {@link BASE_TIME} a generated Scrape_Run can end at.
 *
 * Deliberately tiny: with four possible end times per history, two completed runs share one in most
 * iterations, which is what puts the tie-breaking of 11.2 under test in every run instead of by
 * luck.
 */
const MAX_END_OFFSET_MINUTES = 3;

/** The appended Scrape_Run ends after every generated one, so a completed one is the new reference. */
const APPENDED_END_OFFSET_MINUTES = MAX_END_OFFSET_MINUTES + 1;

/** Identifier of the appended Scrape_Run; distinct from every `run-NN` of the history. */
const APPENDED_RUN_ID = 'run-appended';

/** How a generated Scrape_Run ended, i.e. the five states 11.2 and 11.7 distinguish. */
const RUN_KINDS = [
  'COMPLETED',
  'CANCELLED_BY_USER',
  'TIME_LIMITED',
  'RECOVERY_CLOSED',
  'RUNNING',
] as const;

type RunKind = (typeof RUN_KINDS)[number];

/** One generated Scrape_Run: how it ended and when. */
interface RunSpec {
  readonly kind: RunKind;
  /** Minutes after {@link BASE_TIME} the run ended at; ignored while it is still running. */
  readonly endOffsetMinutes: number;
  /** How long the run took, which is what makes the start time a usable tie-breaker. */
  readonly durationMinutes: number;
}

/** A Scrape_Run as it is stored, in the columns the selection of 11.2 reads. */
interface RunRow {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly status: RunStatus;
  readonly runOutcome: RunOutcome | null;
  readonly closedByRecovery: boolean;
}

/** A Job_Posting as it is stored here, in the one column the marking is derived from (11.1). */
interface PostingRow {
  readonly postingId: string;
  readonly firstSeenRunId: string;
}

/** One generated scenario: a history, its Job_Posting, and the Scrape_Run appended afterwards. */
interface Scenario {
  readonly runs: readonly RunSpec[];
  /** Per Job_Posting the index of the Scrape_Run in {@link runs} that recorded it first. */
  readonly postings: readonly number[];
  readonly appended: RunSpec;
  readonly appendedPostings: number;
}

/** A time {@link BASE_TIME} plus the given minutes; negative offsets reach back before it. */
const minutesAfter = (minutes: number): Date => new Date(BASE_TIME.getTime() + minutes * 60_000);

/** The identifier of the n-th generated Scrape_Run: fixed width, so `id desc` is collation-proof. */
const runIdOf = (index: number): string => `run-${String(index).padStart(2, '0')}`;

/**
 * The stored row of a generated Scrape_Run.
 *
 * The three end states other than "completed" differ from it in exactly the columns the API_Service
 * writes: a cancelled run and one the retrieval limit ended are `FINISHED` with another
 * Run_Outcome, the recovery-closed one carries `closedByRecovery` on top (13.6), and a running one
 * has no end time and no Run_Outcome at all (Glossary).
 */
const runRowOf = (spec: RunSpec, id: string, endOffsetMinutes: number): RunRow => {
  const startedAt = minutesAfter(endOffsetMinutes - spec.durationMinutes);
  const finishedAt = minutesAfter(endOffsetMinutes);

  switch (spec.kind) {
    case 'COMPLETED':
      return {
        id,
        startedAt,
        finishedAt,
        status: 'FINISHED',
        runOutcome: 'COMPLETED',
        closedByRecovery: false,
      };
    case 'CANCELLED_BY_USER':
      return {
        id,
        startedAt,
        finishedAt,
        status: 'FINISHED',
        runOutcome: 'CANCELLED_BY_USER',
        closedByRecovery: false,
      };
    case 'TIME_LIMITED':
      return {
        id,
        startedAt,
        finishedAt,
        status: 'FINISHED',
        runOutcome: 'CANCELLED_BY_TIME_LIMIT',
        closedByRecovery: false,
      };
    case 'RECOVERY_CLOSED':
      return {
        id,
        startedAt,
        finishedAt,
        status: 'FINISHED',
        runOutcome: 'CANCELLED_BY_TIME_LIMIT',
        closedByRecovery: true,
      };
    case 'RUNNING':
      return {
        id,
        startedAt,
        finishedAt: null,
        status: 'RUNNING',
        runOutcome: null,
        closedByRecovery: false,
      };
  }
};

/** Whether this stored Scrape_Run is one the marking may refer to at all (11.2, 11.7). */
const isCompleted = (row: RunRow): boolean =>
  row.status === 'FINISHED' && row.runOutcome === 'COMPLETED' && row.finishedAt !== null;

/**
 * Which of two completed Scrape_Run is the more recent one: positive when `candidate` wins.
 *
 * End time first, as 11.2 words it, then the later start time and then the identifier, so two runs
 * that ended in the same millisecond have one defined answer rather than the store's row order.
 */
const compareCompleted = (candidate: RunRow, best: RunRow): number => {
  const byEnd = (candidate.finishedAt?.getTime() ?? 0) - (best.finishedAt?.getTime() ?? 0);

  if (byEnd !== 0) {
    return byEnd;
  }

  const byStart = candidate.startedAt.getTime() - best.startedAt.getTime();

  return byStart === 0 ? candidate.id.localeCompare(best.id) : byStart;
};

/** The reference Scrape_Run of a stored history, or null where none has completed (11.2, 11.6). */
const referenceRunOf = (rows: readonly RunRow[]): RunRow | null =>
  rows
    .filter(isCompleted)
    .reduce<RunRow | null>(
      (best, candidate) =>
        best === null || compareCompleted(candidate, best) > 0 ? candidate : best,
      null,
    );

/** The Posting_Id the marking is expected on: those recorded by the reference Scrape_Run. */
const expectedMarkedIds = (
  postings: readonly PostingRow[],
  referenceRun: RunRow | null,
): Set<string> =>
  new Set(
    referenceRun === null
      ? []
      : postings
          .filter((posting) => posting.firstSeenRunId === referenceRun.id)
          .map((posting) => posting.postingId),
  );

const runArbitrary = fc.record<RunSpec>({
  kind: fc.constantFrom(...RUN_KINDS),
  endOffsetMinutes: fc.integer({ min: 0, max: MAX_END_OFFSET_MINUTES }),
  durationMinutes: fc.integer({ min: 1, max: 3 }),
});

/**
 * One generated scenario.
 *
 * Chained, so each Job_Posting names an existing Scrape_Run by index: the history's length is drawn
 * first and the recording runs are drawn against it. An empty history is reachable and records no
 * Job_Posting — the empty Posting_Store, which is one half of the 11.6 case.
 */
const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .array(runArbitrary, { maxLength: MAX_RUNS })
  .chain((runs) =>
    fc.record<Scenario>({
      runs: fc.constant(runs),
      postings:
        runs.length === 0
          ? fc.constant<readonly number[]>([])
          : fc.array(fc.integer({ min: 0, max: runs.length - 1 }), { maxLength: MAX_POSTINGS }),
      appended: runArbitrary,
      appendedPostings: fc.integer({ min: 0, max: MAX_APPENDED_POSTINGS }),
    }),
  );

/**
 * A history that holds every end state at once, with both tie-breakers in play.
 *
 * `run-00` and `run-01` are completed, ended in the same millisecond and took the same time, so only
 * the identifier separates them and `run-01` is the reference. `run-02` to `run-04` end later than
 * both with the three other Run_Outcome and the still-running state, which is 11.7, and `run-05` is
 * an earlier completed run whose postings must lose the marking. The appended run is completed, so
 * the example also walks the 11.4 handover.
 */
const EXAMPLE_SCENARIO: Scenario = {
  runs: [
    { kind: 'COMPLETED', endOffsetMinutes: 1, durationMinutes: 1 },
    { kind: 'COMPLETED', endOffsetMinutes: 1, durationMinutes: 1 },
    { kind: 'CANCELLED_BY_USER', endOffsetMinutes: 3, durationMinutes: 2 },
    { kind: 'TIME_LIMITED', endOffsetMinutes: 3, durationMinutes: 1 },
    { kind: 'RECOVERY_CLOSED', endOffsetMinutes: 3, durationMinutes: 3 },
    { kind: 'COMPLETED', endOffsetMinutes: 0, durationMinutes: 1 },
    { kind: 'RUNNING', endOffsetMinutes: 3, durationMinutes: 1 },
  ],
  postings: [0, 1, 1, 2, 3, 4, 5, 6],
  appended: {
    kind: 'COMPLETED',
    endOffsetMinutes: APPENDED_END_OFFSET_MINUTES,
    durationMinutes: 2,
  },
  appendedPostings: 2,
};

/** A history without a single completed Scrape_Run: the marking is empty whatever is stored (11.6). */
const NO_COMPLETED_RUN_SCENARIO: Scenario = {
  runs: [
    { kind: 'CANCELLED_BY_USER', endOffsetMinutes: 0, durationMinutes: 1 },
    { kind: 'RECOVERY_CLOSED', endOffsetMinutes: 2, durationMinutes: 2 },
    { kind: 'RUNNING', endOffsetMinutes: 3, durationMinutes: 1 },
  ],
  postings: [0, 1, 2],
  appended: {
    kind: 'TIME_LIMITED',
    endOffsetMinutes: APPENDED_END_OFFSET_MINUTES,
    durationMinutes: 1,
  },
  appendedPostings: 2,
};

const postgres = usePostgres();

/** The columns every stored Job_Posting needs, beside the recording run the marking is read from. */
const postingDataOf = (posting: PostingRow) => {
  const title = `Projektmanagerin ${posting.postingId}`;
  const descriptionText = 'Sie steuern Projekte im Bereich Life Science.';

  return {
    platform: 'STEPSTONE' as const,
    postingId: posting.postingId,
    title,
    employer: 'Beispiel Pharma GmbH',
    workLocation: 'München',
    sourceUrl: `https://www.stepstone.example/--${posting.postingId}`,
    descriptionText,
    firstSeenAt: BASE_TIME,
    lastSeenAt: BASE_TIME,
    firstSeenRunId: posting.firstSeenRunId,
    contentHash: computeContentHash(title, descriptionText),
  };
};

/** Writes Scrape_Run and Job_Posting into the store; either list may be empty. */
const seed = async (runs: readonly RunRow[], postings: readonly PostingRow[]): Promise<void> => {
  if (runs.length > 0) {
    await postgres.prisma.scrapeRun.createMany({ data: [...runs] });
  }

  if (postings.length > 0) {
    await postgres.prisma.jobPosting.createMany({ data: postings.map(postingDataOf) });
  }
};

/** Every stored Job_Posting, in a fixed order, so two reads are comparable column by column. */
const storedPostings = async (): Promise<readonly JobPosting[]> =>
  postgres.prisma.jobPosting.findMany({ orderBy: { postingId: 'asc' } });

/** The marking of 11.2, derived exactly as the read layer derives it: one equality per stored row. */
const markedIdsOf = (
  rows: readonly JobPosting[],
  latestCompletedRunId: string | null,
): Set<string> =>
  new Set(
    rows.filter((row) => isNewPosting(row, latestCompletedRunId)).map((row) => row.postingId),
  );

describe('Property 27: The "neu" marking is exactly the postings of the most recently completed Scrape_Run', () => {
  /**
   * **Validates: Requirements 11.2, 11.4, 11.6, 11.7**
   *
   * For all Scrape_Run histories and for all assignments of Job_Posting to their recording
   * Scrape_Run, exactly those Job_Posting whose recording Scrape_Run is the completed Scrape_Run
   * with the latest end time are marked "neu"; no Job_Posting is marked while no Scrape_Run carries
   * the Run_Outcome "completed"; appending a Scrape_Run that reaches "completed" moves the whole
   * marking to its own Job_Posting without any write to a stored Job_Posting; and appending a
   * Scrape_Run with any other Run_Outcome changes no marking and leaves its own Job_Posting
   * unmarked.
   */
  it('marks exactly the postings of the reference run, and moves the set only when a run completes', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        await postgres.truncate();

        const runs = scenario.runs.map((spec, index) =>
          runRowOf(spec, runIdOf(index), spec.endOffsetMinutes),
        );
        const postings = scenario.postings.map((runIndex, index) => ({
          postingId: `p${String(index)}`,
          firstSeenRunId: runIdOf(runIndex),
        }));

        await seed(runs, postings);

        // One instance for both halves of the iteration: the second read below has to ask the
        // Posting_Store again, which is what 11.4 means by "on the next build of the overview".
        const service = new ScrapeRunReadService(postgres.prisma);

        // 11.2, 11.6: the reference run is the completed one with the latest end time, and absent
        // where the history holds none.
        const referenceRun = referenceRunOf(runs);
        const latestCompletedRunId = await service.latestCompletedRunId();

        expect(latestCompletedRunId).toBe(referenceRun?.id ?? null);

        // 11.2, 11.7: the marked set is exactly the set that reference run recorded. Set equality is
        // both halves at once — nothing marked that another run recorded, nothing of that run
        // missing — and the runs of 11.7 standing later in time contribute nothing to it.
        const before = await storedPostings();

        expect(before).toHaveLength(postings.length);

        const marked = markedIdsOf(before, latestCompletedRunId);

        expect(marked).toEqual(expectedMarkedIds(postings, referenceRun));

        // 11.6: no completed Scrape_Run means no marking at all, whatever is stored.
        if (referenceRun === null) {
          expect(marked.size).toBe(0);
        }

        // The counters of the overview are about the same Scrape_Run the marking compares against,
        // and are absent exactly when it is (11.5, 11.6).
        const summary = await service.latestScrapeRunSummary();

        expect(summary?.id ?? null).toBe(latestCompletedRunId);

        // A further Scrape_Run ends, with the generated Run_Outcome and after every earlier run.
        const appendedRun = runRowOf(
          scenario.appended,
          APPENDED_RUN_ID,
          APPENDED_END_OFFSET_MINUTES,
        );
        const appendedPostings = Array.from(
          { length: scenario.appendedPostings },
          (_unused, index) => ({
            postingId: `a${String(index)}`,
            firstSeenRunId: APPENDED_RUN_ID,
          }),
        );

        await seed([appendedRun], appendedPostings);

        const latestAfter = await service.latestCompletedRunId();
        const storedAfter = await storedPostings();
        const markedAfter = markedIdsOf(storedAfter, latestAfter);

        if (scenario.appended.kind === 'COMPLETED') {
          // 11.4: the marking is now that run's, and every other Job_Posting lost it.
          expect(latestAfter).toBe(APPENDED_RUN_ID);
          expect(markedAfter).toEqual(
            new Set(appendedPostings.map((posting) => posting.postingId)),
          );
        } else {
          // 11.7: the reference run and the marked set are untouched, and the Job_Posting the ended
          // run recorded for the first time are stored and listed without the marking.
          expect(latestAfter).toBe(latestCompletedRunId);
          expect(markedAfter).toEqual(marked);

          for (const posting of appendedPostings) {
            expect(markedAfter.has(posting.postingId)).toBe(false);
          }
        }

        // 11.4, 11.8: the handover wrote nothing. Every Job_Posting stored before the append is
        // unchanged in every column, `firstSeenRunId` included, so the marking moved by comparison
        // alone.
        const untouched = storedAfter.filter((row) =>
          before.some((earlier) => earlier.id === row.id),
        );

        expect(untouched).toStrictEqual(before);
      }),
      { ...PROPERTY_RUNS, examples: [[EXAMPLE_SCENARIO], [NO_COMPLETED_RUN_SCENARIO]] },
    );
  });
});
