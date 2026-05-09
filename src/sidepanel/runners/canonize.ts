// Canonize runner — no LLM. Reads sheet rows, hands them to the
// canonizer service which owns parse → classify → 3-pass UniProt
// resolve → rewrite, then writes back the changed rows.

import type { Log } from '../services/log';
import {
  batchUpdateValues,
  getSheetName,
  getValues,
  quoteSheet,
} from '../services/sheets';
import { clampRowRange, type RowRange } from '../services/sheetRows';
import {
  createCanonizer,
  REACTION_LAYOUT,
} from '../services/canonizer';
import { createHttpUniprotAdapter } from '../services/canonizer/adapters/uniprotHttp';
import { createRealClock } from '../services/canonizer/adapters/clockReal';
import { mapCanonizerEventToLog } from './canonizerLog';

export type { RowRange };

export interface CanonizeInput {
  spreadsheetId: string;
  gid: string;
  range: RowRange | null;
  log: Log;
  signal: AbortSignal;
}

export interface CanonizeReport {
  uniqueEntities: number;
  skippedSmallMolecules: number;
  resolved: number;
  noMatch: number;
  ambiguous: number;
  rowsUpdated: number;
  totalRowsInRange: number;
}

export async function runCanonize(
  input: CanonizeInput,
): Promise<CanonizeReport> {
  const { log, signal } = input;
  log.append('init', 'Canonize starting');

  // 1. Read sheet rows (A..F is enough; G..L untouched).
  const sheetName = await getSheetName(input.spreadsheetId, input.gid);
  const sheetRef = quoteSheet(sheetName);
  const allRows = await getValues(input.spreadsheetId, `${sheetRef}!A:F`);
  log.append('info', `read ${allRows.length} rows from "${sheetName}"`);

  const { startRow, endRow } = clampRowRange(allRows, input.range);
  if (endRow < startRow) {
    log.append('warn', `empty range, nothing to do`);
    return {
      uniqueEntities: 0,
      skippedSmallMolecules: 0,
      resolved: 0,
      noMatch: 0,
      ambiguous: 0,
      rowsUpdated: 0,
      totalRowsInRange: 0,
    };
  }

  const clock = createRealClock();
  const uniprot = createHttpUniprotAdapter({
    fetch: globalThis.fetch.bind(globalThis),
    clock,
  });
  const canonizer = createCanonizer({
    uniprot,
    layout: REACTION_LAYOUT,
    clock,
    onEvent: (e) => mapCanonizerEventToLog(log, e),
  });

  const { rewritten, report } = await canonizer.canonize({
    rows: allRows,
    range: { startRow, endRow },
    signal,
  });

  const updates = rewritten
    .filter((r) => r.changed)
    .map((r) => ({
      range: `${sheetRef}!A${r.rowIndex}:F${r.rowIndex}`,
      values: [r.after.slice(0, 6) as string[]],
    }));

  if (updates.length > 0) {
    log.append('info', `writing ${updates.length} updated rows…`);
    await batchUpdateValues(input.spreadsheetId, updates);
    log.append('ok', `${updates.length} rows updated`);
  } else {
    log.append('info', 'no rows changed (no resolved replacements applied)');
  }

  return {
    uniqueEntities: report.uniqueEntities,
    skippedSmallMolecules: report.skippedSmallMolecules.length,
    resolved: report.resolved,
    noMatch: report.noMatch.length,
    ambiguous: report.ambiguous.length,
    rowsUpdated: updates.length,
    totalRowsInRange: endRow - startRow + 1,
  };
}
