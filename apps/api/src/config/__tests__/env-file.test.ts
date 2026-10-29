/**
 * Where the API_Service looks for the environment file.
 *
 * This is the failure that is invisible at runtime: a wrong path means every key is reported as
 * missing, which looks like an unfilled file rather than a lookup bug. Pinning the resolution
 * keeps the one shared `.env` at the repository root (1.12) findable from the sources and from the
 * compiled output alike, both of which sit two levels below `apps/api`.
 *
 * Requirements: 1.12.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENV_FILE_NAME, findWorkspaceRoot, loadEnvFile, resolveEnvFilePath } from '../env-file';

describe('findWorkspaceRoot', () => {
  it('finds the repository root from a directory inside apps/api', () => {
    const root = findWorkspaceRoot(__dirname);

    expect(root).not.toBeNull();
    expect(existsSync(join(root ?? '', 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(join(root ?? '', '.env.example'))).toBe(true);
  });

  it('returns null where no workspace marker exists above the directory', () => {
    expect(findWorkspaceRoot('/')).toBeNull();
  });
});

describe('resolveEnvFilePath', () => {
  it('points at the environment file next to the workspace marker', () => {
    expect(resolveEnvFilePath(__dirname)).toBe(join(findWorkspaceRoot(__dirname) ?? '', '.env'));
    expect(ENV_FILE_NAME).toBe('.env');
  });
});

describe('loadEnvFile', () => {
  it('reports an absent file instead of throwing, leaving the key check to say what is missing', () => {
    const result = loadEnvFile(join(__dirname, 'this-file-does-not-exist.env'));

    expect(result.loaded).toBe(false);
    expect(result.path).toContain('this-file-does-not-exist.env');
  });
});
