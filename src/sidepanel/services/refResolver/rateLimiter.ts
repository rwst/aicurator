// Token-bucket rate limiter. Concrete, parameterized on a Clock port —
// real production code runs under virtual time in tests, so the
// "≤ratePerSec acquires per sliding 1000ms window" invariant is a
// millisecond-precision assertion against the actual algorithm rather
// than against a mock.
//
// Algorithm: the bucket holds at most `burst` tokens; each acquire()
// consumes one. Tokens regenerate continuously at `ratePerSec` per
// second (i.e. one token per `1000/ratePerSec` ms). When the bucket is
// empty, acquire() sleeps until the deficit refills.

import type { Clock } from './ports';

export interface RateLimiter {
  /** Wait for one token, then return. Throws the AbortError from
   *  `signal` if cancelled while waiting. */
  acquire(signal: AbortSignal): Promise<void>;
}

export interface TokenBucketOptions {
  ratePerSec: number;
  /** Max tokens the bucket can hold (default = ratePerSec). */
  burst?: number;
  clock: Clock;
}

export function createTokenBucketLimiter(
  opts: TokenBucketOptions,
): RateLimiter {
  const { ratePerSec, clock } = opts;
  if (ratePerSec <= 0) {
    throw new Error('ratePerSec must be > 0');
  }
  const burst = opts.burst ?? ratePerSec;
  const tokenInterval = 1000 / ratePerSec;

  // We track the "next available token" timestamp rather than counting
  // tokens directly. Conceptually equivalent and avoids a bucket fill
  // loop. Initialized to clock.now() − burst*interval so the first
  // `burst` acquires fire immediately.
  let nextAvailable = clock.now() - burst * tokenInterval;

  // Serialize acquire() calls — without this, parallel callers would
  // each compute their own `nextAvailable` snapshot and burst beyond
  // the budget.
  let tail: Promise<void> = Promise.resolve();

  return {
    acquire(signal: AbortSignal): Promise<void> {
      const ours = tail.then(async () => {
        if (signal.aborted) {
          // Re-throw whatever AbortSignal.reason carries (DOMException).
          throw signal.reason ?? new DOMException('aborted', 'AbortError');
        }
        const now = clock.now();
        const waitMs = Math.max(0, nextAvailable + tokenInterval - now);
        // Reserve our slot — anyone behind us computes off this update.
        nextAvailable = Math.max(now, nextAvailable + tokenInterval);
        if (waitMs > 0) {
          await clock.sleep(waitMs, signal);
        }
      });
      // Don't propagate our rejection downstream — successor acquires
      // are independent.
      tail = ours.catch(() => undefined);
      return ours;
    },
  };
}
