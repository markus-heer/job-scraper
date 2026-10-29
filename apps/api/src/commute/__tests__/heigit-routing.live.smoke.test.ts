/**
 * The opt-in `@live` smoke test of the HeiGIT Routing_Provider (8.1, 8.8; design, Testing Strategy).
 *
 * `./heigit-routing.provider.test.ts` and `./heigit-routing.schema.test.ts` pin the mapping and the
 * response gate against frozen bodies. Neither can answer the question a frozen body cannot
 * answer — *does HeiGIT still answer in the shape those bodies were written against?* This file
 * answers it with three real requests, one per endpoint.
 *
 * The response shapes the schemas describe were taken from the services' own published contract
 * and, for the experimental Public Transit Router, from the response fixtures in its public source
 * tree. That is a stronger source than a guess and a weaker one than a live answer, which is what
 * this test exists to obtain. It needs a HeiGIT API key, so it runs only when both variables are
 * set:
 *
 * ```bash
 * ROUTING_LIVE_SMOKE=1 ROUTING_API_KEY=your-key pnpm --filter @job-scraper/api test --run \
 *   src/commute/__tests__/heigit-routing.live.smoke.test.ts
 * ```
 *
 * `pnpm test` cannot reach the live path even on a machine that exports the variables: the `test`
 * task of `turbo.json` declares neither of them, and Turborepo passes a task only the environment
 * it declares. The gate is a `describe.skipIf`, so a default run reports the test as skipped rather
 * than pretending it does not exist.
 *
 * A quota that is exhausted, a key that is rejected and a transit service that is down all make the
 * provider answer `null`, which is the behaviour 8.8 asks for. This test therefore fails only on
 * the one outcome a frozen body cannot catch: geocoding and bicycle routing answering `null` for a
 * route that demonstrably exists — two Munich addresses eight kilometres apart. The transit answer
 * is reported rather than asserted, because the reference point used here can legitimately fall on
 * a day with no connection.
 */

import { describe, expect, it } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import { HeigitRoutingProvider } from '../heigit-routing.provider';
import { ROUTING_QUERY_TIMEOUT_MS } from '../routing-provider.port';

/** Opts the live requests in. Not part of `.env.example`: it belongs to a developer's check. */
export const ROUTING_LIVE_SMOKE_VARIABLE = 'ROUTING_LIVE_SMOKE';

/** The key variable of the Job_Tool; the live test reads the same one the API_Service uses. */
const ROUTING_API_KEY_VARIABLE = 'ROUTING_API_KEY';

/** Three sequential queries, each bounded by the 10-second timeout of 8.8, plus room to breathe. */
const LIVE_SMOKE_TIMEOUT_MS = 4 * ROUTING_QUERY_TIMEOUT_MS;

/** Whether a variable is set to something that means "yes". */
const isEnabled = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value !== 'false';

const liveEnabled =
  isEnabled(process.env[ROUTING_LIVE_SMOKE_VARIABLE]) &&
  isEnabled(process.env[ROUTING_API_KEY_VARIABLE]);

describe.skipIf(!liveEnabled)(
  `@live HeiGIT, one real query per endpoint (opt in with ${ROUTING_LIVE_SMOKE_VARIABLE} and ${ROUTING_API_KEY_VARIABLE})`,
  () => {
    it(
      'resolves a Munich address and measures the two Commute_Time values',
      async () => {
        const provider = new HeigitRoutingProvider({
          routingApiKey: process.env[ROUTING_API_KEY_VARIABLE] ?? '',
        } as unknown as EnvConfig);
        const signal = AbortSignal.timeout(LIVE_SMOKE_TIMEOUT_MS);

        const home = await provider.geocode('Hörkherstraße 1d, 80689 München', signal);
        const work = await provider.geocode('Marienplatz 8, 80331 München', signal);

        console.info(
          `geocode: home ${JSON.stringify(home)}, work ${JSON.stringify(work)} (no key is printed, 14.9).`,
        );

        expect(home, 'The default Home_Address must resolve.').not.toBe(null);
        expect(work, 'A Munich address must resolve.').not.toBe(null);
        expect(['EXACT', 'IMPRECISE']).toContain(home?.precision);

        if (home === null || work === null) {
          return;
        }

        const bicycleMinutes = await provider.travelDurationMinutes(
          { from: home.coordinate, to: work.coordinate, mode: 'BICYCLE' },
          signal,
        );

        // 09:00 German local time on the day after tomorrow. The production reference point of 8.1
        // comes from the Commute_Service's own helper; this is a stand-in, so the smoke test does
        // not depend on which weekday it is run on.
        const arriveBy = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000);

        arriveBy.setUTCHours(8, 0, 0, 0);

        const transitMinutes = await provider.travelDurationMinutes(
          { from: home.coordinate, to: work.coordinate, mode: 'TRANSIT', arriveBy },
          signal,
        );

        console.info(
          `durations: bicycle ${String(bicycleMinutes)} min, transit ${String(transitMinutes)} min for an arrival at ${arriveBy.toISOString()}.`,
        );

        expect(
          bicycleMinutes,
          'Two Munich addresses eight kilometres apart have a cycling route. A null here means the Directions response shape changed; re-check apps/api/src/commute/heigit-routing.schema.ts.',
        ).not.toBe(null);
        expect(bicycleMinutes).toBeGreaterThan(0);

        if (transitMinutes === null) {
          console.warn(
            'The Public Transit Router determined no connection. That degrades to Best_Commute_Time "unknown" (8.8), which is permitted — but if it persists, re-check ptrJourneysResponseSchema against the live answer.',
          );

          return;
        }

        expect(transitMinutes).toBeGreaterThan(0);
        expect(Number.isInteger(transitMinutes)).toBe(true);
      },
      LIVE_SMOKE_TIMEOUT_MS,
    );
  },
);
