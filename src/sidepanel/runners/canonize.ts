// Canonize runner — no LLM. Reads the entity-name vocabulary from
// columns C..F, batches a single UniProt SPARQL query (human-only,
// reviewed-first), and rewrites A..F in-place.

import type { Log } from '../services/log';
import {
  batchUpdateValues,
  getSheetName,
  getValues,
  quoteSheet,
} from '../services/sheets';
import {
  parseCell,
  rewriteCell,
  rewriteFreeText,
} from '../services/entityParser';
import { resolveEntities } from '../services/uniprot';
import { isLikelySmallMolecule } from '../services/smallMolecules';

export interface RowRange {
  start: number;
  end: number;
}

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

function isSubtitle(t: string): boolean {
  return t.startsWith('## ');
}
function isGap(t: string): boolean {
  return /^\(.*\)$/.test(t.trim());
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

  // 2. Determine range.
  let startRow = 2;
  let endRow = allRows.length;
  if (input.range) {
    startRow = Math.max(2, input.range.start);
    endRow = Math.min(endRow, input.range.end);
  }
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

  // 3. Collect unique bare names from C, D, E, F.
  const bareNames = new Set<string>();
  for (let r = startRow; r <= endRow; r += 1) {
    const row = allRows[r - 1] ?? [];
    const title = row[0] ?? '';
    if (!title || isSubtitle(title) || isGap(title)) continue;
    for (let c = 2; c <= 5; c += 1) {
      const cell = row[c] ?? '';
      const entities = parseCell(cell);
      for (const e of entities) {
        if (!e.isGap && e.bareName) bareNames.add(e.bareName);
      }
    }
  }
  log.append(
    'info',
    `${bareNames.size} unique entity names in rows ${startRow}-${endRow}`,
  );

  if (bareNames.size === 0) {
    log.append('warn', 'no parseable entity names found, nothing to do');
    return {
      uniqueEntities: 0,
      skippedSmallMolecules: 0,
      resolved: 0,
      noMatch: 0,
      ambiguous: 0,
      rowsUpdated: 0,
      totalRowsInRange: endRow - startRow + 1,
    };
  }

  // 3b. Partition: small molecules / ions skip the SPARQL call.
  const smallMolecules: string[] = [];
  const queryable: string[] = [];
  for (const n of bareNames) {
    if (isLikelySmallMolecule(n)) smallMolecules.push(n);
    else queryable.push(n);
  }
  if (smallMolecules.length > 0) {
    log.append(
      'info',
      `skipping ${smallMolecules.length} likely small molecules / ions: ${smallMolecules.slice(0, 8).join(', ')}${smallMolecules.length > 8 ? '…' : ''}`,
    );
  }

  // 4. SPARQL — only for the queryable subset.
  if (signal.aborted) throw new Error('aborted');
  log.append(
    'info',
    `querying UniProt for ${queryable.length} candidate proteins (human, reviewed-first): ${queryable.join(', ')}`,
  );
  const sparqlStart = Date.now();
  let resolution;
  try {
    resolution =
      queryable.length > 0
        ? await resolveEntities(queryable)
        : { replacements: new Map(), noMatch: [], ambiguous: [] };
  } catch (err) {
    log.append('err', `UniProt query failed: ${(err as Error).message}`);
    throw err;
  }
  log.append(
    'ok',
    `UniProt resolved in ${((Date.now() - sparqlStart) / 1000).toFixed(1)}s · ${resolution.replacements.size} mapped · ` +
      `${resolution.noMatch.length} no-match · ${resolution.ambiguous.length} ambiguous`,
  );
  for (const n of resolution.noMatch) {
    log.append('warn', `no UniProt match for "${n}" — leaving as is`);
  }
  for (const a of resolution.ambiguous) {
    log.append(
      'warn',
      `ambiguous: "${a}" matched multiple reviewed-human proteins — leaving as is`,
    );
  }

  // 5. Build updated rows.
  if (signal.aborted) throw new Error('aborted');
  const updates: { range: string; values: string[][] }[] = [];
  for (let r = startRow; r <= endRow; r += 1) {
    const row = allRows[r - 1] ?? [];
    const title = row[0] ?? '';
    if (!title || isSubtitle(title) || isGap(title)) continue;
    const a = rewriteFreeText(row[0] ?? '', resolution.replacements);
    const b = rewriteFreeText(row[1] ?? '', resolution.replacements);
    const c = rewriteCell(row[2] ?? '', resolution.replacements);
    const d = rewriteCell(row[3] ?? '', resolution.replacements);
    const e = rewriteCell(row[4] ?? '', resolution.replacements);
    const f = rewriteCell(row[5] ?? '', resolution.replacements);
    if (
      a !== (row[0] ?? '') ||
      b !== (row[1] ?? '') ||
      c !== (row[2] ?? '') ||
      d !== (row[3] ?? '') ||
      e !== (row[4] ?? '') ||
      f !== (row[5] ?? '')
    ) {
      updates.push({
        range: `${sheetRef}!A${r}:F${r}`,
        values: [[a, b, c, d, e, f]],
      });
    }
  }

  // 6. Write back.
  if (updates.length > 0) {
    log.append('info', `writing ${updates.length} updated rows…`);
    await batchUpdateValues(input.spreadsheetId, updates);
    log.append('ok', `${updates.length} rows updated`);
  } else {
    log.append('info', 'no rows changed (no resolved replacements applied)');
  }

  return {
    uniqueEntities: bareNames.size,
    skippedSmallMolecules: smallMolecules.length,
    resolved: resolution.replacements.size,
    noMatch: resolution.noMatch.length,
    ambiguous: resolution.ambiguous.length,
    rowsUpdated: updates.length,
    totalRowsInRange: endRow - startRow + 1,
  };
}
