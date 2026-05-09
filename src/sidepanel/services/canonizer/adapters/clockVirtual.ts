// Virtual clock for canonizer tests. Same shape as the refResolver's
// virtual clock plus a withTimeout method that runs in zero real time.

import type { Clock } from '../ports';
import { runWithTimeout } from './clockReal';

interface PendingSleep {
  deadline: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

export interface VirtualClock extends Clock {
  /** Move virtual time forward by `ms`. Sleeps whose deadline now lies
   *  in the past resolve in order. */
  advance(ms: number): Promise<void>;
  /** Drain all pending sleeps and microtasks until quiescent. */
  runAll(maxSteps?: number): Promise<void>;
  /** Number of sleeps currently waiting. */
  pending(): number;
}

export function createVirtualClock(initial = 0): VirtualClock {
  let current = initial;
  const sleeps: PendingSleep[] = [];

  function fireDue(): boolean {
    let fired = false;
    sleeps.sort((a, b) => a.deadline - b.deadline);
    while (sleeps.length > 0 && sleeps[0].deadline <= current) {
      const s = sleeps.shift()!;
      s.signal.removeEventListener('abort', s.onAbort);
      s.resolve();
      fired = true;
    }
    return fired;
  }

  async function flushMicrotasks(): Promise<void> {
    type Yielder = (cb: () => void) => void;
    const setImm = (globalThis as unknown as { setImmediate?: Yielder })
      .setImmediate;
    const yielder =
      typeof setImm === 'function'
        ? () => new Promise<void>((r) => setImm(r))
        : () => new Promise<void>((r) => setTimeout(r, 0));
    await yielder();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  const clock: VirtualClock = {
    now: () => current,
    sleep(ms, signal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
          return;
        }
        const sleeper: PendingSleep = {
          deadline: current + ms,
          resolve,
          reject,
          signal,
          onAbort: () => {
            const idx = sleeps.indexOf(sleeper);
            if (idx >= 0) sleeps.splice(idx, 1);
            reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
          },
        };
        signal.addEventListener('abort', sleeper.onAbort);
        sleeps.push(sleeper);
      });
    },
    withTimeout<T>(
      ms: number,
      parent: AbortSignal | undefined,
      body: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      return runWithTimeout(clock, ms, parent, body);
    },
    async advance(ms): Promise<void> {
      current += ms;
      fireDue();
      await flushMicrotasks();
    },
    async runAll(maxSteps = 1000): Promise<void> {
      for (let step = 0; step < maxSteps; step += 1) {
        await flushMicrotasks();
        if (sleeps.length === 0) return;
        const next = sleeps.reduce(
          (m, s) => Math.min(m, s.deadline),
          Infinity,
        );
        if (next === Infinity) return;
        if (next > current) current = next;
        if (!fireDue()) return;
      }
      throw new Error(
        'VirtualClock.runAll: did not quiesce within maxSteps',
      );
    },
    pending: () => sleeps.length,
  };
  return clock;
}
