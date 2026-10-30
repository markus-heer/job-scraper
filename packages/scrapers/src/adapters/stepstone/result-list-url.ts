/**
 * The Stepstone Result_Page URL, built from the effective Search_Profile (6.2, 14.1, 14.7).
 *
 * Stepstone states its publicly reachable result list as a keyword-and-place path with the filters in
 * the query string:
 *
 * ```text
 * https://www.stepstone.de/jobs/projektmanagerin/in-muenchen?radius=30&ag=age_30&ct=permanent&page=2
 * ```
 *
 * Everything the Platform can express is declared in `PLATFORM_CAPABILITIES.STEPSTONE`, and every one
 * of those six Criterion_Field is mapped here — a supported field that silently never reached the query
 * would make the read-only criteria view of 4.11 claim a filter the retrieval never applied.
 *
 * ## Status of the parameter names
 *
 * The path shape, `radius` and `page` are the stable, user-visible part of a Stepstone search URL. The
 * three filter parameters (`ag`, `ct`, and `q` for the synonyms) and the radius step list are read from
 * Stepstone's own search UI and are *provisional until the fixture capture of task 9.2 confirms them
 * against a real response*. They are collected in the four tables below so that a correction is one
 * edit in one file, and `docs/adapters/stepstone.md` (task 9.4) records the URL that was actually
 * retrieved.
 *
 * A wrong filter parameter degrades gracefully: Stepstone ignores a query parameter it does not know,
 * so the retrieval still reads a result list, only a wider one than the Search_Profile asked for. A
 * wrong *path* would not degrade, which is why the path carries nothing but the two mandatory fields.
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';

import { criterionValue, requiredCriterionValue } from '../search-criteria.js';

/** The origin every Stepstone request goes to. The `www` host is the one robots.txt is read from. */
export const STEPSTONE_ORIGIN = 'https://www.stepstone.de';

/** The path prefix of a Stepstone result list. */
const RESULT_LIST_PATH = '/jobs';

/** The place segment prefix: `/in-muenchen`. */
const LOCATION_PREFIX = 'in-';

/**
 * The Result_Page one Stepstone retrieval reads: **one**, far below the Page_Safety_Limit of 13.10.
 *
 * `https://www.stepstone.de/robots.txt` permits this result list and permits exactly one query
 * parameter on it. Measured on 2026-10-29 against the live body (HTTP 200, 3250 bytes, header
 * `last updated 06 08 26 JM`, no `Crawl-delay`) with the same `robots-parser` the Job_Tool uses:
 *
 * ```text
 * Disallow: /jobs/*?*        forbids ?page=2 and ?radius=30
 * Allow:    /jobs/*?q=*      permits ?q=<terms> as the only parameter
 * Disallow: /jobs/*?q*&*     forbids ?q=…&page=2 and every further parameter beside q
 * ```
 *
 * | Intended path                                            | Decision   |
 * | -------------------------------------------------------- | ---------- |
 * | `/jobs/projektmanagerin/in-muenchen`                     | allowed    |
 * | `/jobs/projektmanagerin/in-muenchen?q="…"`               | allowed    |
 * | `/jobs/projektmanagerin/in-muenchen?q="…"&radius=30&…`   | disallowed |
 * | `/jobs/projektmanagerin/in-muenchen?page=2`              | disallowed |
 * | `/jobs/projektmanagerin/in-muenchen?q="…"&page=2`        | disallowed |
 *
 * So **no pagination shape of this Platform has a permitted address**, and this cap is 13.13: the
 * retrieval ends after the last permitted Result_Page rather than requesting one the robots.txt
 * forbids, and rather than being excluded in full for paths it never intended to request.
 *
 * Until this constant existed the builder emitted four parameters — `q`, `radius`, `ag` and `ct` —
 * and every Stepstone retrieval therefore ended with Platform_Status `EXCLUDED_BY_ROBOTS_TXT` having
 * fetched nothing. That told the single non-technical user "Stepstone excludes this tool" for a URL
 * the Job_Tool had chosen itself. The parameters are gone, with the consequence stated rather than
 * hidden: `searchRadiusKm`, `employmentType` and `publicationPeriodDays` left
 * `PLATFORM_CAPABILITIES.STEPSTONE.supportedFields` in the same change, because rule 2 of the
 * capability conventions requires every declared Criterion_Field to actually reach the URL. All
 * three widen the result list rather than narrowing it; the Commute_Service rates the work locations
 * afterwards (8.1) and the Relevance_Service judges the fit (15.2).
 *
 * **What was considered and rejected:** putting `q` last, renaming the filter parameters, or encoding
 * them into the path, so as to produce a URL the rules do not literally name. All three request
 * exactly what `Disallow: /jobs/*?q*&*` exists to prevent. Ordering parameters to evade a rule is
 * circumventing the robots.txt, not obeying it — the same reasoning the Indeed builder records for
 * `Disallow: /*&start=`.
 *
 * **What would legitimately retrieve more:** several permitted entry points. Each distinct
 * `/jobs/<title-slug>/in-<location-slug>` is its own allowed path, so one path per title synonym
 * covers more of the result list than one path with the synonyms folded into `q` — that is the option
 * 13.14 opens and it needs a capture to decide, see `docs/adapters/stepstone.md`.
 *
 * Requirements: 13.3, 13.10, 13.13, 14.1, 14.2.
 */
export const STEPSTONE_RESULT_PAGE_LIMIT = 1;

/**
 * The query parameter names. Exactly one, and `q` is the one the robots.txt of this Platform allows;
 * see {@link STEPSTONE_RESULT_PAGE_LIMIT} for the measurement and for what the others cost.
 */
const QUERY_PARAMS = {
  /** Keyword query; carries the title synonyms as an OR expression. The only permitted parameter. */
  keywords: 'q',
} as const;

/** German umlauts and the sharp s, which Stepstone's own slugs transliterate rather than strip. */
const TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/gu, 'ae'],
  [/ö/gu, 'oe'],
  [/ü/gu, 'ue'],
  [/ß/gu, 'ss'],
];

/** Everything that is not an ASCII letter or digit, which becomes a single hyphen. */
const NON_SLUG_CHARS = /[^a-z0-9]+/gu;

/** Leading and trailing hyphens left over after the replacement above. */
const EDGE_HYPHENS = /^-+|-+$/gu;

/**
 * The path form of a criterion value: `"München"` becomes `muenchen`, `"Projekt­managerin (m/w/d)"`
 * becomes `projekt-managerin-m-w-d`.
 *
 * Lowercased, umlauts transliterated, remaining diacritics decomposed and dropped, everything else
 * collapsed into single hyphens. Transliteration runs before the decomposition on purpose: `ü` has to
 * become `ue` rather than `u`, which is how German slugs read and how Stepstone writes them.
 */
export function stepstoneSlug(value: string): string {
  const transliterated = TRANSLITERATIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value.toLowerCase(),
  );

  return (
    transliterated
      .normalize('NFD')
      // Combining marks of the decomposition: `é` is now `e` plus U+0301, and only the `e` is wanted.
      .replace(/\p{Mn}+/gu, '')
      .replace(NON_SLUG_CHARS, '-')
      .replace(EDGE_HYPHENS, '')
  );
}

/**
 * The keyword query for a job title and its synonyms.
 *
 * Each term is quoted and the terms are joined with `OR`, which is the boolean syntax Stepstone's
 * keyword field accepts: without the quotes a two-word synonym such as `Project Manager` would be read
 * as two independent terms. The job title comes first and duplicates are dropped, so a synonym list
 * that repeats the title does not produce the term twice.
 */
export function stepstoneKeywordQuery(
  jobTitle: string,
  titleSynonyms: readonly string[] = [],
): string {
  const seen = new Set<string>();
  const terms = [jobTitle, ...titleSynonyms]
    .map((term) => term.trim())
    .filter((term) => {
      const key = term.toLowerCase();

      if (term.length === 0 || seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });

  return terms.map((term) => `"${term}"`).join(' OR ');
}

/**
 * The URL of one Stepstone Result_Page.
 *
 * Deterministic in its inputs: the same effective Search_Profile and the same page number always yield
 * the same string, including the order of the query parameters. That is what lets the robots.txt
 * evaluation of 14.1 run against `resultListUrl(profile, 1)` and lets a fixture test compare URLs.
 *
 * `page` is omitted for the first Result_Page, because that URL is the result list entry point: it is
 * the address a person opens, the one the robots.txt decision is made for and the one
 * `docs/adapters/stepstone.md` documents (14.7).
 *
 * @param profile The effective Search_Profile of Stepstone.
 * @param pageNumber The 1-based Result_Page number.
 * @throws A `RangeError` for a page number that is not a positive integer, and for a Search_Profile
 *   without the two mandatory Criterion_Field of Stepstone (see {@link requiredCriterionValue}).
 */
export function stepstoneResultListUrl(
  profile: EffectiveSearchProfile,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(
      `A Result_Page number must be a positive integer, received ${String(pageNumber)}.`,
    );
  }

  const jobTitle = requiredCriterionValue(profile, 'jobTitle');
  const searchLocation = requiredCriterionValue(profile, 'searchLocation');
  const titleSynonyms = criterionValue(profile, 'titleSynonyms');

  const titleSlug = stepstoneSlug(jobTitle);
  const locationSlug = stepstoneSlug(searchLocation);

  if (titleSlug.length === 0 || locationSlug.length === 0) {
    throw new RangeError(
      `The job title "${jobTitle}" and the search location "${searchLocation}" must contain at least one letter or digit each to form a Stepstone result list path.`,
    );
  }

  const url = new URL(
    `${RESULT_LIST_PATH}/${titleSlug}/${LOCATION_PREFIX}${locationSlug}`,
    STEPSTONE_ORIGIN,
  );

  // `q` only, and only where it adds something: a `q` repeating the path's title slug states nothing
  // the path does not already carry, and the bare path is the shape with the widest permission.
  // `pageNumber` reaches no parameter at all — see {@link STEPSTONE_RESULT_PAGE_LIMIT} — so every
  // page number yields the same permitted URL and the adapter requests it exactly once.
  if (titleSynonyms !== undefined && titleSynonyms.length > 0) {
    url.searchParams.set(QUERY_PARAMS.keywords, stepstoneKeywordQuery(jobTitle, titleSynonyms));
  }

  return url.toString();
}
