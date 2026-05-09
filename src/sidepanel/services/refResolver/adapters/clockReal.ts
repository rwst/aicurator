// Production Clock — Date.now / setTimeout, with abort propagation
// for sleep().

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
  };
}
