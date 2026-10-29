/**
 * Unit tests for the rule-based work location parse of 8.5 and 8.6.
 *
 * The happy paths are taken from the Platform_Adapter fixtures, so what is asserted here is what
 * the Platform actually write: "München", "München, Garching", "Martinsried bei München",
 * "München (hybrid)". The rejections are the other half, and the reason code matters more than the
 * `null`: it is what decides whether the Commute_Service may spend an AI_Provider call on the value
 * (8.6, `UNRECOGNIZED`) or whether the value has said all it is going to say (8.5, the other three).
 *
 * The invariant that `reason` is present exactly when `placeName` is `null` is asserted over every
 * case in this file rather than per case, because it is what lets task 13.4 branch on one of the
 * two fields alone.
 *
 * Requirements: 8.5, 8.6.
 */

import { describe, expect, it } from 'vitest';

import { parseWorkLocation, type WorkLocationRejection } from '../parse-work-location';

/** Every value this file parses, so the shape invariant can be checked over all of them. */
const ALL_INPUTS: readonly (string | null)[] = [
  null,
  '',
  '   ',
  '-',
  'München',
  'München, Garching',
  'Martinsried bei München',
  'München (hybrid)',
  'Remote (München)',
  'Deutschland',
  'Remote',
  'bundesweit',
  'n/a',
  'Wir suchen für unseren Kunden in der Region einen Spezialisten',
];

describe('parseWorkLocation', () => {
  describe('a value the geocoder can be asked about (8.5)', () => {
    it('passes a municipality through unchanged', () => {
      expect(parseWorkLocation('München')).toEqual({ placeName: 'München' });
    });

    it('keeps the postal code, which is what makes a hit exact rather than a centroid', () => {
      expect(parseWorkLocation('80689 München').placeName).toBe('80689 München');
    });

    it('accepts a bare postal code, which names a place without a letter', () => {
      expect(parseWorkLocation('80689').placeName).toBe('80689');
    });

    it('takes the first of several locations, in written order', () => {
      expect(parseWorkLocation('München, Garching').placeName).toBe('München');
      expect(parseWorkLocation('Berlin / Hamburg / München').placeName).toBe('Berlin');
      expect(parseWorkLocation('Augsburg und Ulm').placeName).toBe('Augsburg');
    });

    it('drops the country segment behind the place', () => {
      expect(parseWorkLocation('München, Deutschland').placeName).toBe('München');
    });

    it('reads "X bei Y" as X, which is the name the geocoder matches', () => {
      expect(parseWorkLocation('Martinsried bei München').placeName).toBe('Martinsried');
      expect(parseWorkLocation('Garching nahe München').placeName).toBe('Garching');
    });

    it('drops a work arrangement in brackets', () => {
      expect(parseWorkLocation('München (hybrid)').placeName).toBe('München');
      expect(parseWorkLocation('Nürnberg (Remote möglich)').placeName).toBe('Nürnberg');
    });

    it('uses the bracketed place when the text outside the brackets names none', () => {
      expect(parseWorkLocation('Remote (München)').placeName).toBe('München');
      expect(parseWorkLocation('(München)').placeName).toBe('München');
    });

    it('drops a work arrangement stated in front of the place', () => {
      expect(parseWorkLocation('Remote in München').placeName).toBe('München');
      expect(parseWorkLocation('Homeoffice in Augsburg').placeName).toBe('Augsburg');
    });

    it('drops a label prefix, surrounding quotes and stray punctuation', () => {
      expect(parseWorkLocation('Standort: München').placeName).toBe('München');
      expect(parseWorkLocation('Arbeitsort: Regensburg,').placeName).toBe('Regensburg');
      expect(parseWorkLocation('"München"').placeName).toBe('München');
    });

    it('collapses the whitespace the Platform emit, non-breaking spaces included', () => {
      expect(parseWorkLocation('\u00a0 München \n ').placeName).toBe('München');
      expect(parseWorkLocation('Frankfurt  am   Main').placeName).toBe('Frankfurt am Main');
    });

    it('keeps a long German place name', () => {
      expect(parseWorkLocation('Neustadt an der Weinstraße').placeName).toBe(
        'Neustadt an der Weinstraße',
      );
    });

    it('keeps a hyphenated place name rather than splitting it', () => {
      expect(parseWorkLocation('Baden-Baden').placeName).toBe('Baden-Baden');
      expect(parseWorkLocation('Garmisch-Partenkirchen').placeName).toBe('Garmisch-Partenkirchen');
    });

    it('passes a region on to the geocoder, which is the component that rejects it', () => {
      // 8.5 rejects what carries no place reference *below* country level. A federal state is one,
      // so the decision belongs to `RoutingProvider.geocode`, not here.
      expect(parseWorkLocation('Bayern').placeName).toBe('Bayern');
    });
  });

  describe('no value at all (8.5)', () => {
    it.each([
      ['null', null],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['a placeholder dash', '-'],
      ['a non-breaking space', '\u00a0'],
    ])('reports ABSENT for %s', (_label, raw) => {
      expect(parseWorkLocation(raw)).toEqual({ placeName: null, reason: 'ABSENT' });
    });
  });

  describe('a value that states an arrangement instead of a place (8.5)', () => {
    it.each([
      'Remote',
      '100% Remote',
      'remote!',
      'Home-Office',
      'Homeoffice',
      'Mobiles Arbeiten',
      'hybrid',
      'bundesweit',
      'deutschlandweit',
      'weltweit',
      'Mehrere Standorte',
      'keine Angabe',
      'Nach Vereinbarung',
    ])('reports PLACE_INDEPENDENT for %s', (raw) => {
      expect(parseWorkLocation(raw)).toEqual({
        placeName: null,
        reason: 'PLACE_INDEPENDENT',
      });
    });

    it('outranks a country name, because it is the more specific statement', () => {
      expect(parseWorkLocation('Remote (Deutschland)').reason).toBe('PLACE_INDEPENDENT');
    });
  });

  describe('a value no finer than a country (8.5)', () => {
    it.each(['Deutschland', 'deutschland', 'Germany', 'DE', 'Österreich', 'Europa', 'EU'])(
      'reports COUNTRY_ONLY for %s',
      (raw) => {
        expect(parseWorkLocation(raw)).toEqual({ placeName: null, reason: 'COUNTRY_ONLY' });
      },
    );

    it('reports COUNTRY_ONLY for a list of countries', () => {
      expect(parseWorkLocation('Deutschland, Österreich, Schweiz').reason).toBe('COUNTRY_ONLY');
    });
  });

  describe('a value the rules could not read (8.6)', () => {
    it('reports UNRECOGNIZED for prose, which is where the AI_Provider can help', () => {
      expect(
        parseWorkLocation('Wir suchen für unseren Kunden in der Region einen Spezialisten'),
      ).toEqual({ placeName: null, reason: 'UNRECOGNIZED' });
    });

    it('reports UNRECOGNIZED for a value whose segments are single letters', () => {
      expect(parseWorkLocation('n/a').reason).toBe('UNRECOGNIZED');
    });
  });

  describe('the shape of the answer', () => {
    it('sets a reason exactly when no place name was found', () => {
      const mismatches = ALL_INPUTS.filter((raw) => {
        const { placeName, reason } = parseWorkLocation(raw);

        return (placeName === null) !== (reason !== undefined);
      });

      expect(mismatches).toEqual([]);
    });

    it('answers with one of the four known reasons', () => {
      const known: readonly WorkLocationRejection[] = [
        'ABSENT',
        'PLACE_INDEPENDENT',
        'COUNTRY_ONLY',
        'UNRECOGNIZED',
      ];
      const reasons = ALL_INPUTS.map((raw) => parseWorkLocation(raw).reason).filter(
        (reason) => reason !== undefined,
      );

      expect(reasons.every((reason) => known.includes(reason))).toBe(true);
    });

    it('never answers with an empty or padded place name', () => {
      const offenders = ALL_INPUTS.map((raw) => parseWorkLocation(raw).placeName).filter(
        (placeName) => placeName !== null && placeName !== placeName.trim(),
      );

      expect(offenders).toEqual([]);
    });
  });
});
