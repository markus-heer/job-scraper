/**
 * The command port of the Start_Script.
 *
 * These are the only tests that start a real child process, and they start `node` itself: no Git
 * command, no install and no download, so the suite stays offline and leaves the lockfile and the
 * working tree untouched.
 */

import { describe, expect, it } from 'vitest';

import {
  CHILD_ENVIRONMENT_OVERRIDES,
  createCommandRunner,
  DETAIL_LENGTH_LIMIT,
  extractFailureDetail,
} from '../command-runner.mjs';
import { completeResult } from './fake-command-runner.mjs';

const run = createCommandRunner({ cwd: process.cwd() });

/** A result carrying the given captured output, without running anything. */
function captured({ stdout = '', stderr = '' }) {
  return completeResult({ command: 'git', args: ['pull'] }, { code: 1, stdout, stderr });
}

describe('createCommandRunner', () => {
  it('captures the output of a successful command instead of printing it', async () => {
    const result = await run({ command: process.execPath, args: ['--version'] });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\./);
    expect(result.spawnFailed).toBe(false);
  });

  it('reports a non-zero exit code as a result rather than as an exception', async () => {
    const result = await run({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("kaputt"); process.exit(3);'],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe('kaputt');
  });

  it('reports a program that is not installed as a result', async () => {
    const result = await run({ command: 'kein-programm-dieses-namens', args: [] });

    expect(result.ok).toBe(false);
    expect(result.spawnFailed).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stderr).not.toBe('');
  });

  it('kills a command that exceeds its timeout and says so', async () => {
    const result = await run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000);'],
      timeoutMs: 250,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('forces a stable, non-interactive child environment', async () => {
    const result = await run({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write([process.env.LC_ALL, process.env.GIT_TERMINAL_PROMPT].join("|"));',
      ],
    });

    expect(result.stdout).toBe(
      `${CHILD_ENVIRONMENT_OVERRIDES.LC_ALL}|${CHILD_ENVIRONMENT_OVERRIDES.GIT_TERMINAL_PROMPT}`,
    );
  });

  it('answers a command that waits for input instead of hanging on it', async () => {
    const result = await run({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(9));'],
      timeoutMs: 5000,
    });

    expect(result.code).toBe(9);
    expect(result.timedOut).toBe(false);
  });
});

describe('extractFailureDetail', () => {
  it('prefers the line that names the cause over the hints before it', () => {
    const detail = extractFailureDetail(
      captured({
        stderr:
          'hint: You have divergent branches.\nhint: Run git config pull.ff only.\nfatal: Need to specify how to reconcile divergent branches.\n',
      }),
    );

    expect(detail).toBe('fatal: Need to specify how to reconcile divergent branches.');
  });

  it('falls back to the first line when no line names a cause', () => {
    expect(extractFailureDetail(captured({ stdout: 'Nothing to do\nreally nothing\n' }))).toBe(
      'Nothing to do',
    );
  });

  it('reads stderr before stdout', () => {
    expect(extractFailureDetail(captured({ stdout: 'aus stdout', stderr: 'aus stderr' }))).toBe(
      'aus stderr',
    );
  });

  it('reports no detail for a command that printed nothing', () => {
    expect(extractFailureDetail(captured({}))).toBeNull();
  });

  it('strips the colour sequences of a captured output', () => {
    const coloured = `${String.fromCharCode(27)}[31mfatal: kaputt${String.fromCharCode(27)}[0m`;

    expect(extractFailureDetail(captured({ stderr: coloured }))).toBe('fatal: kaputt');
  });

  it('shortens a single long line to the quoting limit', () => {
    const detail = extractFailureDetail(captured({ stderr: 'x'.repeat(DETAIL_LENGTH_LIMIT + 50) }));

    expect(detail).toHaveLength(DETAIL_LENGTH_LIMIT + 1);
    expect(detail.endsWith('…')).toBe(true);
  });
});
