import { createHash } from 'node:crypto';

/**
 * Separator between the normalized title and the normalized description text.
 *
 * A NUL character cannot survive the normalization below, so it can never occur inside either part.
 * That is what prevents a shift of the title/description boundary — a word moved from the end of the
 * title to the start of the description — from producing the same hash.
 */
const PART_SEPARATOR = '\u0000';

/**
 * Brings one part into its canonical form: Unicode NFC, every whitespace run collapsed into a single
 * space, leading and trailing whitespace removed.
 *
 * NFC makes two visually identical strings with different Unicode decompositions hash alike, which
 * Platform markup produces often enough to matter. Collapsing whitespace keeps re-formatting of the
 * same text on the Platform from counting as changed content.
 */
function normalizePart(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * The content hash of a Job_Posting: SHA-256, hex encoded, over the normalized title and description
 * text joined by a NUL separator.
 *
 * The Relevance_Service decides re-assessment by comparing this hash instead of comparing fields
 * string by string, so irrelevant re-formatting on the Platform never triggers a paid re-assessment
 * (15.5), while a changed title or description text always does (15.6).
 *
 * @param title The title of the Job_Posting.
 * @param descriptionText The description text, or `null` when the Platform supplied none.
 * @returns The 64-character lowercase hex representation of the SHA-256 digest.
 */
export function computeContentHash(title: string, descriptionText: string | null): string {
  const payload = `${normalizePart(title)}${PART_SEPARATOR}${normalizePart(descriptionText ?? '')}`;

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
