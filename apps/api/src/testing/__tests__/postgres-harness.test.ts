/**
 * The two promises of the integration harness that are observable without Docker.
 *
 * Both belong in the offline suite, because that is the suite that runs on every change:
 *
 * - the engine the harness tests against is the engine the Job_Tool runs against. The image tag is
 *   read out of `docker-compose.yml` instead of being repeated here, so the two cannot drift apart
 *   silently (1.10).
 * - a missing Docker daemon produces an explicit message and no substitute database (9.6). The
 *   container start itself cannot be exercised here, so what is pinned is the text a developer
 *   gets: what failed, why nothing else is used instead, and which command to run.
 *
 * Requirements: 9.6.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findWorkspaceRoot } from '../../config/env-file';
import { dockerUnavailableMessage, POSTGRES_IMAGE } from '../postgres-harness';

describe('POSTGRES_IMAGE', () => {
  it('is the image the Job_Tool runs its Posting_Store on', () => {
    const workspaceRoot = findWorkspaceRoot(__dirname);

    expect(workspaceRoot).not.toBeNull();

    const compose = readFileSync(join(workspaceRoot ?? '.', 'docker-compose.yml'), 'utf8');

    expect(compose).toContain(`image: ${POSTGRES_IMAGE}`);
  });
});

describe('dockerUnavailableMessage', () => {
  const message = dockerUnavailableMessage(new Error('connect ENOENT /var/run/docker.sock'));

  it('names the image that could not be started', () => {
    expect(message).toContain(POSTGRES_IMAGE);
  });

  it('rules out a substitute database', () => {
    expect(message).toMatch(/no fallback/i);
    expect(message).toContain('SQLite');
  });

  it('names the command that runs the integration suite and clears the unit suite', () => {
    expect(message).toContain('pnpm test:integration');
    expect(message).toContain('pnpm test');
    expect(message).toMatch(/needs no Docker/i);
  });

  it('carries the underlying failure, so the cause stays readable', () => {
    expect(message).toContain('connect ENOENT /var/run/docker.sock');
  });

  it('reads a non-Error cause as well', () => {
    expect(dockerUnavailableMessage('socket closed')).toContain('socket closed');
  });
});
