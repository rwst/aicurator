// Public surface types for the deepened canonizer.

/** Declarative description of which columns the canonizer should
 *  read and how to rewrite them. The runner declares this once,
 *  passes it to the factory. Future schema changes are one line. */
export interface CanonizeColumnLayout {
  /** Columns whose cells are rewritten with the free-text mechanism
   *  (`\b…\b` regex sweep, sorted longest-first, length≥3). */
  readonly freeText: ReadonlyArray<number>;
  /** Columns whose cells are pipe-delimited entity strings, rewritten
   *  with the cell-aware mechanism (parse → component lookup →
   *  reassemble preserving formatting). The bare names from these
   *  columns drive UniProt queries. */
  readonly entities: ReadonlyArray<number>;
  /** Predicate the canonizer uses to skip header/comment rows. */
  readonly isSkippableRow: (row: ReadonlyArray<string>) => boolean;
}

/** Pluggable predicate so a future curator-managed metabolite list can
 *  extend the bundled classifier without code changes. */
export interface SmallMoleculeOracle {
  isLikelySmallMolecule(name: string): boolean;
}

export interface CanonizeRequest {
  /** Sheet rows already read by the caller. The canonizer never reads
   *  from Sheets. Row index r corresponds to rows[r-1]. */
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly range: { readonly startRow: number; readonly endRow: number };
  /** Optional per-call layout override. Defaults to the layout the
   *  factory was constructed with. */
  readonly layout?: CanonizeColumnLayout;
  readonly signal: AbortSignal;
}

export interface RewrittenRow {
  /** 1-based sheet row. */
  readonly rowIndex: number;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
  readonly changed: boolean;
}

export interface CanonizeReport {
  readonly uniqueEntities: number;
  readonly skippedSmallMolecules: ReadonlyArray<string>;
  readonly resolved: number;
  readonly noMatch: ReadonlyArray<string>;
  readonly ambiguous: ReadonlyArray<string>;
  readonly rowsScanned: number;
  readonly rowsChanged: number;
  /** Per-pass attribution for the audit trail. */
  readonly counts: {
    readonly reviewedSparql: number;
    readonly altName: number;
    readonly rest: number;
  };
  /** curator-spelling → canonical-uppercase, for diff display. */
  readonly replacements: ReadonlyMap<string, string>;
}

export interface CanonizeResult {
  /** One entry per non-skipped row in range. */
  readonly rewritten: ReadonlyArray<RewrittenRow>;
  readonly report: CanonizeReport;
}

export type CanonizerEvent =
  | { kind: 'parse-start'; rows: number }
  | { kind: 'parse-done'; uniqueNames: number; rowsScanned: number }
  | {
      kind: 'classified';
      smallMolecules: ReadonlyArray<string>;
      queryable: number;
    }
  | { kind: 'resolve-start'; queryable: number }
  | {
      kind: 'resolve-pass-end';
      pass: 'sparql-reviewed' | 'sparql-alt' | 'rest';
      resolved: number;
      remaining: number;
      ms: number;
    }
  | {
      kind: 'resolve-done';
      resolved: number;
      noMatch: ReadonlyArray<string>;
      ambiguous: ReadonlyArray<string>;
      /** curator-spelling → canonical-uppercase, for the compressed
       *  one-line "replaced: A → X; B → Y; …" log summary. */
      replacements: ReadonlyMap<string, string>;
      ms: number;
    }
  | { kind: 'rewrite-done'; rowsChanged: number };

export class CanonizerAbortedError extends Error {
  constructor(message = 'canonization aborted') {
    super(message);
    this.name = 'CanonizerAbortedError';
  }
}

export interface Canonizer {
  canonize(req: CanonizeRequest): Promise<CanonizeResult>;
}
