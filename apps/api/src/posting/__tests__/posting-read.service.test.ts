/**
 * The two context values one page read needs, and where they come from (8.10, 8.11, 10.9, 11.2,
 * 11.3).
 *
 * `FindPostingPageInput` requires the Commute_Threshold in force and the identifier of the most
 * recently completed Scrape_Run, and neither is sent by the client. What is asserted here is that
 * both reach the repository and that they are read from the right place:
 *
 * - the threshold from `AppConfigService` and on *every* request, because the user can change it and
 *   a stored Job_Posting then changes its reachability class without being written (8.11);
 * - the reference run from the request's own context, so the grouping of a page and the marking of
 *   its rows cannot be derived from two different runs (11.2, 11.3).
 *
 * Requirements: 8.10, 8.11, 10.9, 11.2, 11.3.
 */

import { describe, expect, it } from 'vitest';

import type { JobPosting } from '../../prisma/prisma.types';
import {
  DEFAULT_POSTING_SORT,
  type FindPostingPageInput,
  POSTING_PAGE_SIZE,
} from '../posting-page-query';
import type { PostingReadContext } from '../posting-read.context';
import {
  type CommuteThresholdReader,
  type PostingPageReader,
  PostingReadService,
} from '../posting-read.service';

/** A stand-in repository that records what it was asked and answers with an empty page. */
const createReader = (
  posting: JobPosting | null = null,
): PostingPageReader & {
  readonly inputs: FindPostingPageInput[];
  readonly ids: string[];
} => {
  const inputs: FindPostingPageInput[] = [];
  const ids: string[] = [];

  return {
    inputs,
    ids,
    findPage: (input) => {
      inputs.push(input);

      return Promise.resolve({ items: [], totalCount: 0, pageCount: 0, page: input.page });
    },
    findById: (id) => {
      ids.push(id);

      return Promise.resolve(posting);
    },
  };
};

/** A configuration whose Commute_Threshold can change between two reads (8.10, 8.14). */
const createConfig = (minutes: number): CommuteThresholdReader & { set(value: number): void } => {
  let commuteThresholdMinutes = minutes;

  return {
    get commuteThresholdMinutes() {
      return commuteThresholdMinutes;
    },
    set(value: number) {
      commuteThresholdMinutes = value;
    },
  };
};

/** A request context that counts how often the reference run was asked for. */
const createContext = (
  latestCompletedRunId: string | null,
): PostingReadContext & { readonly lookups: () => number } => {
  let lookups = 0;

  return {
    lookups: () => lookups,
    latestCompletedRunId: () => {
      lookups += 1;

      return Promise.resolve(latestCompletedRunId);
    },
    firstSeenRun: () => Promise.resolve(null),
  };
};

const request = {
  filter: {},
  sort: DEFAULT_POSTING_SORT,
  page: 1,
  pageSize: POSTING_PAGE_SIZE,
};

describe('PostingReadService.page', () => {
  it('passes the configured Commute_Threshold and the reference run to the repository', async () => {
    const reader = createReader();
    const service = new PostingReadService(reader, createConfig(45));
    const context = createContext('run-7');

    await service.page(request, context);

    expect(reader.inputs).toHaveLength(1);
    expect(reader.inputs[0]?.commuteThresholdMinutes).toBe(45);
    expect(reader.inputs[0]?.latestCompletedRunId).toBe('run-7');
    expect(context.lookups()).toBe(1);
  });

  it('reads the threshold again on the next request (8.11, 8.14)', async () => {
    const reader = createReader();
    const config = createConfig(60);
    const service = new PostingReadService(reader, config);

    await service.page(request, createContext(null));
    config.set(30);
    await service.page(request, createContext(null));

    expect(reader.inputs.map((input) => input.commuteThresholdMinutes)).toEqual([60, 30]);
  });

  it('passes the filter, the sorting and the window through unchanged (10.5, 10.7, 10.9)', async () => {
    const reader = createReader();
    const service = new PostingReadService(reader, createConfig(60));

    await service.page(
      {
        filter: { platforms: ['INDEED'] },
        sort: { field: 'PUBLISHED_AT', direction: 'ASC' },
        page: 3,
        pageSize: 10,
      },
      createContext('run-1'),
    );

    expect(reader.inputs[0]).toEqual({
      filter: { platforms: ['INDEED'] },
      sort: { field: 'PUBLISHED_AT', direction: 'ASC' },
      page: 3,
      pageSize: 10,
      commuteThresholdMinutes: 60,
      latestCompletedRunId: 'run-1',
    });
  });

  it('passes a Posting_Store without a completed Scrape_Run through as null (11.6)', async () => {
    const reader = createReader();
    const service = new PostingReadService(reader, createConfig(60));

    await service.page(request, createContext(null));

    expect(reader.inputs[0]?.latestCompletedRunId).toBeNull();
  });
});

describe('PostingReadService.byId', () => {
  it('answers with the stored Job_Posting (10.8)', async () => {
    const stored = { id: 'posting-1' } as JobPosting;
    const reader = createReader(stored);
    const service = new PostingReadService(reader, createConfig(60));

    await expect(service.byId('posting-1')).resolves.toBe(stored);
    expect(reader.ids).toEqual(['posting-1']);
  });

  it('answers an unknown identifier with null rather than with a rejection (10.8)', async () => {
    const service = new PostingReadService(createReader(null), createConfig(60));

    await expect(service.byId('missing')).resolves.toBeNull();
  });
});
