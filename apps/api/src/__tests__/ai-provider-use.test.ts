/**
 * Requirement 15.17: the AI_Provider is used for the relevance assessment and for the work location
 * normalization of 8.6, and for nothing else.
 *
 * Every other criterion of Requirement 15 is a statement about one request and is asserted where that
 * request is built. This one is a statement about the *whole* API_Service — it forbids a use that
 * does not exist yet — so no single unit test can carry it. What it comes down to in code is which
 * modules reach the Anthropic surface at all, and that is readable from the source: the host and the
 * credential are each declared in exactly one place, so every use of the AI_Provider has to name one
 * of them.
 *
 * This file is therefore an architecture test over the import graph rather than over behaviour. It is
 * cheap, it needs nothing but the file system, and it fails by naming the file that added a third
 * use — which is the only way a requirement of this shape can be enforced at all. The alternative, a
 * reviewer remembering 15.17, is what let the second permitted use sit unimplemented through
 * seventeen tasks.
 *
 * ## Why two call sites and not one
 *
 * Until task 25.2 there was one. The second is the Location_Normalizer of 8.6, which this very
 * requirement permits: `AnthropicLocationNormalizer` imports the host, the path, the version header
 * and the `ANTHROPIC_FETCH` seam from the relevance assessor instead of restating them, so the two
 * uses share one HTTP surface and this test has one list to check rather than two.
 *
 * Requirements: 15.17, 14.9, 8.6.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The root of the API_Service source, resolved from this file rather than from the process cwd.
 *
 * `__dirname` and not `import.meta.dirname`: this package compiles to CommonJS, so the latter is a
 * type error here even though Vitest would resolve it.
 */
const SOURCE_ROOT = join(__dirname, '..');

/**
 * The identifiers that mark a use of the AI_Provider.
 *
 * The host and the credential, which is the whole outbound surface: a request cannot be sent without
 * the first and cannot be authorised without the second, so a module that reaches Anthropic names at
 * least one of them. `ANTHROPIC_MODEL` is deliberately not in the list — a model *name* is
 * configuration and gets logged, so it appears in places that send nothing.
 */
const AI_PROVIDER_MARKERS: readonly string[] = ['ANTHROPIC_API_BASE_URL', 'anthropicApiKey'];

/**
 * The files 15.17 permits to reach the AI_Provider, each with the use that permits it.
 *
 * Paths relative to `apps/api/src`, with POSIX separators. A file not in this list that names one of
 * the markers is a third use of the AI_Provider, which 15.17 forbids — or a use in a place that has
 * no business sending the request, which is the same defect from the other side.
 */
const PERMITTED_CALL_SITES: Readonly<Record<string, string>> = {
  // Use 1 of 15.17: the relevance assessment (15.1 to 15.4).
  'relevance/anthropic-relevance.assessor.ts': 'the relevance assessment of 15.1',
  // Use 2 of 15.17: the work location normalization (8.6, 8.7).
  'commute/anthropic-location.normalizer.ts': 'the work location normalization of 8.6',
  // Not a use: the configuration declaration the two read their credential from, and the validation
  // and logging views over it, which mask it rather than send it (14.9).
  'config/env.schema.ts': 'the declaration of the key, including SECRET_ENV_KEYS',
  // Not a use either: the masking that keeps the key out of the Log_Stream (14.9). It reads the
  // value in order never to print it, which is the opposite of sending a request with it.
  'log-stream/secret-masking.ts': 'the Log_Stream masking of the key',
  // Not a use: the switch that decides whether either provider is constructed at all (15.9).
  'relevance/relevance.service.ts': 'relevanceDisabledReasonOf, which reads the key to decide',
};

/** Whether a path is a TypeScript source file this test should read. */
const isSourceFile = (path: string): boolean => path.endsWith('.ts') || path.endsWith('.tsx');

/** Every TypeScript file under a directory, recursively, as paths relative to {@link SOURCE_ROOT}. */
const sourceFilesOf = (directory: string): readonly string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      return sourceFilesOf(path);
    }

    return isSourceFile(path) ? [relative(SOURCE_ROOT, path).split('\\').join('/')] : [];
  });

/**
 * Which marker each file names, excluding the test files.
 *
 * A test may name anything: the suites of both providers construct them with a stub key, and a test
 * that could not would be a test that cannot drive the request path. 15.17 is about what the running
 * API_Service does.
 */
const callSites = (): ReadonlyMap<string, readonly string[]> => {
  const found = new Map<string, readonly string[]>();

  for (const file of sourceFilesOf(SOURCE_ROOT)) {
    if (file.includes('__tests__/') || file.includes('/testing/')) {
      continue;
    }

    const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
    const markers = AI_PROVIDER_MARKERS.filter((marker) => source.includes(marker));

    if (markers.length > 0) {
      found.set(file, markers);
    }
  }

  return found;
};

describe('the AI_Provider is used for two things and nothing else (15.17)', () => {
  it('names the host or the credential in exactly the permitted files', () => {
    const unexpected = [...callSites().keys()].filter(
      (file) => !Object.hasOwn(PERMITTED_CALL_SITES, file),
    );

    // A failure here is a third use of the AI_Provider, or a use somewhere that should not be
    // sending the request. Either way 15.17 wants a decision, not a longer list: add the file to
    // `PERMITTED_CALL_SITES` only together with the criterion that permits it.
    expect(unexpected).toEqual([]);
  });

  it('still has every permitted call site, so the list cannot rot', () => {
    const found = callSites();

    // The other direction: a permitted entry whose file stopped naming the marker is a stale
    // exception, and a stale exception is how a list like this quietly stops meaning anything.
    for (const file of Object.keys(PERMITTED_CALL_SITES)) {
      expect(found.has(file), `${file} no longer names an AI_Provider marker`).toBe(true);
    }
  });

  it('declares the host in one place, which both permitted uses take it from', () => {
    const hostDeclarations = [...callSites().entries()].filter(([, markers]) =>
      markers.includes('ANTHROPIC_API_BASE_URL'),
    );

    // The relevance assessor declares the constant; the Location_Normalizer imports it. A second
    // declaration would be a second place to audit against 15.17 and a second place for a credential
    // to end up in a URL (14.9).
    expect(hostDeclarations.map(([file]) => file).sort()).toEqual([
      'commute/anthropic-location.normalizer.ts',
      'relevance/anthropic-relevance.assessor.ts',
    ]);

    const assessor = readFileSync(
      join(SOURCE_ROOT, 'relevance/anthropic-relevance.assessor.ts'),
      'utf8',
    );
    const normalizer = readFileSync(
      join(SOURCE_ROOT, 'commute/anthropic-location.normalizer.ts'),
      'utf8',
    );

    expect(assessor).toContain("export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com'");
    expect(normalizer).not.toContain('export const ANTHROPIC_API_BASE_URL');
    expect(normalizer).toContain("from '../relevance/anthropic-relevance.assessor'");
  });
});
