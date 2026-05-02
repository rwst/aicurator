// Summate runner — per-row pipeline:
//   1. Read sheet rows in selected range.
//   2. Skip subtitle (## …) and gap (parenthesized title) rows.
//   3. Per row: parse PMIDs from H..L, glob PDFs in <project>/PDF/,
//      LLM call with PDFs, write prose to column B.
//   4. After all rows: stage = 'summated'.

import type { Log } from '../services/log';
import type { Provider } from '../llm/provider';
import { SUMMATE_SYSTEM_PROMPT } from '../prompts/summate.system';
import {
  batchUpdateValues,
  getSheetName,
  getValues,
  quoteSheet,
} from '../services/sheets';
import { pmidFromFilename } from '../services/pdfDir';

export interface RowRange {
  start: number; // 1-based, inclusive (sheet row number)
  end: number;   // 1-based, inclusive
}

export interface SummateInput {
  spreadsheetId: string;
  gid: string;
  projectDir: FileSystemDirectoryHandle;
  pdfMap: Map<string, FileSystemFileHandle>;
  range: RowRange | null; // null = all data rows
  provider: Provider;
  log: Log;
  signal: AbortSignal;
}

export interface SummateReport {
  processed: number;
  skipped: number;
  errored: number;
  totalRowsInRange: number;
}

const PMID_URL_RE = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/;
const BARE_PMID_RE = /^\s*(\d{4,9})\s*$/;

function parsePmidsFromSourceCells(row: string[]): string[] {
  const pmids = new Set<string>();
  for (let c = 7; c <= 11; c += 1) {
    const cell = row[c] ?? '';
    if (!cell) continue;
    const m = PMID_URL_RE.exec(cell);
    if (m) {
      pmids.add(m[1]);
      continue;
    }
    const bare = BARE_PMID_RE.exec(cell);
    if (bare) pmids.add(bare[1]);
  }
  return [...pmids];
}

function isSubtitle(title: string): boolean {
  return title.startsWith('## ');
}
function isGap(title: string): boolean {
  return /^\(.*\)$/.test(title.trim());
}

function buildUserText(row: string[], pdfHandles: FileSystemFileHandle[]): string {
  const pdfList = pdfHandles
    .map((h) => `- ${h.name} (PMID ${pmidFromFilename(h.name) ?? '?'})`)
    .join('\n');
  return `Reaction row:
Title: ${row[0] ?? ''}
Inputs: ${row[2] ?? ''}
Outputs: ${row[3] ?? ''}
Catalyst: ${row[4] ?? ''}
Regulators: ${row[5] ?? ''}

Cited PDFs attached (${pdfHandles.length}):
${pdfList}

Draft a Reactome-style summation per the rules in the system prompt. Output plain prose only — one paragraph, with inline (Author et al. YEAR) citations from the attached PDFs.`;
}

async function readPdfBytes(
  handle: FileSystemFileHandle,
): Promise<{ name: string; bytes: ArrayBuffer }> {
  const file = await handle.getFile();
  return { name: handle.name, bytes: await file.arrayBuffer() };
}

export async function runSummate(input: SummateInput): Promise<SummateReport> {
  const { log, signal } = input;
  log.append('init', `Summate starting`);

  // 1. Resolve sheet name and read rows.
  const sheetName = await getSheetName(input.spreadsheetId, input.gid);
  const sheetRef = quoteSheet(sheetName);
  const allRows = await getValues(input.spreadsheetId, `${sheetRef}!A:L`);
  log.append('info', `read ${allRows.length} rows from "${sheetName}"`);

  // 2. Determine range.
  let startRow = 2;
  let endRow = allRows.length;
  if (input.range) {
    startRow = Math.max(2, input.range.start);
    endRow = Math.min(endRow, input.range.end);
  }
  if (endRow < startRow) {
    log.append('warn', `empty range (${startRow}-${endRow}), nothing to do`);
    return {
      processed: 0,
      skipped: 0,
      errored: 0,
      totalRowsInRange: 0,
    };
  }
  log.append('info', `processing rows ${startRow}-${endRow}`);

  let processed = 0;
  let skipped = 0;
  let errored = 0;

  for (let r = startRow; r <= endRow; r += 1) {
    if (signal.aborted) throw new Error('aborted');
    const row = allRows[r - 1] ?? [];
    const title = row[0] ?? '';

    if (!title) {
      log.append('info', `row ${r}: empty, skipping`);
      skipped += 1;
      continue;
    }
    if (isSubtitle(title) || isGap(title)) {
      log.append('info', `row ${r}: subtitle/gap, skipping`);
      skipped += 1;
      continue;
    }

    const pmids = parsePmidsFromSourceCells(row);
    if (pmids.length === 0) {
      log.append('warn', `row ${r}: no PMIDs in Source columns, skipping`);
      skipped += 1;
      continue;
    }

    const pdfHandles: FileSystemFileHandle[] = [];
    const missingPmids: string[] = [];
    for (const pmid of pmids) {
      const handle = input.pdfMap.get(pmid);
      if (handle) pdfHandles.push(handle);
      else missingPmids.push(pmid);
    }

    if (pdfHandles.length === 0) {
      log.append(
        'err',
        `row ${r}: no PDFs found for ${pmids.length} PMID(s) (${missingPmids.join(', ')}), skipping`,
      );
      errored += 1;
      continue;
    }
    if (missingPmids.length > 0) {
      log.append(
        'warn',
        `row ${r}: ${missingPmids.length}/${pmids.length} PMIDs missing PDFs (${missingPmids.join(', ')}), proceeding with partial set`,
      );
    }

    let pdfs: { name: string; bytes: ArrayBuffer }[];
    try {
      pdfs = await Promise.all(pdfHandles.map((h) => readPdfBytes(h)));
    } catch (err) {
      log.append('err', `row ${r}: failed to read PDFs: ${(err as Error).message}`);
      errored += 1;
      continue;
    }

    log.append(
      'info',
      `row ${r}: calling provider with ${pdfs.length} PDFs…`,
    );
    const llmStart = Date.now();
    let summation: string;
    try {
      const result = await input.provider.call(
        {
          systemPrompt: SUMMATE_SYSTEM_PROMPT,
          userText: buildUserText(row, pdfHandles),
          pdfs,
          maxOutputTokens: 4096,
        },
        signal,
      );
      summation = result.text.trim();
      log.append(
        'ok',
        `row ${r}: LLM responded in ${((Date.now() - llmStart) / 1000).toFixed(1)}s` +
          (result.usage
            ? ` · ${result.usage.input}+${result.usage.output} tokens`
            : ''),
      );
    } catch (err) {
      if (signal.aborted) throw err;
      log.append('err', `row ${r}: LLM call failed: ${(err as Error).message}`);
      errored += 1;
      continue;
    }

    if (!summation) {
      log.append('err', `row ${r}: empty LLM response, skipping`);
      errored += 1;
      continue;
    }

    try {
      await batchUpdateValues(input.spreadsheetId, [
        { range: `${sheetRef}!B${r}`, values: [[summation]] },
      ]);
      log.append('ok', `row ${r}: summation written (${summation.length} chars)`);
      processed += 1;
    } catch (err) {
      log.append('err', `row ${r}: sheet write failed: ${(err as Error).message}`);
      errored += 1;
    }
  }

  const report: SummateReport = {
    processed,
    skipped,
    errored,
    totalRowsInRange: endRow - startRow + 1,
  };
  log.append(
    'ok',
    `Summate complete · ${report.processed} processed · ${report.skipped} skipped · ${report.errored} errors (out of ${report.totalRowsInRange} rows in range)`,
  );
  return report;
}

// ── Mock for sheet-write testing ─────────────────────────
export interface SummateMockInput {
  spreadsheetId: string;
  gid: string;
  range: RowRange | null;
  log: Log;
  signal: AbortSignal;
}

export async function runSummateMock(
  input: SummateMockInput,
): Promise<SummateReport> {
  const { log, signal } = input;
  log.append(
    'init',
    'Mock Summate starting — synthetic prose, no LLM call, no PDF read',
  );

  const sheetName = await getSheetName(input.spreadsheetId, input.gid);
  const sheetRef = quoteSheet(sheetName);
  const allRows = await getValues(input.spreadsheetId, `${sheetRef}!A:L`);

  let startRow = 2;
  let endRow = allRows.length;
  if (input.range) {
    startRow = Math.max(2, input.range.start);
    endRow = Math.min(endRow, input.range.end);
  }

  let processed = 0;
  let skipped = 0;

  const updates: { range: string; values: string[][] }[] = [];
  for (let r = startRow; r <= endRow; r += 1) {
    if (signal.aborted) throw new Error('aborted');
    const row = allRows[r - 1] ?? [];
    const title = row[0] ?? '';
    if (!title || isSubtitle(title) || isGap(title)) {
      skipped += 1;
      continue;
    }
    const mockProse = `This reaction proceeds as described in the row title (Mock et al. 2026). The catalyst, if present, performs the relevant molecular function (Synth et al. 2025). [Mock summation — synthetic prose for sheet-write testing.]`;
    updates.push({
      range: `${sheetRef}!B${r}`,
      values: [[mockProse]],
    });
    processed += 1;
  }

  if (updates.length > 0) {
    log.append('info', `writing ${updates.length} mock summations…`);
    await batchUpdateValues(input.spreadsheetId, updates);
    log.append('ok', `${updates.length} cells updated`);
  }

  return {
    processed,
    skipped,
    errored: 0,
    totalRowsInRange: endRow - startRow + 1,
  };
}
