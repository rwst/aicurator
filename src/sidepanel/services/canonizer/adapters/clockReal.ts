// Production Clock for the canonizer — Date.now / setTimeout, with
// abort propagation for sleep() and withTimeout().

import type { Clock } from '../ports';

export function createRealClock(): Clock {
  return {
    now: () => Date.now(),
    sleep(ms, signal): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort);
      });
    },
    withTimeout<T>(
      ms: number,
      parent: AbortSignal | undefined,
      body: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      return runWithTimeout(this, ms, parent, body);
    },
  };
}

/** Shared withTimeout implementation. The child signal aborts when
 *  either the parent aborts or `ms` elapses on the clock; whichever
 *  triggers first wins. body() always sees `child` as the abort
 *  signal, never the parent or a raw timer. */
export async function runWithTimeout<T>(
  clock: Pick<Clock, 'sleep'>,
  ms: number,
  parent: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const child = new AbortController();
  const cleanups: (() => void)[] = [];

  if (parent) {
    if (parent.aborted) {
      child.abort(parent.reason);
    } else {
      const onParentAbort = () => child.abort(parent.reason);
      parent.addEventListener('abort', onParentAbort);
      cleanups.push(() =>
        parent.removeEventListener('abort', onParentAbort),
      );
    }
  }

  const timerCtrl = new AbortController();
  let timedOut = false;
  // Fire-and-forget — the body's await returns the result; we only
  // need the timer to abort the child signal on expiry.
  const timerPromise = clock
    .sleep(ms, timerCtrl.signal)
    .then(() => {
      timedOut = true;
      child.abort(new DOMException('timeout', 'TimeoutError'));
    })
    .catch(() => undefined);

  try {
    return await body(child.signal);
  } catch (err) {
    if (timedOut) {
      throw new DOMException(`operation timed out after ${ms}ms`, 'TimeoutError');
    }
    throw err;
  } finally {
    timerCtrl.abort();
    await timerPromise;
    for (const c of cleanups) c();
  }
}
