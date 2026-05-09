// Virtual clock for tests. Acts as the Clock port plus the conductor
// that drives time forward.
//
// Usage:
//   const clock = createVirtualClock();
//   const promise = doStuff(clock);          // schedules sleeps
//   await clock.runAll();                     // drains microtasks +
//                                             // fires sleeps in order
//   await promise;                            // resolved
//
// `advance(ms)` moves time forward by `ms` and fires every sleep whose
// deadline has passed; `runAll()` repeatedly drains pending sleeps (and
// any sleeps newly scheduled by their resolutions) until no work
// remains.

import type { Clock } from '../ports';

interface PendingSleep {
  deadline: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

export interface VirtualClock extends Clock {
  /** Move virtual time forward by `ms`. Sleeps whose deadline now lies
   *  in the past resolve in order. Each resolution may schedule new
   *  sleeps (or other awaiters); call `runAll()` to drain those. */
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
    // Sort by deadline, fire all whose deadline ≤ current.
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
    // Drain the microtask queue completely. We yield to the event-loop
    // I/O phase via setImmediate (node) or setTimeout (browsers), then
    // do a small Promise.resolve cascade to mop up anything queued by
    // the I/O turn. This is the most reliable cross-environment
    // pattern; pure Promise.resolve loops can miss deep .then chains.
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

  return {
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
        'VirtualClock.runAll: did not quiesce within maxSteps — likely an infinite loop',
      );
    },
    pending: () => sleeps.length,
  };
}
