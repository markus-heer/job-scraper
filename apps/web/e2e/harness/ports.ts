/**
 * The ports and paths the E2E harness runs on.
 *
 * Read from the repository environment file, exactly as `vite.config.ts` reads them, so there is one
 * definition of `WEB_PORT` and `API_PORT` and the harness cannot start a Web_App on one port and
 * then look for it on another. The defaults match `.env.example`.
 *
 * Why not `loadEnv` from Vite as the Vite config does: that helper is bound to a Vite mode and a
 * plugin pipeline, and this module is loaded by the Playwright config and by `globalSetup`, neither
 * of which is a Vite process. `process.loadEnvFile` is the same mechanism the API_Service uses
 * (`apps/api/src/config/env-file.ts`) and gives the same precedence — a value already in
 * `process.env` wins over the file, so a developer who exports a port for one run keeps it.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The repository root, which is where the single environment file of 1.12 lives. */
export const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** The `.env` file the Job_Tool is configured through, whether or not it exists. */
export const envFilePath = `${repositoryRoot}.env`;

/** Loads the repository environment file into `process.env`, if there is one. Idempotent. */
export const loadRepositoryEnv = (): void => {
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }
};

/** A port from the environment, or its documented default. */
const portOf = (key: string, fallback: number): number => {
  const raw = (process.env[key] ?? '').trim();
  const parsed = Number(raw);

  return /^\d+$/.test(raw) && Number.isInteger(parsed) ? parsed : fallback;
};

loadRepositoryEnv();

/** Where the Web_App is served, and therefore the base URL of every spec. */
export const WEB_PORT = portOf('WEB_PORT', 5173);

/** Where the API_Service listens. The Web_App proxies `/graphql` to it. */
export const API_PORT = portOf('API_PORT', 4000);

/** The loopback host everything in the Job_Tool binds to (1.16). */
export const LOOPBACK_HOST = '127.0.0.1';

/** The base URL every spec navigates relative to. */
export const WEB_BASE_URL = `http://${LOOPBACK_HOST}:${String(WEB_PORT)}`;

/** The API_Service GraphQL endpoint. */
export const API_GRAPHQL_URL = `http://${LOOPBACK_HOST}:${String(API_PORT)}/graphql`;

/**
 * The readiness URL of the API_Service: its own `health` query, sent as a GET.
 *
 * The same query the Start_Script probes with (`scripts/lib/api-step.mjs`), and for the same reason:
 * a bound socket proves that something is listening, while a `health` answer proves the GraphQL
 * schema was built and the Posting_Store connection is open (1.11). A GET rather than the
 * Start_Script's POST because Playwright's `webServer` polls with GET, and Apollo Server answers a
 * query sent that way.
 */
export const API_HEALTH_URL = `${API_GRAPHQL_URL}?query=%7Bhealth%7D`;
