/**
 * The content hash gate of the Relevance_Service: stable under irrelevant re-formatting on the
 * Platform (15.5, no paid re-assessment), sensitive to a changed title or description text (15.6).
 */

import { describe, expect, it } from 'vitest';

import { computeContentHash } from '../src/hash/content-hash.js';

const TITLE = 'Projektmanagerin Pharma (m/w/d)';
const DESCRIPTION =
  'Wir suchen eine Projektmanagerin für die Steuerung klinischer Studien in München.';

describe('computeContentHash', () => {
  it('returns a lowercase 64-character hex digest', () => {
    expect(computeContentHash(TITLE, DESCRIPTION)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is deterministic for the same content', () => {
    expect(computeContentHash(TITLE, DESCRIPTION)).toBe(computeContentHash(TITLE, DESCRIPTION));
  });

  // --- Stability: re-formatting the same text must not trigger a re-assessment (15.5) ---

  it('ignores a whitespace reflow of the description text', () => {
    const reflowed = DESCRIPTION.replace(/ /gu, '\n   ');

    expect(computeContentHash(TITLE, reflowed)).toBe(computeContentHash(TITLE, DESCRIPTION));
  });

  it('ignores collapsed runs of spaces, tabs and non-breaking line breaks in the title', () => {
    expect(computeContentHash('Projektmanagerin \t\r\n  Pharma', DESCRIPTION)).toBe(
      computeContentHash('Projektmanagerin Pharma', DESCRIPTION),
    );
  });

  it('ignores leading and trailing whitespace on both parts', () => {
    expect(computeContentHash(`\n  ${TITLE}  `, `\t${DESCRIPTION}\n`)).toBe(
      computeContentHash(TITLE, DESCRIPTION),
    );
  });

  it('ignores a differing Unicode decomposition of the same characters', () => {
    const decomposed = 'Mu\u0308nchen'; // u + combining diaeresis
    const composed = 'M\u00fcnchen'; // precomposed ü

    expect(decomposed).not.toBe(composed);
    expect(computeContentHash(TITLE, decomposed)).toBe(computeContentHash(TITLE, composed));
  });

  it('treats an absent description text like an empty one', () => {
    expect(computeContentHash(TITLE, null)).toBe(computeContentHash(TITLE, '   '));
  });

  // --- Sensitivity: changed content must trigger exactly one re-assessment (15.6) ---

  it('changes when the title changes', () => {
    expect(computeContentHash('Projektleiterin Pharma (m/w/d)', DESCRIPTION)).not.toBe(
      computeContentHash(TITLE, DESCRIPTION),
    );
  });

  it('changes when a single character of the title changes', () => {
    expect(computeContentHash(`${TITLE}!`, DESCRIPTION)).not.toBe(
      computeContentHash(TITLE, DESCRIPTION),
    );
  });

  it('changes when the description text changes', () => {
    expect(computeContentHash(TITLE, `${DESCRIPTION} Homeoffice möglich.`)).not.toBe(
      computeContentHash(TITLE, DESCRIPTION),
    );
  });

  it('changes when a word moves across the title/description boundary', () => {
    expect(computeContentHash('Projektmanagerin', 'Pharma')).not.toBe(
      computeContentHash('Projektmanagerin Pharma', ''),
    );
  });

  it('changes when the description text is removed entirely', () => {
    expect(computeContentHash(TITLE, null)).not.toBe(computeContentHash(TITLE, DESCRIPTION));
  });
});
