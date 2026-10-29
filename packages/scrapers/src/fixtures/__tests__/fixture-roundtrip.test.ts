/**
 * The path a Platform_Adapter parser test takes (tasks 9.3 and 10.3): a stored fixture is read from
 * disk, served under the real Platform path, and retrieved by code that only ever sees the
 * {@link AdapterPage} port — no browser, no network, no Playwright.
 *
 * This test exists so that the claim is checked rather than described. The "adapter" here is a
 * three-line stand-in, because 9.1 owns the real one; what is asserted is the tooling around it.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdapterPage } from '../../adapter/types.js';
import { RetryableRequestError } from '../../scheduling/platform-queue.js';
import { readFixture } from '../fixture-files.js';
import { createFixturePageFactory } from '../fixture-page.js';
import { FixtureServer } from '../fixture-server.js';
import { sanitizeFixtureHtml } from '../sanitize-html.js';

/** A result list as a capture would have stored it: scripts and session identifiers already gone. */
const STORED_FIXTURE = sanitizeFixtureHtml(
  `<html lang="de"><body><ol class="results">
<li data-posting-id="12345"><a href="/job--12345.html?sessionId=abc123def456ghi789">Projektmanagerin</a></li>
<li data-posting-id="12346"><a href="/job--12346.html">Senior Projektmanagerin</a></li>
</ol><script>bot()</script></body></html>`,
).html;

/** The path the adapter's result list URL points at, on the real Platform host. */
const RESULT_LIST_PATH = '/jobs/projektmanagerin?page=1';

const PLATFORM_URL = `https://www.stepstone.de${RESULT_LIST_PATH}`;

/** A stand-in parser: the Posting_Id attributes of the stored list, in document order. */
function postingIds(html: string): readonly string[] {
  return [...html.matchAll(/data-posting-id="([^"]+)"/g)].map((match) => match[1] ?? '');
}

let fixtureDir: string;
let server: FixtureServer | undefined;

beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'job-scraper-roundtrip-'));
  await writeFile(path.join(fixtureDir, 'result-list-page-1.html'), STORED_FIXTURE, 'utf8');
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('fixture round trip', () => {
  it('serves a stored fixture to code that only knows the AdapterPage port', async () => {
    const fixture = await readFixture({
      platform: 'STEPSTONE',
      fixtureCase: 'result-list-page-1',
      fixtureDir,
    });

    server = await FixtureServer.start({
      routes: { [RESULT_LIST_PATH]: { kind: 'HTML', html: fixture.html } },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 1000 });
    const read = async (openPage: () => Promise<AdapterPage>): Promise<readonly string[]> => {
      const page = await openPage();

      try {
        const response = await page.load(PLATFORM_URL);

        expect(response.status).toBe(200);

        return postingIds(await page.html());
      } finally {
        await page.close();
      }
    };

    expect(await read(factory.openPage)).toEqual(['12345', '12346']);
    expect(server.requests.map((request) => request.target)).toEqual([RESULT_LIST_PATH]);
  });

  it('exercises the timeout path of a Result_Page through the same port', async () => {
    server = await FixtureServer.start({});

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 100 });
    const page = await factory.openPage();

    await expect(page.load('https://www.stepstone.de/never-responds')).rejects.toBeInstanceOf(
      RetryableRequestError,
    );
  });
});
