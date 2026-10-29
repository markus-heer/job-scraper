/**
 * The Jobvector Result_Page URL, built from the effective Search_Profile (6.2, 14.1, 14.7).
 *
 * Jobvector states its publicly reachable result list as a query over the `/jobs/` path:
 *
 * ```text
 * https://www.jobvector.de/jobs/?keyword=%22Projektmanagerin%22&industry=Pharma&location=M%C3%BCnchen&radius=50&page=2
 * ```
 *
 * Everything the Platform can express is declared in `PLATFORM_CAPABILITIES.JOBVECTOR`, and every one
 * of those five Criterion_Field is mapped here — a supported field that silently never reached the
 * query would make the read-only criteria view of 4.11 claim a filter the retrieval never applied.
 *
 * Two differences to the Stepstone adapter, both of them consequences of the capability declaration:
 *
 * - **`industry` is supported here** and therefore reaches the query. Stepstone declares no industry
 *   filter, so its URL builder has none.
 * - **`jobTitle` is the only mandatory field.** `searchLocation` is optional for Jobvector, which is
 *   why *every* criterion travels in the query string and nothing is put into the path: a path segment
 *   built from an optional field would either break or need a placeholder when the Search_Profile
 *   omits it. `employmentType` and `publicationPeriodDays` are not supported and are not mapped.
 *
 * ## Status of the parameter names
 *
 * **Provisional.** The `/jobs/` path is the result list a person opens, but the five parameter names
 * below and the radius step list are read from Jobvector's own search UI and are *unconfirmed until the
 * fixture capture of task 10.2 compares them against a real response*. They are collected in the three
 * named tables below so that a correction is one edit in one file, and `docs/adapters/jobvector.md`
 * (task 10.4) records the URL that was actually retrieved.
 *
 * A wrong filter parameter degrades gracefully: Jobvector ignores a query parameter it does not know,
 * so the retrieval still reads a result list, only a wider one than the Search_Profile asked for.
 *
 * The one mapping that does *not* degrade gracefully is the keyword expression of
 * {@link jobvectorKeywordQuery}: a search engine that reads `OR` as a further literal keyword instead
 * of as an operator conjoins the terms and answers an almost empty result list, which 10.2 would show
 * as an unexpectedly empty page rather than as a wider one. Confirming or replacing it — the fallback
 * being the job title alone — is therefore the first thing the capture has to settle.
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';

import { criterionValue, requiredCriterionValue } from '../search-criteria.js';

/** The origin every Jobvector request goes to. The `www` host is the one robots.txt is read from. */
export const JOBVECTOR_ORIGIN = 'https://www.jobvector.de';

/** The path of the German Jobvector result list. */
const RESULT_LIST_PATH = '/jobs/';

/**
 * The radius values Jobvector's radius selector offers, in kilometres, ascending. Provisional.
 *
 * A Search_Profile may name any integer from 1 to 200 (3.5), so a value between two steps is raised to
 * the next larger step rather than lowered: a smaller radius would drop Job_Posting the user asked for,
 * while a larger one only adds postings further away, which the Commute_Service then rates (8.1).
 */
export const JOBVECTOR_RADIUS_STEPS_KM = [5, 10, 25, 50, 100, 200] as const;

/**
 * The query parameter names, in the order they are appended, so one profile yields one URL.
 * Provisional; see the file comment.
 */
const QUERY_PARAMS = {
  /** Free-text keyword query; carries the job title and its synonyms. */
  keyword: 'keyword',
  /** The industry filter, which Jobvector supports and Stepstone does not (4.2). */
  industry: 'industry',
  /** The place the radius is measured around. */
  location: 'location',
  /** Search radius around {@link QUERY_PARAMS.location}, in kilometres. */
  radius: 'radius',
  /** 1-based Result_Page number. */
  page: 'page',
} as const;

/** Every run of whitespace in a criterion value, which becomes a single space in the query. */
const WHITESPACE_RUN = /\s+/gu;

/** A criterion value as it reaches the query string: trimmed, with inner whitespace collapsed. */
function queryValue(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').trim();
}

/** The value of `value` raised to the smallest entry of `steps` that is at least as large. */
function raiseToStep(value: number, steps: readonly number[]): number | null {
  const step = steps.find((candidate) => candidate >= value);

  return step ?? null;
}

/**
 * The keyword query for a job title and its synonyms.
 *
 * Each term is quoted and the terms are joined with `OR`: without the quotes a two-word synonym such
 * as `Project Manager` would be read as two independent terms. The job title comes first and
 * duplicates are dropped, so a synonym list that repeats the title does not produce the term twice.
 *
 * Provisional in the same sense as the parameter names, and with the sharper consequence described in
 * the file comment.
 */
export function jobvectorKeywordQuery(
  jobTitle: string,
  titleSynonyms: readonly string[] = [],
): string {
  const seen = new Set<string>();
  const terms = [jobTitle, ...titleSynonyms]
    .map((term) => queryValue(term))
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
 * The URL of one Jobvector Result_Page.
 *
 * Deterministic in its inputs: the same effective Search_Profile and the same page number always yield
 * the same string, including the order of the query parameters. That is what lets the robots.txt
 * evaluation of 14.1 run against `resultListUrl(profile, 1)` and lets a fixture test compare URLs.
 *
 * `page` is omitted for the first Result_Page, because that URL is the result list entry point: it is
 * the address a person opens, the one the robots.txt decision is made for and the one
 * `docs/adapters/jobvector.md` documents (14.7).
 *
 * @param profile The effective Search_Profile of Jobvector.
 * @param pageNumber The 1-based Result_Page number.
 * @throws A `RangeError` for a page number that is not a positive integer, and for a Search_Profile
 *   without the one mandatory Criterion_Field of Jobvector (see {@link requiredCriterionValue}).
 */
export function jobvectorResultListUrl(
  profile: EffectiveSearchProfile,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(
      `A Result_Page number must be a positive integer, received ${String(pageNumber)}.`,
    );
  }

  const jobTitle = requiredCriterionValue(profile, 'jobTitle');
  const titleSynonyms = criterionValue(profile, 'titleSynonyms');
  const industry = criterionValue(profile, 'industry');
  const searchLocation = criterionValue(profile, 'searchLocation');
  const searchRadiusKm = criterionValue(profile, 'searchRadiusKm');

  const url = new URL(RESULT_LIST_PATH, JOBVECTOR_ORIGIN);

  url.searchParams.set(QUERY_PARAMS.keyword, jobvectorKeywordQuery(jobTitle, titleSynonyms));

  if (industry !== undefined && queryValue(industry).length > 0) {
    url.searchParams.set(QUERY_PARAMS.industry, queryValue(industry));
  }

  // The radius has no meaning without a place to measure it around, so it travels only together with
  // the search location. On its own it would be a filter the criteria view claims but that the
  // Platform cannot apply.
  if (searchLocation !== undefined && queryValue(searchLocation).length > 0) {
    url.searchParams.set(QUERY_PARAMS.location, queryValue(searchLocation));

    if (searchRadiusKm !== undefined) {
      const step = raiseToStep(searchRadiusKm, JOBVECTOR_RADIUS_STEPS_KM);

      // A radius above the largest step is left out rather than capped: capping would quietly search a
      // smaller area than the Search_Profile asks for, while no radius parameter searches the whole
      // country, which is the closer reading of a radius larger than the selector offers.
      if (step !== null) {
        url.searchParams.set(QUERY_PARAMS.radius, String(step));
      }
    }
  }

  if (pageNumber > 1) {
    url.searchParams.set(QUERY_PARAMS.page, String(pageNumber));
  }

  return url.toString();
}
