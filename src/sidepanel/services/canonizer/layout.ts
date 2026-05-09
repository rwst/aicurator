// Default column layout for today's Reactome reaction-graph sheet.
//
// The runner imports REACTION_LAYOUT and passes it to createCanonizer.
// Future schema changes (Notes column, Type column, alternate sheets)
// become a one-line edit here — the canonizer iterates the layout, so
// the runner cannot drift out of sync with which columns get the
// free-text rewriter vs the entity-cell rewriter.
//
// Today's columns (12 total, A..L):
//   0 Title         — free-text
//   1 Summation     — free-text
//   2 Inputs        — entity cell
//   3 Outputs       — entity cell
//   4 Catalyst      — entity cell
//   5 Regulators    — entity cell
//   6 Reviews       — untouched
//   7..11 Source1..5 — untouched
//
// Skip-row predicate: header (no title), branch subtitle ('## …'),
// and gap rows (parenthesized title).

import type { CanonizeColumnLayout } from './types';

const SUBTITLE_RE = /^## /;
const GAP_RE = /^\(.*\)$/;

function isSkippableTitle(title: string): boolean {
  if (!title) return true;
  if (SUBTITLE_RE.test(title)) return true;
  if (GAP_RE.test(title.trim())) return true;
  return false;
}

export const REACTION_LAYOUT: CanonizeColumnLayout = {
  freeText: [0, 1],
  entities: [2, 3, 4, 5],
  isSkippableRow: (row) => isSkippableTitle(row[0] ?? ''),
};
