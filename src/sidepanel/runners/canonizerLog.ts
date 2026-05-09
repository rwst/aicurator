// Pure helper that maps CanonizerEvents to log lines. Lives here so the
// canonizer module stays UI-free.

import type { Log } from '../services/log';
import type { CanonizerEvent } from '../services/canonizer';

export function mapCanonizerEventToLog(log: Log, e: CanonizerEvent): void {
  switch (e.kind) {
    case 'parse-done':
      log.append(
        'info',
        `${e.uniqueNames} unique entity names in ${e.rowsScanned} rows`,
      );
      return;
    case 'classified':
      if (e.smallMolecules.length > 0) {
        log.append(
          'info',
          `skipping ${e.smallMolecules.length} likely small molecules / ions: ` +
            `${e.smallMolecules.slice(0, 8).join(', ')}` +
            `${e.smallMolecules.length > 8 ? '…' : ''}`,
        );
      }
      return;
    case 'resolve-start':
      if (e.queryable > 0) {
        log.append(
          'info',
          `querying UniProt for ${e.queryable} candidate proteins (human, reviewed-first)…`,
        );
      }
      return;
    case 'resolve-pass-end':
      log.append(
        'info',
        `${e.pass}: ${e.resolved} mapped, ${e.remaining} remaining (${(e.ms / 1000).toFixed(1)}s)`,
      );
      return;
    case 'resolve-done':
      log.append(
        'ok',
        `UniProt resolved in ${(e.ms / 1000).toFixed(1)}s · ${e.resolved} mapped · ` +
          `${e.noMatch.length} no-match · ${e.ambiguous.length} ambiguous`,
      );
      for (const n of e.noMatch) {
        log.append('warn', `no UniProt match for "${n}" — leaving as is`);
      }
      for (const a of e.ambiguous) {
        log.append(
          'warn',
          `ambiguous: "${a}" matched multiple reviewed-human proteins — leaving as is`,
        );
      }
      return;
    case 'rewrite-done':
      // Caller-side log already mentions row writes; nothing to add.
      return;
    case 'parse-start':
      return;
  }
}
