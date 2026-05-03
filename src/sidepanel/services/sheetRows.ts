// Shared utilities for working with the 12-column reaction-table sheet
// schema and per-row predicates. Centralises:
//   - the canonical column layout (headers + Source-column slice)
//   - PMID extraction from Source columns H..L
//   - subtitle (## branch) and gap (parenthesized title) detection
//   - row-range parsing from the "span" tab input
//   - clamping a user range to the actual sheet's row count

export const HEADER_ROW: string[] = [
  'Title',
  'Summation',
  'Inputs',
  'Outputs',
  'Catalyst',
  'Regulators',
  'Reviews',
  'Source1',
  'Source2',
  'Source3',
  'Source4',
  'Source5',
];

// Extract emits at most 5 sources per reaction (H..L). Summate, however,
// allows the curator to extend a row with additional PubMed links by
// hand to the right of the existing Source cells. Cap at MAX_SOURCES so
// the Sheets read range stays bounded.
export const MAX_SOURCES = 30;
export const SOURCE_COL_START = 7;
export const SOURCE_COL_END = SOURCE_COL_START + MAX_SOURCES - 1;

// A1-notation column letter for SOURCE_COL_END (defaults to 'AK' at
// 30 sources). Recompute if SOURCE_COL_END changes.
export function colIndexToLetter(idx: number): string {
  let n = idx;
  let out = '';
  while (true) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}
export const SUMMATE_READ_RANGE_END = colIndexToLetter(SOURCE_COL_END);

// Entity columns C..F → indices 2..5.
export const ENTITY_COL_START = 2;
export const ENTITY_COL_END = 5;

const PMID_URL_RE = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/;
const BARE_PMID_RE = /^\s*(\d{4,9})\s*$/;

export function parsePmidsFromRow(row: string[]): string[] {
  const pmids = new Set<string>();
  for (let c = SOURCE_COL_START; c <= SOURCE_COL_END; c += 1) {
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

export function isSubtitleRow(title: string): boolean {
  return title.startsWith('## ');
}

export function isGapRow(title: string): boolean {
  return /^\(.*\)$/.test(title.trim());
}

export function isSkippableRow(title: string): boolean {
  return !title || isSubtitleRow(title) || isGapRow(title);
}

export interface RowRange {
  start: number;
  end: number;
}

const RANGE_RE = /^\s*(\d+)\s*-\s*(\d+)\s*$/;
const SINGLE_RE = /^\s*(\d+)\s*$/;

// Accepts "3-7" (rows 3 through 7 inclusive) or "3" (just row 3 = 3-3).
export function parseRowRange(text: string): RowRange | null {
  const range = RANGE_RE.exec(text);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = parseInt(range[2], 10);
    if (start < 2 || end < start) return null;
    return { start, end };
  }
  const single = SINGLE_RE.exec(text);
  if (single) {
    const n = parseInt(single[1], 10);
    if (n < 2) return null;
    return { start: n, end: n };
  }
  return null;
}

// Clamp a user-provided range against actual sheet content.
// `null` range = "all data rows" (skips header).
export function clampRowRange(
  allRows: readonly unknown[],
  range: RowRange | null,
): { startRow: number; endRow: number } {
  let startRow = 2;
  let endRow = allRows.length;
  if (range) {
    startRow = Math.max(2, range.start);
    endRow = Math.min(endRow, range.end);
  }
  return { startRow, endRow };
}
