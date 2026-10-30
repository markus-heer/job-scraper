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

import type { EffectiveSearchProfile, EmploymentType } from '@job-scraper/domain';

import { criterionValue, requiredCriterionValue } from '../search-criteria.js';

/** The origin every Stepstone request goes to. The `www` host is the one robots.txt is read from. */
export const STEPSTONE_ORIGIN = 'https://www.stepstone.de';

/** The path prefix of a Stepstone result list. */
const RESULT_LIST_PATH = '/jobs';

/** The place segment prefix: `/in-muenchen`. */
const LOCATION_PREFIX = 'in-';

/**
 * What `https://www.stepstone.de/robots.txt` says, and why this builder no longer follows it.
 *
 * Measured on 2026-10-29 against the live body (HTTP 200, 3250 bytes, header
 * `last updated 06 08 26 JM`, no `Crawl-delay`) with the same `robots-parser` the Job_Tool uses. The
 * stored copy is `__fixtures__/robots.txt` with a `.capture.json` sidecar. Three lines decide what
 * that file permits:
 *
 * ```text
 * Disallow: /jobs/*?*        forbids ?page=2 and ?radius=30
 * Allow:    /jobs/*?q=*      permits ?q=<terms> as the only parameter
 * Disallow: /jobs/*?q*&*     forbids ?q=…&page=2 and every further parameter beside q
 * ```
 *
 * | Intended path                                            | robots.txt |
 * | -------------------------------------------------------- | ---------- |
 * | `/jobs/projektmanagerin/in-muenchen`                     | allowed    |
 * | `/jobs/projektmanagerin/in-muenchen?q="…"`               | allowed    |
 * | `/jobs/projektmanagerin/in-muenchen?q="…"&radius=30&…`   | disallowed |
 * | `/jobs/projektmanagerin/in-muenchen?page=2`              | disallowed |
 * | `/jobs/projektmanagerin/in-muenchen?q="…"&page=2`        | disallowed |
 *
 * So by that file, Stepstone permits its result list with **exactly one** query parameter and
 * forbids every pagination shape. This builder briefly obeyed that: one parameter, one Result_Page,
 * and three Criterion_Field removed from the capability declaration.
 *
 * **It does not any more, and that is a configured decision rather than an oversight.** The
 * Robots_Policy of 14.10 is set to `ignore` on this machine, because the single user starts each
 * Scrape_Run by hand at the keyboard and takes the view that a retrieval they trigger themselves is
 * not the autonomous crawler the robots exclusion convention addresses. The evaluation above still
 * runs on every Scrape_Run and is reported as a warning per Platform in the Log_View (14.12), so the
 * decision is visible rather than silent, and a stated `Crawl-delay` is still applied (14.4).
 *
 * Two things that follow, and one that does not:
 *
 * - **The full filter set reaches the query again** — `q`, `radius`, `ag` and `ct` — so the retrieved
 *   list is the one the Search_Profile asks for instead of a nationwide, unfiltered one.
 * - **Pagination works**, bounded only by the Page_Safety_Limit of 13.10, so the result list is read
 *   to its end (13.3).
 * - **The terms of use are a separate document and are not settled by any of this.**
 *   `docs/adapters/stepstone.md` records that they are still unread.
 *
 * Setting `ROBOTS_POLICY=respect` makes the gate of 14.2 exclude this Platform again, which is the
 * one-line way back. The parameter names below are what that change would narrow, never the
 * capability declaration.
 *
 * Requirements: 13.3, 13.10, 14.1, 14.4, 14.10, 14.11, 14.12.
 */
export const STEPSTONE_ROBOTS_NOTE =
  'Evaluated and reported per Scrape_Run; gating depends on ROBOTS_POLICY (14.10).';

/** The query parameter names, in the order they are appended, so one profile yields one URL. */
const QUERY_PARAMS = {
  /** Keyword query; carries the title synonyms as an OR expression. */
  keywords: 'q',
  /** Search radius around the place of the path, in kilometres. */
  radius: 'radius',
  /** Posting age bucket, as `age_<days>`. */
  age: 'ag',
  /** Contract type. */
  contractType: 'ct',
  /** 1-based Result_Page number. */
  page: 'page',
} as const;

/**
 * The radius values Stepstone's radius selector offers, in kilometres, ascending.
 *
 * A Search_Profile may name any integer from 1 to 200 (3.5), so a value between two steps is raised to
 * the next larger step rather than lowered: a smaller radius would drop Job_Posting the user asked for,
 * while a larger one only adds postings further away, which the Commute_Service then rates (8.1).
 */
export const STEPSTONE_RADIUS_STEPS_KM = [0, 5, 10, 20, 30, 50, 100] as const;

/**
 * The posting-age buckets Stepstone's date filter offers, in days, ascending.
 *
 * Same direction of rounding and the same reason: `publicationPeriodDays` of 10 becomes the 14-day
 * bucket, which includes everything from the last 10 days. A period above the largest bucket drops the
 * filter entirely, since "older than 30 days as well" is what no filter means.
 */
export const STEPSTONE_AGE_BUCKETS_DAYS = [1, 3, 7, 14, 30] as const;

/**
 * How an {@link EmploymentType} reaches Stepstone's contract-type filter.
 *
 * `ANY` maps to `null`, which omits the parameter: asking for every contract type *is* the unfiltered
 * result list, and sending a value for it would risk excluding postings that state no contract type.
 */
export const STEPSTONE_CONTRACT_TYPES: Readonly<Record<EmploymentType, string | null>> = {
  PERMANENT: 'permanent',
  TEMPORARY: 'temporary',
  CONTRACT: 'contract',
  ANY: null,
};

/** The value of `value` raised to the smallest entry of `steps` that is at least as large. */
function raiseToStep(value: number, steps: readonly number[]): number | null {
  const step = steps.find((candidate) => candidate >= value);

  return step ?? null;
}

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
  const searchRadiusKm = criterionValue(profile, 'searchRadiusKm');
  const employmentType = criterionValue(profile, 'employmentType');
  const publicationPeriodDays = criterionValue(profile, 'publicationPeriodDays');

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

  if (titleSynonyms !== undefined && titleSynonyms.length > 0) {
    url.searchParams.set(QUERY_PARAMS.keywords, stepstoneKeywordQuery(jobTitle, titleSynonyms));
  }

  if (searchRadiusKm !== undefined) {
    const step = raiseToStep(searchRadiusKm, STEPSTONE_RADIUS_STEPS_KM);

    // A radius above the largest step is left out rather than capped: capping would quietly search a
    // smaller area than the Search_Profile asks for, while no radius parameter searches nationwide,
    // which is the closer reading of "200 km around Munich" on a German-only job board.
    if (step !== null) {
      url.searchParams.set(QUERY_PARAMS.radius, String(step));
    }
  }

  if (publicationPeriodDays !== undefined) {
    const bucket = raiseToStep(publicationPeriodDays, STEPSTONE_AGE_BUCKETS_DAYS);

    if (bucket !== null) {
      url.searchParams.set(QUERY_PARAMS.age, `age_${String(bucket)}`);
    }
  }

  if (employmentType !== undefined) {
    const contractType = STEPSTONE_CONTRACT_TYPES[employmentType];

    if (contractType !== null) {
      url.searchParams.set(QUERY_PARAMS.contractType, contractType);
    }
  }

  if (pageNumber > 1) {
    url.searchParams.set(QUERY_PARAMS.page, String(pageNumber));
  }

  return url.toString();
}
