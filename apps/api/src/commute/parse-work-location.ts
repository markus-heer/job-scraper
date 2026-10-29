/**
 * Rule-based extraction of a geocodable place name from a free-text work location (8.5, 8.6).
 *
 * This is the first step of the Commute_Service's attempt chain and the one that decides whether a
 * Job_Posting costs anything at all: a value this module resolves never reaches the AI_Provider
 * (8.6), and a value it rejects as place-independent never reaches the Routing_Provider either. The
 * Platform write the work location as display text, not as an address — the fixtures hold
 * "München", "München, Garching", "Martinsried bei München", "München (hybrid)" — so most values
 * are a place name wearing decoration, and stripping the decoration by rule is both cheaper and
 * more predictable than asking a model.
 *
 * ## What the function answers
 *
 * Exactly one of two things, with the invariant that `reason` is present if and only if `placeName`
 * is `null`:
 *
 * - a `placeName`: a candidate the geocoder can be asked about. Returned as written, because the
 *   geocoder wants the original spelling, diacritics and postal code included.
 * - a `reason`: *why* no candidate was found. The distinction is what the Commute_Service branches
 *   on, so it is a stable code rather than prose — see {@link WorkLocationRejection}. German
 *   wording for the user stays in `../common/error-mapping` (`commute.geocodeFailed`), which is
 *   where it already is; this module reports no prose.
 *
 * ## Where the line to geocoding runs
 *
 * 8.5 names the rejection criterion as "contains no place reference below country level", and that
 * is the whole of what is rejected here. A federal state or a region — "Bayern", "Oberbayern" — is
 * a place reference below country level and is therefore *passed on*; the Routing_Provider port
 * already promises `null` from `geocode` for a match no finer than a federal state, which is the
 * only place that distinction can be made reliably, because it depends on what the geocoder matched
 * rather than on what the string looks like. Keeping a list of 16 state names in two modules would
 * be two places to get it wrong.
 *
 * The same split applies to a municipality: "München" alone resolves here and is marked `IMPRECISE`
 * by the geocoder (8.12), not by this module.
 *
 * ## The rules, in order
 *
 * 1. Normalize whitespace (including non-breaking spaces), drop surrounding quotes and a label
 *    prefix such as "Standort:" or "Arbeitsort:".
 * 2. Separate the parenthesised parts from the rest. Both become candidate sources, the outer text
 *    first, which is what makes "München (hybrid)" resolve to "München" and "Remote (München)"
 *    resolve to "München" with the same rule.
 * 3. Split each part on the separators the Platform use for a list of locations — comma, slash,
 *    pipe, bullet, spaced dash, " und ", " bei ", " nahe " — and keep the segments in their written
 *    order. The first usable segment wins, because a Platform lists the primary location first and
 *    because 8.2 asks for one target coordinate per Job_Posting, not for the best of several.
 * 4. Take the first segment that is neither place-independent nor country-level and that reads like
 *    a place name. "Reads like a place name" is deliberately coarse — at least
 *    {@link MIN_PLACE_LETTERS} letters or a bare five-digit postal code, and at most
 *    {@link MAX_PLACE_WORDS} words — because the geocoder is the authority on whether a name
 *    exists, and the only job of the check is to keep a sentence of marketing prose from being sent
 *    to it as a query.
 *
 * Totality: every input returns a {@link WorkLocationParse} and nothing throws, so the attempt
 * chain of task 13.4 never has to guard this call.
 *
 * Requirements: 8.5, 8.6.
 */

/**
 * Why a work location carries no geocodable place name.
 *
 * The codes are English and stable because they are read by code and written to the Log_Stream as a
 * detail, never shown to the user. They differ in what the Commute_Service may do next:
 *
 * - `ABSENT` and `PLACE_INDEPENDENT` and `COUNTRY_ONLY` are the 8.5 case. The value states, as
 *   clearly as it can, that there is no place to route to; the Best_Commute_Time stays "unknown"
 *   and the determination is repeated only after the work location value itself has changed.
 * - `UNRECOGNIZED` is the 8.6 case: there is text, it may well name a place, and the rules here did
 *   not get it out. This is the one rejection where asking the AI_Provider for a normalization can
 *   change the outcome.
 *
 * Whether the AI_Provider is asked at all remains the Commute_Service's decision (8.6, 8.7); this
 * module only reports which of the two situations it found.
 */
export type WorkLocationRejection =
  'ABSENT' | 'PLACE_INDEPENDENT' | 'COUNTRY_ONLY' | 'UNRECOGNIZED';

/** The outcome of {@link parseWorkLocation}. `reason` is set exactly when `placeName` is `null`. */
export interface WorkLocationParse {
  /** A candidate for the geocoder, as written in the source value. */
  readonly placeName: string | null;
  /** Why no candidate was found. Absent on success. */
  readonly reason?: WorkLocationRejection;
}

/**
 * The most words a place name may have before the value is treated as prose.
 *
 * Five covers the long German forms — "Bad Neustadt an der Saale", "Neustadt an der Weinstraße" —
 * and excludes the sentence fragments that appear in a work location field when a Platform reuses
 * it for advertising text.
 */
const MAX_PLACE_WORDS = 5;

/**
 * The fewest letters a place name may have.
 *
 * Two, because "Au" and "Ay" are municipalities in Bavaria. One is never a place name and is what a
 * split value such as "n/a" leaves behind.
 */
const MIN_PLACE_LETTERS = 2;

/** A bare German postal code, which names a place without containing a letter. */
const POSTAL_CODE_ONLY = /^\d{5}$/u;

/** Every letter in any script, for counting them. */
const LETTERS = /\p{L}/gu;

/** Every run of whitespace, including the non-breaking spaces the Platform emit. */
const WHITESPACE_RUN = /\s+/gu;

/** A label the Platform put in front of the value: "Standort: München". */
const LABEL_PREFIX = /^(?:standort(?:e)?|(?:arbeits|einsatz|dienst)ort|ort|location)\s*:\s*/iu;

/**
 * The punctuation a segment may begin or end with and that is never part of a place name.
 *
 * Applied to the single segments rather than to the whole value, because the brackets have to still
 * be paired when {@link BRACKETED_PART} runs; a leading "(" stripped too early would turn
 * "(München)" into the unpaired "München)".
 */
const TRIM_CHARS = /^[\s"'`“„«»()[\]{}\-–—,.;:/|•·]+|[\s"'`”“»«()[\]{}\-–—,.;:/|•·]+$/gu;

/** A parenthesised or bracketed part: "München (hybrid)". The content is kept as a candidate. */
const BRACKETED_PART = /[([{]([^)\]}]*)[)\]}]?/gu;

/**
 * The separators between two locations in one value.
 *
 * " bei " and " nahe " are separators rather than part of the name on purpose: "Martinsried bei
 * München" geocodes as "Martinsried", while the full phrase is a sentence the geocoder has to guess
 * at. The spaced dash is matched with required spaces so that "Baden-Baden" survives.
 */
const SEGMENT_SEPARATOR =
  /\s*[,;/|•·]\s*|\s+-+\s+|\s+[–—]\s+|\s+(?:und|oder|sowie|bzw\.?|bei|nahe|&)\s+/giu;

/**
 * A work arrangement stated in front of the place: "Remote in München", "Homeoffice bei Augsburg".
 *
 * Dropped rather than treated as a separator, because the arrangement word is also a
 * place-independent marker on its own and would otherwise be the first segment and win.
 */
const ARRANGEMENT_PREFIX =
  /^(?:remote|hybrid|home[\s-]?office|mobiles arbeiten|telearbeit)\s+(?:in|aus|um|im|am)\s+/iu;

/**
 * Values that state a work arrangement or a refusal to name a place instead of a place (8.5).
 *
 * Matched against the comparison key of {@link comparisonKey}, so punctuation, casing and a
 * percentage in "100% remote" do not need their own entries.
 */
const PLACE_INDEPENDENT_VALUES: ReadonlySet<string> = new Set([
  'remote',
  'remote work',
  'remote only',
  'fully remote',
  'full remote',
  'voll remote',
  'vollremote',
  'anteilig remote',
  'teilweise remote',
  'home office',
  'homeoffice',
  'mobiles arbeiten',
  'mobile arbeit',
  'telearbeit',
  'hybrid',
  'hybrides arbeiten',
  'ortsunabhängig',
  'ortsunabhaengig',
  'ohne festen arbeitsort',
  'vor ort',
  'deutschlandweit',
  'bundesweit',
  'europaweit',
  'weltweit',
  'überregional',
  'ueberregional',
  'international',
  'global',
  'worldwide',
  'mehrere standorte',
  'verschiedene standorte',
  'diverse standorte',
  'an mehreren standorten',
  'nach vereinbarung',
  'standort nach vereinbarung',
  'flexibel',
  'keine angabe',
  'nicht angegeben',
  'unbekannt',
  'n a',
]);

/**
 * Values that name a country or something larger (8.5). The two-letter forms appear as country
 * codes in a work location field often enough to be worth listing.
 */
const COUNTRY_ONLY_VALUES: ReadonlySet<string> = new Set([
  'deutschland',
  'germany',
  'brd',
  'de',
  'd',
  'ger',
  'österreich',
  'oesterreich',
  'austria',
  'at',
  'schweiz',
  'switzerland',
  'suisse',
  'ch',
  'dach',
  'dach raum',
  'dachraum',
  'dach region',
  'dachregion',
  'europa',
  'europe',
  'eu',
  'emea',
]);

/**
 * Extracts a geocodable place name from a free-text work location (8.5, 8.6).
 *
 * @param raw The work location as the Platform showed it, or `null` where it showed none (8.5).
 * @returns A place name for the geocoder, or `null` with the reason no place name was found. Never
 *   throws.
 */
export const parseWorkLocation = (raw: string | null): WorkLocationParse => {
  if (raw === null) {
    return { placeName: null, reason: 'ABSENT' };
  }

  const normalized = normalize(raw);

  if (normalized === '') {
    return { placeName: null, reason: 'ABSENT' };
  }

  const candidates = candidateSegments(normalized);

  if (candidates.length === 0) {
    return { placeName: null, reason: 'ABSENT' };
  }

  return firstPlaceName(candidates);
};

/** Collapses whitespace and drops a label prefix. Punctuation is trimmed per segment, later. */
const normalize = (raw: string): string =>
  raw.replace(WHITESPACE_RUN, ' ').trim().replace(LABEL_PREFIX, '').trim();

/**
 * The candidates in the order they are tried: the text outside the brackets first, then what the
 * brackets held.
 */
const candidateSegments = (normalized: string): readonly string[] => {
  const bracketed: string[] = [];
  const outer = normalized
    .replace(BRACKETED_PART, (_match, content: string) => {
      bracketed.push(content);

      return ' ';
    })
    .replace(WHITESPACE_RUN, ' ')
    .trim();

  return [outer, ...bracketed].flatMap(splitSegments);
};

/** Splits one part on the location separators and trims each segment of its punctuation. */
const splitSegments = (part: string): readonly string[] =>
  part
    .split(SEGMENT_SEPARATOR)
    .map((segment) => segment.replace(TRIM_CHARS, '').replace(ARRANGEMENT_PREFIX, '').trim())
    .filter((segment) => segment !== '');

/**
 * Picks the first segment that can be geocoded, or reports why none can.
 *
 * The rejection reason is the most specific statement the value made, which is why a
 * place-independent marker outranks a country name: "Remote (Deutschland)" says more about why
 * there is no commute than its country does.
 */
const firstPlaceName = (candidates: readonly string[]): WorkLocationParse => {
  let placeIndependent = false;
  let countryOnly = false;

  for (const candidate of candidates) {
    const key = comparisonKey(candidate);

    if (PLACE_INDEPENDENT_VALUES.has(key)) {
      placeIndependent = true;
      continue;
    }

    if (COUNTRY_ONLY_VALUES.has(key)) {
      countryOnly = true;
      continue;
    }

    if (readsLikeAPlaceName(candidate)) {
      return { placeName: candidate };
    }
  }

  if (placeIndependent) {
    return { placeName: null, reason: 'PLACE_INDEPENDENT' };
  }

  return { placeName: null, reason: countryOnly ? 'COUNTRY_ONLY' : 'UNRECOGNIZED' };
};

/**
 * The form a candidate is compared against the two value lists in.
 *
 * Lowercased with every non-letter turned into a space, so "Home-Office", "100% Remote" and
 * "remote!" all reduce to a listed entry, while "München" keeps its diacritic — German place names
 * are compared against nothing here, so folding diacritics would only risk collisions.
 */
const comparisonKey = (candidate: string): string =>
  candidate
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, ' ')
    .trim();

/**
 * Whether a candidate is worth sending to the geocoder.
 *
 * Coarse by design: the geocoder decides whether a name exists, and this check only separates a
 * name-shaped value from prose and from a value that names nothing at all.
 */
const readsLikeAPlaceName = (candidate: string): boolean => {
  if (POSTAL_CODE_ONLY.test(candidate)) {
    return true;
  }

  const letters = candidate.match(LETTERS)?.length ?? 0;

  return letters >= MIN_PLACE_LETTERS && candidate.split(' ').length <= MAX_PLACE_WORDS;
};
