/**
 * The in-process lock the single-run guarantee rests on.
 *
 * The coordinator may not create a second Scrape_Run while one is running (12.1, 12.5), and the
 * check and the insert are separated by an `await`. So the property that matters here is narrow and
 * worth asserting on its own: critical sections never overlap, they run in call order, and a
 * rejected section leaves the lock usable — a Scrape_Run the Posting_Store refused to create (12.13)
 * must not block every later start.
 *
 * Requirements: 12.1, 12.5, 12.13.
 */

import { describe, expect, it } from 'vitest';

import { AsyncMutex } from '../async-mutex';

/** A deferred, so a test can decide when a critical section finishes. */
const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

describe('AsyncMutex', () => {
  it('runs critical sections one at a time, in call order', async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];

    const section = async (name: string): Promise<void> => {
      events.push(`${name}:enter`);
      await Promise.resolve();
      events.push(`${name}:leave`);
    };

    await Promise.all([
      mutex.runExclusive(() => section('first')),
      mutex.runExclusive(() => section('second')),
      mutex.runExclusive(() => section('third')),
    ]);

    expect(events).toEqual([
      'first:enter',
      'first:leave',
      'second:enter',
      'second:leave',
      'third:enter',
      'third:leave',
    ]);
  });

  it('hands back what the critical section returned', async () => {
    const mutex = new AsyncMutex();

    await expect(mutex.runExclusive(() => 'value')).resolves.toBe('value');
    await expect(mutex.runExclusive(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('reports the lock as held while a section is pending', async () => {
    const mutex = new AsyncMutex();
    const gate = deferred();

    expect(mutex.locked).toBe(false);

    const pending = mutex.runExclusive(() => gate.promise);

    expect(mutex.locked).toBe(true);

    gate.resolve();
    await pending;

    expect(mutex.locked).toBe(false);
  });

  it('keeps the lock usable after a rejected section (12.13)', async () => {
    const mutex = new AsyncMutex();
    const failure = new Error('Die Erstellung des Suchlaufs wurde abgelehnt.');

    await expect(
      mutex.runExclusive(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(mutex.runExclusive(() => 'next caller runs')).resolves.toBe('next caller runs');
    expect(mutex.locked).toBe(false);
  });

  it('lets a later section observe what an earlier one wrote', async () => {
    const mutex = new AsyncMutex();
    let active: string | null = null;
    const observed: (string | null)[] = [];

    const claim = async (name: string): Promise<void> => {
      observed.push(active);
      await Promise.resolve();
      active = name;
    };

    await Promise.all([
      mutex.runExclusive(() => claim('first')),
      mutex.runExclusive(() => claim('second')),
    ]);

    // The second section sees the first one's write, which is exactly what stops two near
    // simultaneous starts from both observing "no run is active".
    expect(observed).toEqual([null, 'first']);
  });
});
