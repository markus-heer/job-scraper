import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RelevanceVerdict } from '../../../graphql/schema.generated';
import { de } from '../../../i18n/de';
import { CommuteBadge } from '../CommuteBadge';
import { NewBadge } from '../NewBadge';
import { RelevanceBadge } from '../RelevanceBadge';

/**
 * Component tests of the three badges of the posting list (task 17.7).
 *
 * The badges are where Requirement 2.4 is kept or lost: every state they show has to be readable
 * from text, or from a symbol with a textual alternative, and never from colour alone. So these
 * tests assert the *text* of each state and never the class the stylesheet colours it with — a
 * badge that lost its label but kept its class would still look right in a screenshot and would
 * fail here.
 *
 * Rendered directly rather than through the overview route. All three badges are pure functions of
 * their props, the interesting part of each is a branch over those props, and the route-level test
 * in `src/routes/__tests__/postings-overview.test.tsx` already covers that the row passes the
 * server's values into them. Going through the route for every verdict and every commute case
 * would mean one mocked page of Job_Posting per case, which tests the mock more than the badge.
 *
 * Every expected German string comes from `src/i18n/de.ts`. The one exception is
 * `bestCommuteLabelDe`: the commute line is the API_Service's sentence (8.4, 8.13), so it arrives
 * as a prop here the way it arrives over the wire, and the Web_App owns no copy of it.
 *
 * Requirements: 2.4, 8.3, 8.13, 10.2, 10.3, 10.4, 11.2, 15.15.
 */

/**
 * Every Relevance_Verdict with its German label, keyed by the enum value.
 *
 * The cast is the same one `filterOptionsOf` makes in `../../FilterBar/posting-filter-values.ts`
 * and is sound for the same reason: `de.vocabulary.relevanceVerdict` carries a `satisfies`
 * clause against the closed vocabulary in `src/i18n/de.ts`, so a fifth verdict added to the domain
 * tuples fails the type check there and appears in this list without a change to this file.
 */
const EVERY_VERDICT = Object.entries(de.vocabulary.relevanceVerdict) as readonly [
  RelevanceVerdict,
  string,
][];

/** The commute line as the API_Service words it for a known Best_Commute_Time (8.4). */
const COMMUTE_LINE = '38 Min. (Fahrrad)';

/** The commute line for a Best_Commute_Time stored as "unknown" (8.13, 10.1). */
const COMMUTE_UNKNOWN_LINE = 'Erreichbarkeit unbekannt';

describe('RelevanceBadge', () => {
  it.each(EVERY_VERDICT)('names the verdict %s as text', (verdict, label) => {
    render(
      <RelevanceBadge assessedAt={null} reason={null} setManually={false} verdict={verdict} />,
    );

    // 10.4: identified "through text in addition to colour". The label is present without any
    // stylesheet being loaded, which is what makes the colour decoration rather than the statement.
    expect(screen.getByText(label)).toBeVisible();
  });

  it('gives every verdict a label of its own', () => {
    // Four distinct words, so no two verdicts read the same in greyscale (10.4). A map that lost a
    // key would fail the type check in `src/i18n/de.ts`; this holds the labels apart.
    const labels = EVERY_VERDICT.map(([, label]) => label);

    expect(new Set(labels).size).toBe(labels.length);
  });

  it('marks a verdict the user set by hand as manually set', () => {
    render(<RelevanceBadge assessedAt={null} reason={null} setManually verdict="NOT_RELEVANT" />);

    // 10.3: which side set the verdict.
    expect(screen.getByText(de.postings.badges.verdictSetManually)).toBeVisible();
    expect(screen.queryByText(de.postings.badges.verdictFromService)).toBeNull();
  });

  it('marks a verdict an assessment produced as assessed by the service', () => {
    render(
      <RelevanceBadge
        assessedAt="2026-10-27T18:00:00.000Z"
        reason={null}
        setManually={false}
        verdict="RELEVANT"
      />,
    );

    expect(screen.getByText(de.postings.badges.verdictFromService)).toBeVisible();
    expect(screen.queryByText(de.postings.badges.verdictSetManually)).toBeNull();
  });

  it('keeps the manual origin where an overridden assessment left its timestamp behind', () => {
    // 15.15: a manual verdict stays in force in place of the service assessment, so the origin the
    // user reads is the manual one even though `relevanceAssessedAt` is still set.
    render(
      <RelevanceBadge
        assessedAt="2026-10-27T18:00:00.000Z"
        reason={null}
        setManually
        verdict="RELEVANT"
      />,
    );

    expect(screen.getByText(de.postings.badges.verdictSetManually)).toBeVisible();
    expect(screen.queryByText(de.postings.badges.verdictFromService)).toBeNull();
  });

  it('claims no origin for a Job_Posting nothing has assessed', () => {
    // The third state 10.3 does not name: never assessed, never set by hand — which is every
    // posting while the Relevance_Service is deactivated (15.9). "durch KI bewertet" here would
    // assert an assessment that never happened; the verdict label is the whole statement.
    render(
      <RelevanceBadge assessedAt={null} reason={null} setManually={false} verdict="NOT_ASSESSED" />,
    );

    expect(screen.getByText(de.vocabulary.relevanceVerdict.NOT_ASSESSED)).toBeVisible();
    expect(screen.queryByText(de.postings.badges.verdictSetManually)).toBeNull();
    expect(screen.queryByText(de.postings.badges.verdictFromService)).toBeNull();
  });

  it('shows a stored Relevance_Reason under its own heading', () => {
    // The sentence is the AI_Provider's (15.3) and is printed unchanged; the Web_App owns the
    // heading next to it and nothing else (10.2).
    const reason = 'Profil passt zur Stellenbeschreibung, Fahrzeit liegt im Rahmen.';

    render(<RelevanceBadge assessedAt={null} reason={reason} setManually verdict="RELEVANT" />);

    expect(screen.getByText(de.postings.badges.relevanceReasonLabel)).toBeVisible();
    expect(screen.getByText(reason)).toBeVisible();
  });

  it('omits the reason block where no reason is stored', () => {
    render(<RelevanceBadge assessedAt={null} reason={null} setManually verdict="RELEVANT" />);

    // 10.2 conditions the reason on a stored one, so an empty "Begründung" heading is not shown.
    expect(screen.queryByText(de.postings.badges.relevanceReasonLabel)).toBeNull();
  });
});

describe('CommuteBadge', () => {
  it('prints the commute line of the API_Service unchanged', () => {
    render(
      <CommuteBadge
        bestCommuteLabelDe={COMMUTE_LINE}
        bestCommuteMinutes={38}
        commuteThresholdMinutes={60}
      />,
    );

    // 8.4 and 10.1: minutes with the mode of transport, worded once, on the server.
    expect(screen.getByText(COMMUTE_LINE)).toBeVisible();
  });

  it('hints at a Best_Commute_Time below the Commute_Threshold', () => {
    render(
      <CommuteBadge
        bestCommuteLabelDe={COMMUTE_LINE}
        bestCommuteMinutes={38}
        commuteThresholdMinutes={60}
      />,
    );

    // 8.3 as text, plus the symbol with its textual alternative (2.4). Both halves are found by
    // role and name, so neither is carried by colour.
    expect(screen.getByText(de.postings.badges.wellReachable)).toBeVisible();
    expect(
      screen.getByRole('img', { name: de.postings.badges.wellReachableSymbolAlt }),
    ).toBeVisible();
  });

  it('counts the Commute_Threshold itself as well reachable', () => {
    // "at most the Commute_Threshold" (8.3): the boundary value qualifies, the same way the
    // `WELL_REACHABLE` filter of 8.11 reads it on the server.
    render(
      <CommuteBadge
        bestCommuteLabelDe="60 Min. (Auto)"
        bestCommuteMinutes={60}
        commuteThresholdMinutes={60}
      />,
    );

    expect(screen.getByText(de.postings.badges.wellReachable)).toBeVisible();
  });

  it('omits the hint one minute above the Commute_Threshold', () => {
    render(
      <CommuteBadge
        bestCommuteLabelDe="61 Min. (Auto)"
        bestCommuteMinutes={61}
        commuteThresholdMinutes={60}
      />,
    );

    expect(screen.getByText('61 Min. (Auto)')).toBeVisible();
    expect(screen.queryByText(de.postings.badges.wellReachable)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows the unknown-reachability line and no hint for an unknown Best_Commute_Time', () => {
    render(
      <CommuteBadge
        bestCommuteLabelDe={COMMUTE_UNKNOWN_LINE}
        bestCommuteMinutes={null}
        commuteThresholdMinutes={60}
      />,
    );

    // 8.13 and 10.1: a hint instead of a number — and never both at once (Property 16). An unknown
    // commute is never well reachable, which is the same exclusion 8.11 makes.
    expect(screen.getByText(COMMUTE_UNKNOWN_LINE)).toBeVisible();
    expect(screen.queryByText(de.postings.badges.wellReachable)).toBeNull();
  });

  it('omits the hint while no Commute_Threshold is known', () => {
    // The `appInfo` query is still in flight or failed, so there is no threshold to compare
    // against (8.10). The line is still shown; claiming "gut erreichbar" against a guessed
    // threshold would be a statement nothing in the Posting_Store supports.
    render(
      <CommuteBadge
        bestCommuteLabelDe={COMMUTE_LINE}
        bestCommuteMinutes={38}
        commuteThresholdMinutes={null}
      />,
    );

    expect(screen.getByText(COMMUTE_LINE)).toBeVisible();
    expect(screen.queryByText(de.postings.badges.wellReachable)).toBeNull();
  });
});

describe('NewBadge', () => {
  it('marks a Job_Posting of the most recently completed Scrape_Run with the word and the symbol', () => {
    render(<NewBadge isNew />);

    // 11.2 asks for the text label *and* a symbol in addition to colour; 2.4 asks for the symbol to
    // carry a textual alternative. All three layers say the same thing on their own.
    expect(screen.getByText(de.postings.badges.isNew)).toBeVisible();
    expect(screen.getByRole('img', { name: de.postings.badges.isNewSymbolAlt })).toBeVisible();
  });

  it('marks nothing on a Job_Posting that is not new', () => {
    const { container } = render(<NewBadge isNew={false} />);

    // No "alt" badge on every remaining row: 11.2 marks the new postings and says nothing about the
    // others, and 11.6 wants no marking anywhere while no Scrape_Run has completed.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(de.postings.badges.isNew)).toBeNull();
  });
});
