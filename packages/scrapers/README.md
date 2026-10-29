# @job-scraper/scrapers

The retrieval layer of the Scraper_Service: the scheduling and etiquette primitives, the Platform_Adapter
implementations and the Playwright runtime. The package depends on `@job-scraper/domain` for the closed value lists and
the Search_Profile types, and it does not depend on Nest, so every primitive is testable without an application context.

## Scheduling (`src/scheduling/`)

Requirement 13.9 states two independent bounds: at most 4 Platform_Adapter at a time, and at most one page request per
Platform at a time. `Semaphore` carries the first one, `PlatformQueue` the second (plus the 2-second settle-time pacing
of 13.2 and 14.4).

`Semaphore` is a counting semaphore with `acquire(signal?): Promise<Release>`. The Scraper_Service instantiates it with
4 permits and wraps each adapter run in it. Three details are behaviour, not incidental:

- **The release is idempotent.** A permit handed back twice would push the number of running adapters above the bound,
  and a `finally` block running after an explicit release is the normal way that happens. Each release function tracks
  its own permit in a closure, so a double release of one permit cannot consume another's.
- **`run(task, signal?)` is the deadlock-free path.** It acquires, runs the task and releases in a `finally` block, so
  neither a thrown error nor a rejected promise can leak a permit. Bare `acquire` is available for callers that need the
  permit to outlive one function body; those must release in a `finally` block themselves.
- **Cancellation never loses a permit.** An already aborted signal rejects without taking a permit; an abort while
  waiting removes the caller from the queue and rejects with the signal's own reason, so a Scrape_Run cancelled by the
  user (12.7) stays distinguishable from one cancelled by the retrieval deadline (13.6). A freed permit goes straight to
  the longest-waiting caller rather than through the counter, which keeps a synchronously arriving caller from
  overtaking a queued one.

`permits`, `availablePermits` and `waitingCount` are exposed for the entry/exit instrumentation that Property 12 uses.

## robots.txt (`src/robots/`)

Requirement 14.1 asks for one robots.txt retrieval per Platform and Scrape_Run, before the first page request, reused
for the rest of that run. `evaluateRobots` performs a single uncached evaluation; `RobotsCache` is the per-run object
the Scraper_Service creates once and asks per Platform. Four details are behaviour, not incidental:

- **The retrieved body is cached, not the decision.** A later call with further intended paths is answered from the same
  body, so the "exactly one request per Platform" count of Property 13 holds without the first caller having to know
  every path up front. Concurrent callers for the same Platform share the one in-flight retrieval.
- **Cancellation is not a robots.txt fault.** A Scrape_Run aborted mid-request rejects with the signal's own reason, as
  `Semaphore` does, rather than reporting `ROBOTS_TXT_UNAVAILABLE`; that status is reserved for the robots.txt itself
  being unretrievable within 10 seconds or unevaluable (14.3). A cancelled retrieval is also dropped from the cache
  again, so it cannot leave a Platform permanently unevaluable.
- **An absent robots.txt is not an unavailable one.** Per RFC 9309 a 4xx answer other than 429 permits unrestricted
  retrieval, so the evaluation continues against an empty rule set; 429 and every 5xx are "unreachable" and skip the
  Platform.
- **The fetch function is injected.** Retrieval goes through `fetch` rather than Playwright, so a blocked robots.txt
  costs no browser page, and every test answers from a fixture instead of the network.

`robotsPlatformStatus` maps a decision onto `EXCLUDED_BY_ROBOTS_TXT` (14.2), `ROBOTS_TXT_UNAVAILABLE` (14.3) or `null`
when the retrieval may proceed. The reported `crawlDelaySeconds` is what `PlatformQueue` feeds into
`max(2000, crawlDelaySeconds * 1000)` (14.4).

## Playwright runtime (`src/runtime/`)

Three nested lifetimes with one owner each: one headless Chromium per Scrape_Run (`ScrapeRunBrowser`), one
`BrowserContext` per Platform (`PlatformBrowserContext`, fresh storage state, the Job_Tool user agent, the resource
filter), and one page per Result_Page request, handed to an adapter as the `AdapterPage` port. `withScrapeRunBrowser` is
the intended entry point, because it owns the `finally` block that closes every page, every context and the browser.
Four details are behaviour, not incidental:

- **An adapter neither paces nor repeats.** Every `load` goes through the `PlatformQueue` of its Platform, so the single
  in-flight request of 13.9, the gap of 13.2, a stated crawl-delay (14.4) and the three attempts of 13.4 apply without
  an adapter knowing they exist. A navigation that times out or fails at the transport level becomes a
  `RetryableRequestError`; a response with any HTTP status is returned unchanged, because a reported rate limit (13.5),
  a sign-in redirect (7.2) and a bot check (7.6) are observations the adapter has to make, not failures to repeat.
- **Cancellation outranks repetition.** A Scrape_Run cancelled by the user (12.7) or by the 30-minute limit (13.6)
  rejects with the signal's own reason rather than consuming an attempt, and an `AbortSignal` listener closes the
  browser so no Chromium survives the run.
- **The Playwright surface is narrowed on purpose.** `playwright-port.ts` writes down the seven calls the runtime makes.
  That keeps the runtime tests free of a browser binary, and it makes the prohibition of 7.5 and 7.6 — never fill or
  submit a sign-in or registration form, never answer a Captcha — a property of the type: there is no `click`, no `fill`
  and no `type` to reach for. `defaultBrowserLauncher` returns the real `chromium` as the port type, which is the
  compile-time check that the narrowing stays faithful.
- **The user agent is built once.** `buildUserAgent` assembles the string of 14.5 (tool name, private-use statement,
  contact detail from the environment file, no browser imitation) and both the `BrowserContext` and the robots.txt
  retrieval read it from there, so the two cannot drift apart. A contact detail that is empty after the reserved
  characters are removed, or that would make the string look like a browser, is rejected rather than silently patched.

The browser binaries are **not** downloaded by `pnpm install` — `playwright` ships no install script. The Start_Script
installs them in its step 3 (1.5, 1.7); `pnpm exec playwright install chromium` does it by hand.

## Opt-in live smoke test (`@live`)

`src/adapters/<platform>/__tests__/live.smoke.test.ts` performs **one** real Result_Page request against the Platform
and asserts that at least one Job_Posting survives normalization, or that the Platform_Status is one of the blocking
answers the requirements foresee (sign-in required, platform blocked, platform unreachable, fetch rate limited, failed,
excluded by robots.txt, robots.txt unavailable). That is the one question a frozen fixture cannot answer: whether the
Platform still serves the markup the fixtures were written against. A `PAGE_LAYOUT_UNKNOWN` fails the test and is the
signal to re-capture that Platform's fixtures and to update `docs/adapters/<platform>.md` with the review date (6.7,
14.7).

It is **skipped by default** and never part of the quality gate:

```bash
SCRAPER_LIVE_SMOKE=1 USER_AGENT_CONTACT=you@example.com pnpm test:live
```

| Variable             | Effect                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `SCRAPER_LIVE_SMOKE` | Anything but unset, empty, `0` or `false` opts the live retrieval in. Unset means skipped. |
| `USER_AGENT_CONTACT` | The contact detail of the user agent (14.5). Required once opted in; missing it **fails**. |

Three details are behaviour, not incidental:

- **`pnpm test` cannot reach the live path**, even with the variable exported: the `test` task of `turbo.json` does not
  declare it, and Turborepo passes a task only the environment it declares. The in-file gate is a `describe.skipIf`, so
  the default run reports the test as skipped rather than hiding it.
- **The opt-in run is as polite as a fixture capture.** The robots.txt is fetched and evaluated first and gates the
  request (14.1 – 14.3); a stated crawl-delay is handed to the Platform's queue (14.4); the request goes through the
  production runtime, so it carries the unchanged Job_Tool user agent, a fresh storage state, the resource filter and
  the 30-second page limit, and it structurally cannot sign in or answer a Captcha (7.5, 7.6).
- **Exactly one Result_Page is requested.** The adapter runs with `pageBudget: 1` and the page handed to it records
  every load, so the count is asserted rather than assumed. The only repetition possible is the at-most-three attempt
  series of 13.4 inside that single request, which only a page that does not answer triggers.

The retrieval needs a Playwright Chromium binary (`pnpm exec playwright install chromium`) and a network. This is the
mirror image of `pnpm fixtures:capture`, which refuses to run _under_ a test runner; a smoke test runs inside Vitest by
definition, so it gates on the explicit opt-in instead.

## Layout

```
src/index.ts                      the public surface; consumers import from '@job-scraper/scrapers' only
src/robots/robots.ts              robots.txt retrieval, per-run caching and Platform_Status mapping (14.1-14.4)
src/runtime/browser.ts            browser, context per Platform and the AdapterPage port over a page (6.2, 8.4)
src/runtime/playwright-port.ts    the narrow Playwright surface the runtime is allowed to use
src/runtime/user-agent.ts         the single Job_Tool user agent string (14.5)
src/scheduling/semaphore.ts       the counting semaphore for the 4-adapter bound (13.9)
```

`tsconfig.json` type-checks the sources, the tests and the Vitest config without emitting; `tsconfig.build.json` narrows
the inputs to `src/` and emits `dist/` with declarations. Unit and property tests live in `src/**/__tests__/`.
