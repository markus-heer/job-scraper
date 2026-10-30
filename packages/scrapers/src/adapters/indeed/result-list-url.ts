/**
 * The Indeed Result_Page URL, built from the effective Search_Profile (6.2, 14.1, 14.7).
 *
 * Indeed states its publicly reachable result list as a query over the `/jobs` path of its German
 * surface:
 *
 * ```text
 * https://de.indeed.com/jobs?q=%22Projektmanagerin%22&l=M%C3%BCnchen&fromage=30&jt=permanent
 * ```
 *
 * Everything the Platform can express is declared in `PLATFORM_CAPABILITIES.INDEED`, and every one of
 * those five Criterion_Field is mapped here — a supported field that silently never reached the query
 * would make the read-only criteria view of 4.11 claim a filter the retrieval never applied.
 *
 * | Criterion_Field         | Parameter  | Mapping                                                    |
 * | ----------------------- | ---------- | ---------------------------------------------------------- |
 * | `jobTitle` (mandatory)  | `q`        | first term of {@link indeedKeywordQuery}                    |
 * | `titleSynonyms`         | `q`        | further quoted terms of the same expression                 |
 * | `searchLocation` (mand.)| `l`        | the place, whitespace collapsed                             |
 * | `publicationPeriodDays` | `fromage`  | raised to {@link INDEED_AGE_BUCKETS_DAYS}                   |
 * | `employmentType`        | `jt`       | {@link INDEED_JOB_TYPES}; `ANY` omits the parameter          |
 *
 * `industry` and `searchRadiusKm` are the two Criterion_Field absent from that table, and they are
 * absent for different reasons: Indeed's result list has no industry filter at all, while the radius it
 * does offer is one its own robots.txt forbids an automated client to use. The next section is that
 * decision, because it is the one thing about this Platform that is not obvious from its surface.
 *
 * ## What `https://de.indeed.com/robots.txt` forbids, and what this builder does about it (14.1, 14.2)
 *
 * The `User-agent: *` group — the group that applies, because the Job_Tool identifies honestly as
 * `JobTool/0.1` (14.5) and matches none of the named bot groups — opens with `Allow: /` and then
 * excludes a long list of query shapes. Three of its lines decide this file:
 *
 * ```text
 * Disallow: /*radius=
 * Disallow: /*&start=
 * Disallow: /viewjob
 * ```
 *
 * | URL                                                          | Decision   | Deciding line         |
 * | ------------------------------------------------------------ | ---------- | --------------------- |
 * | `/jobs?q=…&l=München&fromage=30&jt=permanent`                  | allowed    | `Allow: /`            |
 * | the same plus `&page=2`                                       | allowed    | `Allow: /`            |
 * | the same plus `&radius=50`                                    | disallowed | `Disallow: /*radius=` |
 * | the same plus `&start=10`                                     | disallowed | `Disallow: /*&start=` |
 * | `/viewjob?jk=<job key>`                                        | disallowed | `Disallow: /viewjob`  |
 *
 * Until task 24.3 this builder emitted `radius` on **every** Result_Page and `start` on every page
 * after the first. `ScraperService` resolves all ten Result_Page URLs of a Platform before its first
 * page request and excludes the Platform if the robots.txt forbids *any* of them (14.2), so the Indeed
 * retrieval ended with Platform_Status `EXCLUDED_BY_ROBOTS_TXT` having fetched nothing — on the first
 * page, because of `radius`, and on the rest because of `start` as well.
 *
 * That was the robots.txt gate working correctly on a URL the Job_Tool had no business building. The
 * Platform does not forbid its result list; it forbids two parameters on it. Reporting
 * `EXCLUDED_BY_ROBOTS_TXT` would therefore have told the single non-technical user "Indeed excludes
 * this tool" ("durch robots.txt ausgeschlossen") for a decision the Job_Tool had made itself. **So both
 * parameters are gone**, with the two consequences spelled out rather than hidden:
 *
 * 1. **No search radius.** `searchRadiusKm` was removed from Indeed's `supportedFields` in
 *    `PLATFORM_CAPABILITIES` in the same change, because rule 2 of the capability conventions requires
 *    every declared Criterion_Field to actually reach the URL; a radius that is declared and silently
 *    dropped is exactly the claim 4.11 must not make. A bare `l=München` is whatever Indeed makes of a
 *    place without a radius, which is *wider* than the profile asks for rather than narrower — the same
 *    situation Glassdoor is in, where the Platform ignores `locKeyword` and `radius` and answers
 *    nationwide. The Commute_Service rates the work locations afterwards (8.1) and the
 *    Relevance_Service judges them (15.2), so the widening costs requests and assessments, not
 *    correctness.
 * 2. **One Result_Page per Scrape_Run.** `start` is Indeed's *only* pagination parameter, so with it
 *    forbidden there is no permitted way to ask for a second Result_Page. The retrieval is therefore
 *    capped at {@link INDEED_RESULT_PAGE_LIMIT} page, and the adapter reports `PAGE_LIMIT_REACHED`
 *    where the page it read offers a further one — the honest status, because the result list was not
 *    read to its end, and the one that makes the result a Partial_Result (7.7).
 *
 * **What was considered and rejected: putting `start` first in the query.** `Disallow: /*&start=`
 * matches only a `start=` preceded by an `&`, so `?start=10&q=…` would slip past the rule as written
 * while asking for exactly the deep pagination the rule exists to prevent — the sibling line
 * `Disallow: /*&serpstart=` shows the Platform enumerating the same shape for its other offset
 * parameter. Ordering parameters to evade a rule is circumventing the robots.txt, not obeying it, and
 * 14.1 and 14.2 are not satisfied by a technicality. The same goes for every other way of reaching the
 * forbidden pages; the gate exists to produce this answer, and the answer is one page.
 *
 * `page` stays. It is the repository convention — the Result_Page number as the `page` query parameter,
 * omitted for the first page — and it is load-bearing: `requestedPageNumber` in
 * `apps/api/src/scraper/fixture-retrieval.runtime.ts` recovers the page number from that parameter
 * alone, and `apps/api/src/scraper/__tests__/fixture-retrieval.runtime.test.ts` asserts it against
 * every registered adapter for every page up to the limit of 13.3. robots.txt says nothing about
 * `page`, Indeed has no such parameter of its own and ignores one it does not know, and the URLs
 * carrying it are the ones the robots.txt evaluation of the remaining nine intended paths is made
 * against. So the convention is kept at the cost of one parameter Indeed disregards, and the day Indeed
 * publishes a permitted pagination parameter, {@link INDEED_RESULT_PAGE_LIMIT} is the one constant that
 * changes.
 *
 * `Disallow: /viewjob` is noted and breaks nothing: `/viewjob?jk=…` is the advertisement URL stored on
 * a Job_Posting for the user to click in their own browser (6.3), and no part of the Job_Tool ever
 * retrieves it.
 *
 * ## Status of the parameter names: every remaining one is provisional
 *
 * The capture of task 24.2 was answered twice — once at the robots.txt gate and once, with the
 * forbidden parameter dropped, with HTTP 403 and a Cloudflare security check — so **no Result_Page has
 * ever reached this repository**. Every name and the step list below are read from Indeed's own public
 * search URLs and from third-party descriptions of them; that is evidence, not confirmation. See
 * `./__fixtures__/README.md`. What each one degrades into if it is wrong:
 *
 * 1. **`q` — the keyword expression.** The parameter name itself is as certain as anything here. What is
 *    provisional is the `"A" OR "B"` syntax: Indeed documents boolean operators for its search field,
 *    but a Platform that reads the whole expression as one literal term would answer a narrower result
 *    list than the synonyms ask for. Glassdoor turned out to do exactly that and still served 30
 *    readable Job_Posting, so the expression is kept rather than pre-emptively reduced to the job title.
 *    *Degradation:* a narrower result list, and the Relevance_Service judges what arrives (15.2).
 * 2. **`l` — the place.** A free-text place, as the German surface shows it. *Degradation:* if it is
 *    ignored, the retrieval reads a country-wide result list, which is wider than asked for; the
 *    Commute_Service rates the work locations afterwards (8.1) and the Relevance_Service judges them.
 * 3. **`fromage` — the posting age in days.** See {@link INDEED_AGE_BUCKETS_DAYS} for why 30 is a bucket
 *    although the user interface offers 1, 3, 7 and 14. *Degradation:* an ignored value means no age
 *    filter, so older Job_Posting arrive as well — wider, never narrower.
 * 4. **`jt` — the job type. The one parameter whose failure is not graceful.** `fulltime`, `parttime`,
 *    `contract`, `temporary` and `internship` are documented values of Indeed's own search; `permanent`
 *    is the one this mapping needs most (`PERMANENT` is "Festanstellung", which is what the shipped
 *    Default_Search_Profile asks for) and is the one read from the German surface rather than from a
 *    documented list. A value Indeed does not know is either ignored, which is harmless, **or answered
 *    with an empty result list**, which this adapter reports as a completed retrieval with no
 *    Job_Posting — indistinguishable, in the markup, from a search that genuinely matched nothing. The
 *    two probes of 24.2 establish that the 403 is *not* caused by `jt` (the request with it and the one
 *    without it were answered identically) and settle nothing else, so the question stays open until a
 *    Result_Page arrives; the test is then the one {@link INDEED_JOB_TYPES} names.
 *
 * Everything in this list is one edit in one file, which is why the names and the bucket list are named
 * constants and why the tests assert against those constants wherever they can rather than against
 * literal strings. `docs/adapters/indeed.md` (task 24.4) records the retrieval scope this file decides.
 */

import type { EffectiveSearchProfile, EmploymentType } from '@job-scraper/domain';

import { criterionValue, requiredCriterionValue } from '../search-criteria.js';

/** The origin every Indeed request goes to. The German surface, and the host robots.txt is read from. */
export const INDEED_ORIGIN = 'https://de.indeed.com';

/** The path of the German Indeed result list. */
const RESULT_LIST_PATH = '/jobs';

/**
 * How many Result_Page one Indeed retrieval may read: one.
 *
 * Not a politeness margin below the limit of 13.3 but the only number the Platform's robots.txt leaves:
 * `start` is Indeed's sole pagination parameter and `Disallow: /*&start=` forbids it, so the second
 * Result_Page has no permitted address. See the file comment.
 *
 * The adapter caps `context.pageBudget` at this value, so the Scraper_Service hands in the production
 * budget of 13.3 and this Platform still reads one page. Raise it only together with a pagination
 * parameter the robots.txt of the Platform actually permits.
 */
/**
 * **No longer applied by the adapter.** Kept as the record of what this Platform's robots.txt says,
 * which the tests below still assert against the stored rules.
 *
 * `Disallow: /*&start=` forbids Indeed's only pagination parameter, so under `ROBOTS_POLICY=respect`
 * this is the bound the retrieval would take. The configured policy is `ignore` (14.10), so the
 * adapter declares no `pageLimit` and walks to the Page_Safety_Limit instead; the prohibition is
 * reported once per Scrape_Run as a warning (14.12).
 *
 * Moot in practice either way: `PLATFORM_ACTIVATION.INDEED` is `false`, because de.indeed.com
 * answers the honest user agent with HTTP 403 and a Cloudflare check — an access control rather than
 * a convention, and this repository does not defeat those.
 */
export const INDEED_RESULT_PAGE_LIMIT = 1;

/**
 * The posting-age buckets of the `fromage` filter, in days, ascending. Provisional.
 *
 * The visible date filter of the result list offers 1, 3, 7 and 14 days. 30 is nevertheless a bucket
 * here, for one reason that outweighs the uncertainty: `fromage` is documented as a plain number of days
 * rather than as an enumeration, the shipped Default_Search_Profile asks for 30 days, and a bucket list
 * ending at 14 would drop the parameter for that profile — so the Criterion_Field the capability
 * declares as supported would reach no URL the Job_Tool actually builds, which is what rule 2 of the
 * capability conventions forbids. If Indeed honours only its own four presets, `fromage=30` is ignored
 * and the result list is *wider* than asked for, which is the same graceful degradation as every other
 * unknown filter value.
 *
 * A Search_Profile value between two buckets takes the next larger one: `publicationPeriodDays` of 10
 * becomes the 14-day bucket, which includes everything from the last 10 days, while 7 would drop
 * Job_Posting the user asked for. A period above the largest bucket drops the filter entirely, since
 * "older than 30 days as well" is what no filter means.
 */
export const INDEED_AGE_BUCKETS_DAYS = [1, 3, 7, 14, 30] as const;

/**
 * How an {@link EmploymentType} reaches Indeed's job-type filter. Provisional, and the one mapping whose
 * failure is not graceful — see point 4 of the file comment.
 *
 * `PERMANENT` is "Festanstellung" and is mapped to `permanent` rather than to the documented
 * `fulltime`: full-time and permanent are different statements, and asking for `fulltime` would drop
 * every part-time permanent Job_Posting the Search_Profile did ask for while admitting fixed-term
 * full-time ones it did not.
 *
 * `ANY` maps to `null`, which omits the parameter: asking for every job type *is* the unfiltered result
 * list, and sending a value for it would risk excluding postings that state no job type at all.
 *
 * The test once a Result_Page arrives: compare the posting count of a query carrying `jt` with one
 * without it. An equal count means the value was accepted or ignored; zero against a non-zero count
 * means Indeed answered an unknown job type with an empty result list.
 */
export const INDEED_JOB_TYPES: Readonly<Record<EmploymentType, string | null>> = {
  PERMANENT: 'permanent',
  TEMPORARY: 'temporary',
  CONTRACT: 'contract',
  ANY: null,
};

/** The query parameter names, in the order they are appended, so one profile yields one URL. */
const QUERY_PARAMS = {
  /** Free-text keyword query; carries the job title and its synonyms. */
  keywords: 'q',
  /** The place the result list is built around. No radius: the robots.txt forbids `radius=`. */
  location: 'l',
  /** Posting age in days. */
  age: 'fromage',
  /** Job type. */
  jobType: 'jt',
  /** 1-based Result_Page number: the repository convention the fixture-mode runtime reads. */
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
 * Each term is quoted and the terms are joined with `OR`: without the quotes a two-word synonym such as
 * `Project Manager` would be read as two independent terms, and Indeed ANDs bare terms by default, so
 * the unquoted expression would ask for postings carrying *every* word. The job title comes first and
 * duplicates are dropped, so a synonym list that repeats the title does not produce the term twice.
 *
 * The syntax is provisional in the sense of point 1 of the file comment: it is Indeed's documented
 * boolean syntax, but no response has confirmed that this expression is read as a boolean rather than as
 * one literal term.
 */
export function indeedKeywordQuery(
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
 * The URL of one Indeed Result_Page.
 *
 * Deterministic in its inputs: the same effective Search_Profile and the same page number always yield
 * the same string, including the order of the query parameters. That is what lets the robots.txt
 * evaluation of 14.1 run against every `resultListUrl(profile, n)` and lets a fixture test compare URLs.
 *
 * Every URL this function produces is one the robots.txt of the Platform permits, and that is a
 * property the tests assert against the Platform's own rules rather than a claim made here. A page
 * number above {@link INDEED_RESULT_PAGE_LIMIT} still yields a URL — the Scraper_Service resolves all
 * ten intended paths of 13.3 before the first request — but the adapter never requests it.
 *
 * @param profile The effective Search_Profile of Indeed.
 * @param pageNumber The 1-based Result_Page number.
 * @throws A `RangeError` for a page number that is not a positive integer, and for a Search_Profile
 *   without one of the two mandatory Criterion_Field of Indeed (see {@link requiredCriterionValue}).
 */
export function indeedResultListUrl(profile: EffectiveSearchProfile, pageNumber: number): string {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(
      `A Result_Page number must be a positive integer, received ${String(pageNumber)}.`,
    );
  }

  const jobTitle = requiredCriterionValue(profile, 'jobTitle');
  const searchLocation = requiredCriterionValue(profile, 'searchLocation');
  const titleSynonyms = criterionValue(profile, 'titleSynonyms');
  const employmentType = criterionValue(profile, 'employmentType');
  const publicationPeriodDays = criterionValue(profile, 'publicationPeriodDays');

  const url = new URL(RESULT_LIST_PATH, INDEED_ORIGIN);

  url.searchParams.set(QUERY_PARAMS.keywords, indeedKeywordQuery(jobTitle, titleSynonyms));
  url.searchParams.set(QUERY_PARAMS.location, queryValue(searchLocation));

  if (publicationPeriodDays !== undefined) {
    const bucket = raiseToStep(publicationPeriodDays, INDEED_AGE_BUCKETS_DAYS);

    if (bucket !== null) {
      url.searchParams.set(QUERY_PARAMS.age, String(bucket));
    }
  }

  if (employmentType !== undefined) {
    const jobType = INDEED_JOB_TYPES[employmentType];

    if (jobType !== null) {
      url.searchParams.set(QUERY_PARAMS.jobType, jobType);
    }
  }

  if (pageNumber > 1) {
    // The repository convention only; Indeed paginates with `start`, which its robots.txt forbids, so
    // no retrieval of this Platform asks for such a page. See the file comment.
    url.searchParams.set(QUERY_PARAMS.page, String(pageNumber));
  }

  return url.toString();
}
