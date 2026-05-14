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
      if (e.replacements.size > 0) {
        const pairs = [...e.replacements]
          .map(([from, to]) => `${from} → ${to}`)
          .join('; ');
        log.append('ok', `replaced: ${pairs}`);
      }
      if (e.noMatch.length > 0) {
        log.append('warn', `no UniProt match: ${e.noMatch.join(', ')}`);
      }
      if (e.ambiguous.length > 0) {
        log.append(
          'warn',
          `ambiguous (multiple reviewed-human proteins): ${e.ambiguous.join(', ')}`,
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
