import type { MockLink } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FILTER_VALUES,
  postingFilterInputOf,
} from '../../components/FilterBar/posting-filter-values';
import { JobPostingsDocument } from '../../components/PostingList/job-postings.generated';
import { postingPageVariablesOf } from '../../components/PostingList/use-posting-page';
import { LatestScrapeRunDocument } from '../../components/RunSummary/latest-scrape-run.generated';
import {
  DEFAULT_POSTING_SORT_SELECTION,
  sortInputOf,
} from '../../components/SortSelect/sort-selection';
import { de } from '../../i18n/de';
import { appInfoMock } from '../../testing/apollo-fake';
import { renderAppAt } from '../../testing/render-app';
import {
  activatedPlatformsMock,
  activeScrapeRunMock,
  latestScrapeRunMock,
  RUNNING_RUN_ID,
  startScrapeRunMock,
} from '../../testing/run-mocks';

/**
 * Tests of "Suchlauf starten" where the user actually finds it (task 18.1).
 *
 * Two places, one control. Requirement 2.2 puts it on the landing page as one of the four
 * functions, and 10.12 makes it the single call to action of the empty posting overview — and
 * neither may be a dead caption. What is asserted here is therefore the wiring: pressing the
 * control inside each route creates a Scrape_Run (12.1) and leaves that route showing the German
 * status display of 2.7 with the control marked as disabled, plus the way into the Log_View of the
 * run that was created (12.2).
 *
 * The behaviour of the control itself — the hint of 12.5, the two failure shapes, the 5-second
 * refresh — is asserted once, at
 * `src/components/RunControls/__tests__/start-run-control.test.tsx`. Repeating it per route would
 * test the same component twice and say nothing about either page.
 *
 * Variables of the posting page are built with the production functions
 * (`postingPageVariablesOf`, `postingFilterInputOf`, `sortInputOf`), because a mocked answer is
 * matched on a deep comparison of the variables and a hand-written copy would fail for a reason
 * that says nothing about the view.
 *
 * Requirements: 2.2, 2.7, 10.12, 12.1.
 */

/** The answers the posting overview needs to arrive at the empty state of 10.12. */
function emptyOverviewMocks(): readonly MockLink.MockedResponse[] {
  return [
    {
      request: {
        query: JobPostingsDocument,
        variables: postingPageVariablesOf({
          filter: postingFilterInputOf(DEFAULT_FILTER_VALUES),
          sort: sortInputOf(DEFAULT_POSTING_SORT_SELECTION),
          page: 1,
        }),
      },
      maxUsageCount: Number.POSITIVE_INFINITY,
      result: {
        data: {
          jobPostings: {
            __typename: 'JobPostingPage',
            page: 1,
            pageCount: 0,
            totalCount: 0,
            items: [],
          },
        },
      },
    },
    {
      // No completed Scrape_Run, which is what makes this the empty state of 10.12 rather than the
      // "keine Treffer" hint of 2.8.
      request: { query: LatestScrapeRunDocument },
      maxUsageCount: Number.POSITIVE_INFINITY,
      result: { data: { latestScrapeRun: null } },
    },
  ];
}

/** The run-control answers: no run at first, a running one after the press. */
function startRunMocks(): readonly MockLink.MockedResponse[] {
  return [
    activeScrapeRunMock(null, { maxUsageCount: 1 }),
    activeScrapeRunMock({ finishedPlatforms: [] }),
    activatedPlatformsMock(),
    startScrapeRunMock({ runId: RUNNING_RUN_ID }),
  ];
}

describe('starting a Scrape_Run from a route', () => {
  it('starts a Scrape_Run from the landing page with one activation', async () => {
    const user = userEvent.setup();
    // `latestScrapeRun` is the fallback "Log öffnen" reads next to the start control, and `null` is
    // what it answers before any Scrape_Run has completed (see `./index.test.tsx`).
    const router = renderAppAt('/', [appInfoMock(), latestScrapeRunMock(null), ...startRunMocks()]);

    const button = await screen.findByRole('button', { name: de.landing.startRun });

    // 2.2 and 2.3: one keyboard activation from the landing page, no mouse involved.
    button.focus();
    await user.keyboard('{Enter}');

    // 12.1: the Scrape_Run was created, and the landing page now carries the status display of 2.7
    // with the control marked as disabled.
    expect(await screen.findByText(de.log.running.label)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(de.log.running.platformProgress(0, 4));
    expect(screen.getByRole('button', { name: de.landing.startRun })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // 12.2: the way into the Log_View of the Scrape_Run that was just created. Offered, not taken —
    // the user is still on the landing page until they follow it, which is what keeps the status
    // display of 2.7 on the screen.
    expect(screen.getByRole('link', { name: de.postings.runSummary.openLog })).toHaveAttribute(
      'href',
      `/runs/${RUNNING_RUN_ID}/log`,
    );
    expect(router.state.location.pathname).toBe('/');
  });

  it('starts a Scrape_Run from the empty posting overview of 10.12', async () => {
    const user = userEvent.setup();
    renderAppAt('/postings', [appInfoMock(), ...emptyOverviewMocks(), ...startRunMocks()]);

    // The empty state of 10.12, whose single call to action is the same function as on the landing
    // page — and the same component, which is why the caption is the one both criteria pin.
    expect(
      await screen.findByRole('heading', { name: de.postings.empty.storeHeading }),
    ).toBeVisible();

    const button = screen.getByRole('button', { name: de.postings.empty.storeAction });

    expect(button).toHaveAttribute('aria-disabled', 'false');

    await user.click(button);

    // 12.1 and 2.7: the control in the empty state is wired to the same mutation and shows the same
    // status display. The empty state stays, because a Scrape_Run that has just started has not
    // stored a Job_Posting yet.
    expect(await screen.findByText(de.log.running.label)).toBeVisible();
    expect(screen.getByRole('button', { name: de.postings.empty.storeAction })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('link', { name: de.postings.runSummary.openLog })).toHaveAttribute(
      'href',
      `/runs/${RUNNING_RUN_ID}/log`,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks the start on the landing page while a Scrape_Run is already running', async () => {
    const user = userEvent.setup();

    // No `startScrapeRun` answer: a mutation sent from here would fail and show a notice, which is
    // what makes the absence of one an assertion.
    renderAppAt('/', [
      appInfoMock(),
      activeScrapeRunMock({ finishedPlatforms: ['STEPSTONE', 'JOBVECTOR'] }),
      activatedPlatformsMock(),
      latestScrapeRunMock(null),
    ]);

    expect(await screen.findByText(de.log.running.label)).toBeVisible();

    const button = screen.getByRole('button', { name: de.landing.startRun });

    // 2.7: the control is marked as disabled while a Scrape_Run is running, and pressing it does
    // nothing — while keeping the focus, so the user does not lose their place in the page (2.3).
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await user.click(button);

    expect(button).toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();

    // 12.6, as the Web_App's half: the German hint plus a link to the Log_View of that run.
    expect(screen.getByText(de.log.startRunDisabledHint)).toBeVisible();
    expect(screen.getByRole('link', { name: de.postings.runSummary.openLog })).toHaveAttribute(
      'href',
      `/runs/${RUNNING_RUN_ID}/log`,
    );

    // 2.7, the progress half: two of the four activated Platform are done.
    expect(screen.getByRole('status')).toHaveTextContent(de.log.running.platformProgress(2, 4));
  });
});
