// createCanonizer — orchestrator. Parses entity columns into bare
// names, partitions via the small-molecule oracle, runs the three
// UniProt passes with priority enforcement (a label resolved by an
// earlier pass is never sent to a later pass), disambiguates
// (reviewed-first, ≥2 distinct genes ⇒ unchanged), and rewrites
// non-skipped rows column-by-column per the layout (free-text vs
// entity-cell). Single error path: throws CanonizerAbortedError on
// abort; unexpected errors propagate.

import type { Clock, GeneHit, UniprotPort } from './ports';
import {
  CanonizerAbortedError,
  type Canonizer,
  type CanonizeColumnLayout,
  type CanonizeReport,
  type CanonizeRequest,
  type CanonizeResult,
  type CanonizerEvent,
  type RewrittenRow,
  type SmallMoleculeOracle,
} from './types';
import { mapWithLimit } from '../../lib/concurrent';
import {
  compileReplacements,
  parseCell,
  rewriteCell,
  rewriteFreeText,
} from '../entityParser';
import { createDefaultOracle } from './oracle';

export type {
  Canonizer,
  CanonizeColumnLayout,
  CanonizeReport,
  CanonizeRequest,
  CanonizeResult,
  CanonizerEvent,
  RewrittenRow,
  SmallMoleculeOracle,
} from './types';
export { CanonizerAbortedError } from './types';
export type { Clock, GeneHit, HttpFetch, UniprotPort } from './ports';
export { REACTION_LAYOUT } from './layout';
export { createDefaultOracle } from './oracle';

const REST_CONCURRENCY = 8;

export interface CreateCanonizerOptions {
  uniprot: UniprotPort;
  /** Default layout for canonize() calls. Per-call layout overrides this. */
  layout: CanonizeColumnLayout;
  smallMoleculeOracle?: SmallMoleculeOracle;
  clock?: Clock;
  onEvent?: (e: CanonizerEvent) => void;
}

export function createCanonizer(opts: CreateCanonizerOptions): Canonizer {
  const oracle = opts.smallMoleculeOracle ?? createDefaultOracle();
  const now = opts.clock ? () => opts.clock!.now() : () => Date.now();

  return {
    async canonize(req: CanonizeRequest): Promise<CanonizeResult> {
      const layout = req.layout ?? opts.layout;
      const emit = (e: CanonizerEvent): void => {
        opts.onEvent?.(e);
      };
      const { startRow, endRow } = req.range;

      // ── Pass 1: parse entity columns, collect bare names ────────────
      emit({ kind: 'parse-start', rows: endRow - startRow + 1 });

      const bareNames = new Set<string>();
      let rowsScanned = 0;
      for (let r = startRow; r <= endRow; r += 1) {
        if (req.signal.aborted) throw new CanonizerAbortedError();
        const row = req.rows[r - 1] ?? [];
        if (layout.isSkippableRow(row)) continue;
        rowsScanned += 1;
        for (const c of layout.entities) {
          const cell = row[c] ?? '';
          for (const e of parseCell(cell)) {
            if (e.isGap) continue;
            for (const comp of e.components) {
              if (comp.bareName) bareNames.add(comp.bareName);
            }
          }
        }
      }
      emit({
        kind: 'parse-done',
        uniqueNames: bareNames.size,
        rowsScanned,
      });

      // ── Pass 2: classify into small molecules vs UniProt-queryable ──
      const smallMolecules: string[] = [];
      const queryable: string[] = [];
      for (const n of bareNames) {
        if (oracle.isLikelySmallMolecule(n)) smallMolecules.push(n);
        else queryable.push(n);
      }
      emit({
        kind: 'classified',
        smallMolecules,
        queryable: queryable.length,
      });

      // ── Pass 3: three-pass UniProt resolution with priority ─────────
      const resolveStart = now();
      emit({ kind: 'resolve-start', queryable: queryable.length });

      const resolveResult = await runResolve(
        opts.uniprot,
        queryable,
        req.signal,
        (event) => emit(event),
        now,
      );

      const resolveMs = now() - resolveStart;
      emit({
        kind: 'resolve-done',
        resolved: resolveResult.replacements.size,
        noMatch: resolveResult.noMatch,
        ambiguous: resolveResult.ambiguous,
        ms: resolveMs,
      });

      // ── Pass 4: rewrite rows per layout ─────────────────────────────
      if (req.signal.aborted) throw new CanonizerAbortedError();
      const compiled = compileReplacements(
        new Map(resolveResult.replacements),
      );
      const rewritten: RewrittenRow[] = [];
      let rowsChanged = 0;
      for (let r = startRow; r <= endRow; r += 1) {
        const row = req.rows[r - 1] ?? [];
        if (layout.isSkippableRow(row)) continue;
        // Determine the maximum column index we touch — always the
        // larger of layout.freeText and layout.entities — so the
        // produced row keeps width consistent with the input.
        const maxCol = Math.max(
          ...layout.freeText,
          ...layout.entities,
          row.length - 1,
        );
        const before: string[] = [];
        const after: string[] = [];
        let changed = false;
        for (let c = 0; c <= maxCol; c += 1) {
          const original = row[c] ?? '';
          before.push(original);
          let next: string;
          if (layout.freeText.includes(c)) {
            next = rewriteFreeText(original, compiled);
          } else if (layout.entities.includes(c)) {
            next = rewriteCell(original, resolveResult.replacements);
          } else {
            next = original;
          }
          after.push(next);
          if (next !== original) changed = true;
        }
        if (changed) rowsChanged += 1;
        rewritten.push({
          rowIndex: r,
          before,
          after,
          changed,
        });
      }
      emit({ kind: 'rewrite-done', rowsChanged });

      const report: CanonizeReport = {
        uniqueEntities: bareNames.size,
        skippedSmallMolecules: smallMolecules,
        resolved: resolveResult.replacements.size,
        noMatch: resolveResult.noMatch,
        ambiguous: resolveResult.ambiguous,
        rowsScanned,
        rowsChanged,
        counts: resolveResult.counts,
        replacements: new Map(resolveResult.replacements),
      };
      return { rewritten, report };
    },
  };
}

interface ResolveOutput {
  replacements: Map<string, string>;
  noMatch: string[];
  ambiguous: string[];
  counts: { reviewedSparql: number; altName: number; rest: number };
}

async function runResolve(
  uniprot: UniprotPort,
  labels: readonly string[],
  signal: AbortSignal,
  emit: (e: CanonizerEvent) => void,
  now: () => number,
): Promise<ResolveOutput> {
  const replacements = new Map<string, string>();
  const noMatch: string[] = [];
  const ambiguous: string[] = [];
  const counts = { reviewedSparql: 0, altName: 0, rest: 0 };
  if (labels.length === 0) return { replacements, noMatch, ambiguous, counts };

  // Curator-spelling is preserved as the replacement key. We send
  // uppercased forms to UniProt because human gene labels are
  // upper-case. A label seen in two different cases (e.g. "Tipin" and
  // "TIPIN") collapses to one query but produces two replacement
  // entries (curator's case → "TIPIN").
  const upperToOriginal = new Map<string, string[]>();
  for (const l of labels) {
    const u = l.toUpperCase();
    let arr = upperToOriginal.get(u);
    if (!arr) {
      arr = [];
      upperToOriginal.set(u, arr);
    }
    arr.push(l);
  }
  const upperLabels = [...upperToOriginal.keys()];

  // ── Pass 1: SPARQL reviewed-only ─────────────────────────
  if (signal.aborted) throw new CanonizerAbortedError();
  const t0 = now();
  let reviewedHits: ReadonlyMap<string, ReadonlyArray<GeneHit>> =
    new Map();
  try {
    reviewedHits = await uniprot.searchSparqlReviewed(upperLabels, signal);
  } catch (err) {
    if (isAbort(err)) throw new CanonizerAbortedError();
    throw err;
  }
  emit({
    kind: 'resolve-pass-end',
    pass: 'sparql-reviewed',
    resolved: reviewedHits.size,
    remaining: upperLabels.length - reviewedHits.size,
    ms: now() - t0,
  });

  // ── Pass 2: SPARQL alt-protein-name fallback ─────────────
  // Catches synonyms like "Ku86" → XRCC5 that aren't in skos gene
  // labels but live under up:alternativeName / up:recommendedName on
  // the protein. Only labels not resolved by the gene-name pass are
  // sent — gene-name matches always win first, preserving the
  // Timeless ↔ TIPIN cross-gene-collision protection.
  const remainingAfterReviewed = upperLabels.filter(
    (l) => !reviewedHits.has(l),
  );
  let altHits: ReadonlyMap<string, ReadonlyArray<GeneHit>> = new Map();
  if (remainingAfterReviewed.length > 0) {
    if (signal.aborted) throw new CanonizerAbortedError();
    const t1 = now();
    try {
      altHits = await uniprot.searchSparqlAlt(
        remainingAfterReviewed,
        signal,
      );
    } catch (err) {
      if (isAbort(err)) throw new CanonizerAbortedError();
      throw err;
    }
    emit({
      kind: 'resolve-pass-end',
      pass: 'sparql-alt',
      resolved: altHits.size,
      remaining: remainingAfterReviewed.length - altHits.size,
      ms: now() - t1,
    });
  }

  // ── Pass 3: REST per-label fan-out, reviewed-first then full ─
  const remainingAfterAlt = remainingAfterReviewed.filter(
    (l) => !altHits.has(l),
  );
  const restHits = new Map<string, ReadonlyArray<GeneHit>>();
  if (remainingAfterAlt.length > 0) {
    if (signal.aborted) throw new CanonizerAbortedError();
    const t2 = now();
    const reviewedFirst = await mapWithLimit(
      remainingAfterAlt,
      REST_CONCURRENCY,
      async (label) => {
        if (signal.aborted) return [] as ReadonlyArray<GeneHit>;
        try {
          return await uniprot.searchRest(label, true, signal);
        } catch (err) {
          if (isAbort(err)) throw err;
          return [] as ReadonlyArray<GeneHit>;
        }
      },
    );
    if (signal.aborted) throw new CanonizerAbortedError();
    for (let i = 0; i < remainingAfterAlt.length; i += 1) {
      if (reviewedFirst[i].length > 0)
        restHits.set(remainingAfterAlt[i], reviewedFirst[i]);
    }
    const stillEmpty = remainingAfterAlt.filter((l) => !restHits.has(l));
    if (stillEmpty.length > 0) {
      const restAll = await mapWithLimit(
        stillEmpty,
        REST_CONCURRENCY,
        async (label) => {
          if (signal.aborted) return [] as ReadonlyArray<GeneHit>;
          try {
            return await uniprot.searchRest(label, false, signal);
          } catch (err) {
            if (isAbort(err)) throw err;
            return [] as ReadonlyArray<GeneHit>;
          }
        },
      );
      if (signal.aborted) throw new CanonizerAbortedError();
      for (let i = 0; i < stillEmpty.length; i += 1) {
        if (restAll[i].length > 0) restHits.set(stillEmpty[i], restAll[i]);
      }
    }
    emit({
      kind: 'resolve-pass-end',
      pass: 'rest',
      resolved: restHits.size,
      remaining: remainingAfterAlt.length - restHits.size,
      ms: now() - t2,
    });
  }

  // ── Disambiguate per upper-cased label ───────────────────
  for (const u of upperLabels) {
    const fromReviewed = reviewedHits.get(u);
    const fromAlt = altHits.get(u);
    const fromRest = restHits.get(u);
    let pool: ReadonlyArray<GeneHit> | undefined;
    let pass: 'reviewedSparql' | 'altName' | 'rest' | null = null;
    if (fromReviewed && fromReviewed.length > 0) {
      pool = fromReviewed;
      pass = 'reviewedSparql';
    } else if (fromAlt && fromAlt.length > 0) {
      pool = fromAlt;
      pass = 'altName';
    } else if (fromRest && fromRest.length > 0) {
      pool = fromRest;
      pass = 'rest';
    }

    if (!pool || !pass) {
      for (const orig of upperToOriginal.get(u) ?? []) noMatch.push(orig);
      continue;
    }

    // Reviewed-first within pool — if there are reviewed hits, drop
    // the unreviewed ones; otherwise consider every hit.
    const reviewedInPool = pool.filter((h) => h.reviewed);
    const finalPool = reviewedInPool.length > 0 ? reviewedInPool : pool;
    const distinctGenes = new Set(finalPool.map((h) => h.geneSymbol));
    if (distinctGenes.size !== 1) {
      for (const orig of upperToOriginal.get(u) ?? []) ambiguous.push(orig);
      continue;
    }
    const [canonical] = distinctGenes;
    if (!canonical) {
      for (const orig of upperToOriginal.get(u) ?? []) noMatch.push(orig);
      continue;
    }
    let attributedThisLabel = false;
    for (const orig of upperToOriginal.get(u) ?? []) {
      // Exact-string compare so case-only diffs ("Tipin" → "TIPIN")
      // produce a real replacement; true no-ops drop out.
      if (canonical !== orig) {
        replacements.set(orig, canonical);
        if (!attributedThisLabel) {
          counts[pass] += 1;
          attributedThisLabel = true;
        }
      }
    }
  }

  return { replacements, noMatch, ambiguous, counts };
}

function isAbort(err: unknown): boolean {
  if (err instanceof CanonizerAbortedError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return (err as Error)?.name === 'AbortError';
}
