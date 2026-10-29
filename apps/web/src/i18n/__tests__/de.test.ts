import {
  DEFAULT_SEARCH_PROFILE,
  INTEREST_FLAGS,
  PLATFORMS,
  POSTING_STATUSES,
  RELEVANCE_VERDICTS,
} from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { de } from '../de';

/**
 * Tests of the German string module (task 16.4).
 *
 * Three things are worth asserting about a module that is otherwise plain data, and they are the
 * three things a reviewer cannot check by reading a component:
 *
 * 1. the wordings the requirements spell out literally really are those wordings;
 * 2. the maps over the closed vocabularies cover every value, which the `satisfies` clauses already
 *    check at compile time — this is the runtime half, so a label removed behind a cast or an enum
 *    value added without a label fails a test as well as the build;
 * 3. no text the API_Service owns is restated here.
 *
 * The missing-translation guard task 16.6 asks for belongs to the component tests of the shell; this
 * file asserts the content of the module, not its use.
 *
 * Requirements: 2.1, 2.2, 2.8, 4.12, 8.3, 10.5, 10.12, 10.13, 11.2, 11.6, 12.6, 12.12, 15.15.
 */

/** Every string value in the module, with the dotted path it sits at. */
const stringEntries = (value: unknown, path: string): readonly [string, string][] => {
  if (typeof value === 'string') {
    return [[path, value]];
  }

  // An interpolating entry is a function; its result is covered by the assertions on the few
  // functions whose wording a requirement pins.
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    stringEntries(child, path === '' ? key : `${path}.${key}`),
  );
};

const allStrings = stringEntries(de, '');

describe('German string module', () => {
  it('holds no empty and no untrimmed string', () => {
    const offenders = allStrings.filter(([, text]) => text.trim() !== text || text === '');

    expect(offenders).toEqual([]);
  });

  it('names the four landing page functions as Requirement 2.2 spells them', () => {
    expect(de.landing.startRun).toBe('Suchlauf starten');
    expect(de.landing.viewPostings).toBe('Treffer ansehen');
    expect(de.landing.viewCriteria).toBe('Suchkriterien ansehen');
    expect(de.landing.openLog).toBe('Log öffnen');
  });

  it('carries the calls to action of the empty states and of the Log_Stream failure', () => {
    // 10.12, 10.13 and 12.12 pin these three captions literally.
    expect(de.postings.empty.storeAction).toBe('Suchlauf starten');
    expect(de.postings.empty.filterResultAction).toBe('Filter zurücksetzen');
    expect(de.log.connection.reconnectAction).toBe('Übertragung erneut verbinden');

    // 2.8: the hint names the result and points at the read-only criteria view.
    expect(de.postings.empty.runWithoutHitsHeading).toBe('Keine Treffer');
    expect(de.postings.empty.runWithoutHitsAction).toBe('Suchkriterien ansehen');

    // 11.6: a hint instead of the counters of 11.5.
    expect(de.postings.runSummary.noCompletedRun).toContain('noch kein Suchlauf abgeschlossen');
  });

  it('carries the marking and badge wordings the requirements pin', () => {
    expect(de.postings.badges.isNew).toBe('neu'); // 11.2
    expect(de.postings.badges.wellReachable).toBe('gut erreichbar'); // 8.3
    expect(de.postings.badges.verdictSetManually).toBe('manuell gesetzt'); // 15.15
    expect(de.log.cancelRun).toBe('Suchlauf abbrechen'); // 12.6
  });

  it('offers the three reachability values and both provenance labels', () => {
    // 10.5 names the three reachability options literally.
    expect(Object.values(de.filters.reachability.options)).toEqual([
      'gut erreichbar',
      'nicht gut erreichbar',
      'unbekannt',
    ]);

    // 4.12 names both provenance labels literally.
    expect(de.criteria.provenance.DEFAULT).toBe('aus Standardprofil');
    expect(de.criteria.provenance.OVERRIDE).toBe('überschrieben');
  });

  it('labels every value of every closed vocabulary it renders', () => {
    expect(Object.keys(de.vocabulary.platform)).toEqual([...PLATFORMS]);
    expect(Object.keys(de.vocabulary.postingStatus)).toEqual([...POSTING_STATUSES]);
    expect(Object.keys(de.vocabulary.interestFlag)).toEqual([...INTEREST_FLAGS]);
    expect(Object.keys(de.vocabulary.relevanceVerdict)).toEqual([...RELEVANCE_VERDICTS]);

    // Criterion_Field is `keyof SearchProfile`; the Default_Search_Profile is its runtime view.
    expect(Object.keys(de.vocabulary.criterionField).sort()).toEqual(
      Object.keys(DEFAULT_SEARCH_PROFILE).sort(),
    );
  });

  it('embeds numbers through functions rather than through format strings', () => {
    expect(de.pagination.position(2, 7)).toBe('Seite 2 von 7');
    expect(de.log.summary.runtimeValue(3, 9)).toBe('3 Min. 9 Sek.');
  });

  it('restates no German text the API_Service owns', () => {
    // Platform_Status and Run_Outcome labels stay in the API_Service, which is why there is no
    // namespace for either here; the run summary takes them from the response.
    expect(de.vocabulary).not.toHaveProperty('platformStatus');
    expect(de.vocabulary).not.toHaveProperty('runOutcome');

    // Wordings that arrive over the wire: the commute line (8.13), a Platform_Status label (7.4) and
    // the incompleteness hint of 7.4. None of them may exist as a value of this module.
    const ownedByTheApi = [
      'Erreichbarkeit unbekannt',
      'vollständig abgefragt',
      'Die Trefferliste ist unvollständig',
    ];
    const restated = allStrings.filter(([, text]) =>
      ownedByTheApi.some((owned) => text.includes(owned)),
    );

    expect(restated).toEqual([]);
  });
});
