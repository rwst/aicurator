// Small adapter mapping ResolverEvents to per-runner log lines. Pure
// function — placed alongside the runners that consume it so the
// refResolver module stays UI-free.

import type { Log } from '../services/log';
import type { ResolverEvent } from '../services/refResolver';

export function mapResolverEventToLog(log: Log, e: ResolverEvent): void {
  switch (e.kind) {
    case 'started':
      log.append('info', `resolving ${e.total} reference(s)…`);
      return;
    case 'strategy-started':
      if (e.candidates > 0) {
        log.append('info', `${e.name}: ${e.candidates} candidate(s)`);
      }
      return;
    case 'progress':
      // Progress events are too chatty for the side-panel log. They
      // exist for tests and a future progress UI.
      return;
    case 'strategy-complete':
      if (e.candidates > 0) {
        log.append(
          'ok',
          `${e.name}: ${e.resolved}/${e.candidates} resolved in ${(e.elapsedMs / 1000).toFixed(1)}s`,
        );
      }
      return;
    case 'transient-error':
      log.append(
        'warn',
        e.refId
          ? `${e.name} (ref ${e.refId}): ${e.message}`
          : `${e.name}: ${e.message}`,
      );
      return;
    case 'finished':
      // Caller uses summary directly; no separate log line needed —
      // the Extract runner emits the consolidated audit line.
      return;
  }
}
