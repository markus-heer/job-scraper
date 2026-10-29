/**
 * The counting semaphore behind the concurrency bound of Requirement 13.9: at most as many holders at
 * a time as there are permits, permits handed out in arrival order, and no permit lost on an error, a
 * double release or a cancellation (the deadlock-free path).
 *
 * The exhaustive FOR ALL version of the bound is Property 12 (task 7.5); these are the examples and
 * edge cases.
 */

import { describe, expect, it, vi } from 'vitest';

import { Semaphore } from '../semaphore.js';

/** Lets every already-scheduled microtask and timer callback run before the assertions continue. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('Semaphore', () => {
  describe('construction', () => {
    it('starts with every permit free', () => {
      const semaphore = new Semaphore(4);

      expect(semaphore.permits).toBe(4);
      expect(semaphore.availablePermits).toBe(4);
      expect(semaphore.waitingCount).toBe(0);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects the permit count %s', (permits) => {
      expect(() => new Semaphore(permits)).toThrow(RangeError);
    });
  });

  describe('acquire', () => {
    it('grants permits up to the permit count without waiting', async () => {
      const semaphore = new Semaphore(4);

      await semaphore.acquire();
      await semaphore.acquire();
      await semaphore.acquire();
      await semaphore.acquire();

      expect(semaphore.availablePermits).toBe(0);
      expect(semaphore.waitingCount).toBe(0);
    });

    it('parks a caller once every permit is held and grants it on release', async () => {
      const semaphore = new Semaphore(1);
      const release = await semaphore.acquire();

      let granted = false;
      const pending = semaphore.acquire().then(() => {
        granted = true;
      });

      await flush();
      expect(granted).toBe(false);
      expect(semaphore.waitingCount).toBe(1);

      release();
      await pending;

      expect(granted).toBe(true);
      expect(semaphore.waitingCount).toBe(0);
    });

    it('grants the freed permit in arrival order', async () => {
      const semaphore = new Semaphore(1);
      let release = await semaphore.acquire();
      const order: number[] = [];

      const waiters = [1, 2, 3].map((position) =>
        semaphore.acquire().then((nextRelease) => {
          order.push(position);

          return nextRelease;
        }),
      );

      for (const waiter of waiters) {
        release();
        release = await waiter;
      }

      expect(order).toEqual([1, 2, 3]);
    });

    it('hands a permit back exactly once even when the release is called repeatedly', async () => {
      const semaphore = new Semaphore(2);
      const release = await semaphore.acquire();

      release();
      release();
      release();

      expect(semaphore.availablePermits).toBe(2);
    });
  });

  describe('run', () => {
    it('never lets more tasks run at once than there are permits', async () => {
      const semaphore = new Semaphore(4);
      let running = 0;
      let maxRunning = 0;

      await Promise.all(
        Array.from({ length: 20 }, (_unused, index) =>
          semaphore.run(async () => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);

            await new Promise<void>((resolve) => {
              setTimeout(resolve, index % 3);
            });

            running -= 1;
          }),
        ),
      );

      expect(maxRunning).toBe(4);
      expect(running).toBe(0);
      expect(semaphore.availablePermits).toBe(4);
      expect(semaphore.waitingCount).toBe(0);
    });

    it('returns the result of the task', async () => {
      const semaphore = new Semaphore(1);

      await expect(semaphore.run(() => 'STEPSTONE')).resolves.toBe('STEPSTONE');
    });

    it('hands the permit back when the task rejects, so later tasks still run', async () => {
      const semaphore = new Semaphore(1);
      const failing = new Error('adapter crashed');

      await expect(
        semaphore.run(() => {
          throw failing;
        }),
      ).rejects.toBe(failing);

      expect(semaphore.availablePermits).toBe(1);
      await expect(semaphore.run(() => 'next adapter')).resolves.toBe('next adapter');
    });
  });

  describe('cancellation', () => {
    it('rejects an acquire with an already aborted signal without taking a permit', async () => {
      const semaphore = new Semaphore(4);
      const controller = new AbortController();
      controller.abort(new Error('cancelled by user'));

      await expect(semaphore.acquire(controller.signal)).rejects.toThrow('cancelled by user');
      expect(semaphore.availablePermits).toBe(4);
    });

    it('rejects a waiting acquire on abort and leaves the permit to the next waiter', async () => {
      const semaphore = new Semaphore(1);
      const release = await semaphore.acquire();
      const controller = new AbortController();

      const cancelled = semaphore.acquire(controller.signal);
      const queued = semaphore.acquire();

      await flush();
      expect(semaphore.waitingCount).toBe(2);

      controller.abort(new Error('cancelled by time limit'));

      await expect(cancelled).rejects.toThrow('cancelled by time limit');
      expect(semaphore.waitingCount).toBe(1);

      release();

      await expect(queued).resolves.toBeTypeOf('function');
      expect(semaphore.availablePermits).toBe(0);
    });

    it('drops the abort listener once the permit is granted', async () => {
      const semaphore = new Semaphore(1);
      const release = await semaphore.acquire();
      const controller = new AbortController();
      const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');

      const pending = semaphore.acquire(controller.signal);
      release();
      const grantedRelease = await pending;

      expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

      // A later abort must not disturb a permit that is already held.
      controller.abort(new Error('cancelled by user'));
      grantedRelease();

      expect(semaphore.availablePermits).toBe(1);
    });
  });
});
