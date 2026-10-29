/**
 * The local HTTP server the adapter parser tests retrieve their frozen fixtures from (design,
 * Testing Strategy).
 *
 * Why a server rather than reading the HTML file directly in the test: an adapter talks to the
 * {@link AdapterPage} port, and a parser test is only worth its name if the adapter walks the same
 * road it walks in production — a URL built from the effective Search_Profile, a response with a
 * status and headers, a relative pagination link resolved against a real origin, and a page request
 * that can time out. A `file://` path has no status, no headers and no timeout, so three of the
 * situations the adapter has to detect (`FETCH_RATE_LIMITED` via 429 and `retry-after`,
 * `SIGN_IN_REQUIRED` via a redirect, and the per-page limit of 6.2) would be untestable.
 *
 * The server therefore answers four kinds of route:
 *
 * - `HTML`: a captured fixture with any status and any headers;
 * - `REDIRECT`: a `Location` answer, which is how a sign-in wall announces itself (7.2);
 * - `STATUS`: a bare status, for the reported rate limit of 13.5;
 * - `NEVER_RESPONDS`: a request that is accepted and then left open forever, which is the only
 *   honest way to exercise the 30-second Result_Page limit of 6.2 and the repetitions of 13.4.
 *   {@link NEVER_RESPONDING_PATH} is registered on every server, so that path is always available.
 *
 * It binds to `127.0.0.1` on an ephemeral port, like everything else in this tool (1.16), and it
 * records every request it received so a test can assert how many Result_Page were requested, in
 * which order, and that the 10-page budget of 13.3 held.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The path every fixture server leaves unanswered, for the timeout path of 6.2 and 13.4. */
export const NEVER_RESPONDING_PATH = '/never-responds';

/** The content type a captured Result_Page is served with. */
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/** The loopback address the server binds to; never a routable interface (1.16, risk 13). */
const LOOPBACK_HOST = '127.0.0.1';

/** How one route answers. */
export type FixtureRoute =
  | {
      readonly kind: 'HTML';
      /** The captured document, served byte for byte. */
      readonly html: string;
      /** Defaults to 200. */
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'REDIRECT';
      readonly location: string;
      /** Defaults to 302. */
      readonly status?: number;
    }
  | {
      readonly kind: 'STATUS';
      readonly status: number;
      readonly body?: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'NEVER_RESPONDS' };

/** The routes of a fixture server, keyed by `pathname` or by `pathname` plus query string. */
export type FixtureRoutes = Readonly<Record<string, FixtureRoute>>;

/** One request the server received. */
export interface FixtureRequestRecord {
  readonly method: string;
  /** The request target as sent, including the query string. */
  readonly target: string;
  readonly pathname: string;
  readonly search: string;
  /** The user agent the request carried, so a test can assert 14.5 end to end. */
  readonly userAgent: string | undefined;
  /** Arrival time, which is what the pacing assertions of 13.2 and 14.4 are measured on. */
  readonly receivedAt: number;
}

/** Construction arguments of a {@link FixtureServer}. */
export interface FixtureServerOptions {
  readonly routes?: FixtureRoutes;
  /** The body served for a path with no route. Defaults to a minimal 404 document. */
  readonly notFoundHtml?: string;
}

const DEFAULT_NOT_FOUND_HTML = '<!doctype html><html lang="de"><body>Nicht gefunden</body></html>';

/**
 * A fixture server. Started with {@link FixtureServer.start} and closed in the test's teardown, which
 * destroys the sockets of any still-open `NEVER_RESPONDS` request so a hanging page request can never
 * keep a Vitest worker alive.
 */
export class FixtureServer {
  readonly #server: Server;

  readonly #routes: Map<string, FixtureRoute>;

  readonly #notFoundHtml: string;

  readonly #requests: FixtureRequestRecord[] = [];

  /** The responses of unanswered requests, kept so the teardown can end them. */
  readonly #openResponses = new Set<ServerResponse>();

  #origin: string | undefined;

  #closed = false;

  private constructor(options: FixtureServerOptions) {
    this.#routes = new Map<string, FixtureRoute>(Object.entries(options.routes ?? {}));
    this.#routes.set(NEVER_RESPONDING_PATH, { kind: 'NEVER_RESPONDS' });
    this.#notFoundHtml = options.notFoundHtml ?? DEFAULT_NOT_FOUND_HTML;
    this.#server = createServer((request, response) => {
      this.#handle(request, response);
    });
  }

  /** Starts a server on an ephemeral loopback port. */
  static async start(options: FixtureServerOptions = {}): Promise<FixtureServer> {
    const server = new FixtureServer(options);

    await server.#listen();

    return server;
  }

  /** The origin to build fixture URLs from, for example `http://127.0.0.1:53124`. */
  get origin(): string {
    if (this.#origin === undefined) {
      throw new Error('The fixture server is not listening.');
    }

    return this.#origin;
  }

  /** Every request the server received, in arrival order. */
  get requests(): readonly FixtureRequestRecord[] {
    return this.#requests;
  }

  /** The absolute URL of a path on this server. */
  urlFor(pathAndQuery: string): string {
    return new URL(pathAndQuery, this.origin).toString();
  }

  /** The URL of the path that is never answered (6.2, 13.4). */
  get neverRespondingUrl(): string {
    return this.urlFor(NEVER_RESPONDING_PATH);
  }

  /** Registers or replaces one route while the server runs. */
  setRoute(pathAndQuery: string, route: FixtureRoute): void {
    this.#routes.set(pathAndQuery, route);
  }

  /** Forgets every recorded request, so one test file can reuse a server across cases. */
  clearRequests(): void {
    this.#requests.length = 0;
  }

  /** Stops the server and ends every request that was deliberately left open. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const response of this.#openResponses) {
      response.destroy();
    }

    this.#openResponses.clear();

    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined || error === null) {
          resolve();

          return;
        }

        reject(error);
      });
      // Sockets of an aborted `NEVER_RESPONDS` request can still be half-open at this point, and
      // `close` waits for every connection, so the server would never finish closing without this.
      this.#server.closeAllConnections();
    });
  }

  async #listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, LOOPBACK_HOST, () => {
        this.#server.removeListener('error', reject);
        this.#origin = `http://${LOOPBACK_HOST}:${String((this.#server.address() as AddressInfo).port)}`;
        resolve();
      });
    });
  }

  /**
   * Answers one request.
   *
   * Lookup is by `pathname` plus query string first and by `pathname` second, so a Platform that
   * paginates through a query parameter gets one route per page while a Platform that paginates
   * through the path needs one route per path and can ignore the query entirely.
   */
  #handle(request: IncomingMessage, response: ServerResponse): void {
    const target = request.url ?? '/';
    const url = new URL(target, this.origin);

    this.#requests.push({
      method: request.method ?? 'GET',
      target,
      pathname: url.pathname,
      search: url.search,
      userAgent: request.headers['user-agent'],
      receivedAt: Date.now(),
    });

    const route =
      this.#routes.get(`${url.pathname}${url.search}`) ?? this.#routes.get(url.pathname);

    if (route === undefined) {
      this.#send(response, 404, { 'content-type': HTML_CONTENT_TYPE }, this.#notFoundHtml);

      return;
    }

    switch (route.kind) {
      case 'HTML':
        this.#send(
          response,
          route.status ?? 200,
          { 'content-type': HTML_CONTENT_TYPE, ...route.headers },
          route.html,
        );

        return;

      case 'REDIRECT':
        this.#send(response, route.status ?? 302, { location: route.location }, '');

        return;

      case 'STATUS':
        this.#send(
          response,
          route.status,
          { 'content-type': HTML_CONTENT_TYPE, ...route.headers },
          route.body ?? '',
        );

        return;

      case 'NEVER_RESPONDS':
        // Deliberately no write and no end: the request stays open until the test's page timeout
        // fires or the server is closed.
        this.#openResponses.add(response);
        response.on('close', () => {
          this.#openResponses.delete(response);
        });

        return;
    }
  }

  #send(
    response: ServerResponse,
    status: number,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): void {
    response.writeHead(status, headers);
    response.end(body);
  }
}

/**
 * Runs `use` with a fixture server and closes it afterwards, whatever `use` did.
 *
 * The intended entry point for a parser test: a forgotten `close` leaves a listening socket behind
 * and, with an open `NEVER_RESPONDS` request, a Vitest worker that does not exit.
 */
export async function withFixtureServer<T>(
  options: FixtureServerOptions,
  use: (server: FixtureServer) => Promise<T>,
): Promise<T> {
  const server = await FixtureServer.start(options);

  try {
    return await use(server);
  } finally {
    await server.close();
  }
}
