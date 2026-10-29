/**
 * The listening configuration of the API_Service.
 *
 * The host is the interesting part: the Job_Tool runs on one machine without authentication, so a
 * listener on anything other than the loopback interface would expose a GraphQL endpoint that can
 * start browser automation (1.16). Pinning it in a test makes a later change a deliberate one.
 *
 * The port is no longer asserted here. It comes from the validated environment file, so an
 * unusable `API_PORT` is reported by name and stops the startup (1.15) instead of falling back to
 * a default — the range that holds for it is covered in `src/config/__tests__/env.schema.test.ts`.
 *
 * Requirements: 1.16.
 */

import { describe, expect, it } from 'vitest';

import { API_HOST } from '../main';

describe('API_Service listener', () => {
  it('binds to the loopback interface only', () => {
    expect(API_HOST).toBe('127.0.0.1');
  });
});
