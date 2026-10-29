import type { MockLink } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { JobPostingDocument } from '../../components/PostingDetail/job-posting.generated';
import { JobPostingsDocument } from '../../components/PostingList/job-postings.generated';
import { postingPageVariablesOf } from '../../components/PostingList/use-posting-page';
import { LatestScrapeRunDocument } from '../../components/RunSummary/latest-scrape-run.generated';
import { de } from '../../i18n/de';
import { appInfoMock } from '../../testing/apollo-fake';
import { renderAppAt } from '../../testing/render-app';

/**
 * Component tests of the detail view at `/postings/$postingId` (task 17.6).
 *
 * The subject is Requirement 10.8 — the complete description text and a labelled link to the
 * source URL of the advertisement — together with the empty-description case of 10.15, where the
 * German hint replaces the text and **the link stays**. Two states around them belong to the same
 * route and are covered here as well: an identifier that resolves to no stored Job_Posting, which
 * `jobPosting` answers with `null`, and an unreachable API_Service (2.5).
 *
 * Every expected string comes from `src/i18n/de.ts` rather than being retyped, so these tests
 * assert that the view uses the owned wording and not a literal of its own; the wording itself is
 * pinned in `src/i18n/__tests__/de.test.ts`.
 *
 * Assertions go through roles and accessible names, because what 10.8 asks for is a *labelled*
 * link: `getByRole('link', { name })` finds the element only if the accessibility tree carries that
 * name, while a query on the `href` would also pass for a link whose text is the bare URL.
 *
 * Requirements: 2.3, 2.5, 10.8, 10.15.
 */

/** Identifier and source URL used throughout; the URL is a Platform the Job_Tool supports. */
const POSTING_ID = 'ckw1a2b3c4d5e6f7g8h9i0jk';
const SOURCE_URL = 'https://www.stepstone.de/stelle/typescript-entwickler-12345';

/** One `jobPosting` answer for {@link POSTING_ID}, with the two detail fields overridden. */
function jobPostingMock(
  posting: { readonly descriptionText: string | null } | null,
): MockLink.MockedResponse {
  return {
    request: { query: JobPostingDocument, variables: { id: POSTING_ID } },
    maxUsageCount: Number.POSITIVE_INFINITY,
    result: {
      data: {
        jobPosting:
          posting === null
            ? null
            : {
                __typename: 'JobPosting',
                id: POSTING_ID,
                title: 'TypeScript-Entwickler (m/w/d)',
                descriptionText: posting.descriptionText,
                sourceUrl: SOURCE_URL,
              },
      },
    },
  };
}

/** The detail route with the shell's `appInfo` answered and one `jobPosting` answer. */
function renderDetail(posting: { readonly descriptionText: string | null } | null) {
  return renderAppAt(`/postings/${POSTING_ID}`, [appInfoMock(), jobPostingMock(posting)]);
}

/**
 * The overview's three answers, for the one test that starts in the list.
 *
 * The variables are built with `postingPageVariablesOf`, the same function the route uses: a
 * mocked response is matched on a deep comparison of the variables, so a hand-written copy of them
 * here would make the test fail for a reason that has nothing to do with the detail link.
 */
function overviewMocks(): readonly MockLink.MockedResponse[] {
  return [
    appInfoMock(),
    {
      request: { query: LatestScrapeRunDocument },
      maxUsageCount: Number.POSITIVE_INFINITY,
      result: { data: { latestScrapeRun: null } },
    },
    {
      request: {
        query: JobPostingsDocument,
        variables: postingPageVariablesOf({
          filter: {},
          sort: { field: 'FIRST_SEEN_AT', direction: 'DESC' },
          page: 1,
        }),
      },
      maxUsageCount: Number.POSITIVE_INFINITY,
      result: {
        data: {
          jobPostings: {
            __typename: 'JobPostingPage',
            page: 1,
            pageCount: 1,
            totalCount: 1,
            items: [
              {
                __typename: 'JobPosting',
                id: POSTING_ID,
                title: 'TypeScript-Entwickler (m/w/d)',
                employer: 'Beispiel GmbH',
                workLocation: 'München',
                platform: 'STEPSTONE',
                publishedAt: '2026-10-20T08:00:00.000Z',
                firstSeenAt: '2026-10-27T17:31:23.000Z',
                bestCommuteLabelDe: '38 Min. (Fahrrad)',
                bestCommuteMinutes: 38,
                postingStatus: 'LISTED',
                interestFlag: 'UNMARKED',
                isNew: false,
                relevanceVerdict: 'RELEVANT',
                relevanceReason: null,
                relevanceSetManually: false,
                relevanceAssessedAt: null,
              },
            ],
          },
        },
      },
    },
    jobPostingMock({ descriptionText: 'Vollständiger Beschreibungstext.' }),
  ];
}

describe('posting detail view', () => {
  it('shows the complete description text and the labelled link to the source URL', async () => {
    // Two paragraphs and an indented line: the stored text as the Platform showed it, which 10.8
    // asks to be displayed *completely* rather than shortened.
    const descriptionText =
      'Wir suchen eine Entwicklerin oder einen Entwickler für unser Team.\n\n' +
      'Aufgaben:\n  - TypeScript\n  - Code-Reviews';

    renderDetail({ descriptionText });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'TypeScript-Entwickler (m/w/d)' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: de.postingDetail.descriptionHeading }),
    ).toBeVisible();

    // The whole text, newlines included. `textContent` rather than `getByText`, because the
    // default normalizer of Testing Library collapses exactly the blank lines and the indentation
    // this assertion is about.
    const description = document.querySelector('.posting-detail__description');
    expect(description?.textContent).toBe(descriptionText);

    const sourceLink = screen.getByRole('link', { name: de.postingDetail.sourceLink });
    expect(sourceLink).toHaveAttribute('href', SOURCE_URL);
    // Labelled, so the accessible name is the sentence and not the URL (10.8, 2.3).
    expect(sourceLink).toHaveAccessibleName(de.postingDetail.sourceLink);
    expect(sourceLink).not.toHaveAttribute('target');

    // No hint about a missing description while there is one.
    expect(screen.queryByText(de.postingDetail.descriptionMissing)).toBeNull();
  });

  it('hints at the missing description and keeps the source link when no text was stored', async () => {
    renderDetail({ descriptionText: null });

    expect(await screen.findByText(de.postingDetail.descriptionMissing)).toBeVisible();

    // The second half of 10.15: the link is what is left to read the advertisement with.
    const sourceLink = screen.getByRole('link', { name: de.postingDetail.sourceLink });
    expect(sourceLink).toBeVisible();
    expect(sourceLink).toHaveAttribute('href', SOURCE_URL);

    expect(document.querySelector('.posting-detail__description')).toBeNull();
  });

  it('treats a description of whitespace alone as missing', async () => {
    // What a Platform leaves behind when its description container is empty. The user has nothing
    // to read either way, which is the case 10.15 describes.
    renderDetail({ descriptionText: '   \n\n\t ' });

    expect(await screen.findByText(de.postingDetail.descriptionMissing)).toBeVisible();
    expect(screen.getByRole('link', { name: de.postingDetail.sourceLink })).toBeVisible();
  });

  it('shows the German hint and the way back for an identifier that is no longer stored', async () => {
    renderDetail(null);

    expect(await screen.findByText(de.postingDetail.notFound)).toBeVisible();

    // One next step (2.5): the sentence names the Trefferliste and the link above it goes there.
    // No second control is offered, and nothing claims a description or a source URL exists.
    expect(screen.getByRole('link', { name: de.postingDetail.back })).toBeVisible();
    expect(screen.queryByRole('link', { name: de.postingDetail.sourceLink })).toBeNull();
    expect(screen.queryByRole('heading', { name: de.postingDetail.descriptionHeading })).toBeNull();
  });

  it('reports an unreachable API_Service with the Start_Script as the next step', async () => {
    renderAppAt(`/postings/${POSTING_ID}`, [
      appInfoMock(),
      {
        request: { query: JobPostingDocument, variables: { id: POSTING_ID } },
        maxUsageCount: Number.POSITIVE_INFINITY,
        error: new Error('Failed to fetch'),
      },
    ]);

    expect(await screen.findByText(de.errors.offline)).toBeVisible();
    expect(screen.getByRole('link', { name: de.postingDetail.back })).toBeVisible();
  });

  it('returns to the overview from the detail view', async () => {
    const user = userEvent.setup();
    // The overview's own answers, because the navigation lands on it: a view that arrives at an
    // unmocked query would log about it and the test would read as if something were wrong.
    const router = renderAppAt(`/postings/${POSTING_ID}`, overviewMocks());

    await screen.findByRole('heading', { level: 1, name: 'TypeScript-Entwickler (m/w/d)' });

    await user.click(screen.getByRole('link', { name: de.postingDetail.back }));

    expect(router.state.location.pathname).toBe('/postings');
  });

  it('opens the detail view from the "Aktionen" cell of a row', async () => {
    const user = userEvent.setup();
    const router = renderAppAt('/postings', overviewMocks());

    // The caption 10.8's link carries in the list, inside the cell the marking control shares.
    const detailLink = await screen.findByRole('link', { name: de.postings.openDetail });
    expect(detailLink).toBeVisible();

    await user.click(detailLink);

    expect(router.state.location.pathname).toBe(`/postings/${POSTING_ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'TypeScript-Entwickler (m/w/d)' }),
    ).toBeVisible();
  });
});
