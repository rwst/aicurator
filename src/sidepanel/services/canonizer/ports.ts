// Ports for the canonizer.
//
// Three semantic UniprotPort methods, not one search(opts): the three
// passes have semantically different contracts (SPARQL takes a batch
// and filters reviewed in-query; REST is per-label with reviewed-first
// internal ordering). Folding them into search({source, reviewed,
// batch}) would force every adapter to dispatch on options and would
// let tests accidentally write `searchRest(["A","B"])` even though the
// real REST is one-label-at-a-time. Three methods make priority tests
// trivially expressible — `expect(port.searchSparqlTrembl).not
// .toHaveBeenCalledWith(['TP53'])` *is* the priority invariant.
//
// Clock owns withTimeout so the 60s SPARQL hang test passes in zero
// real time — the timeout fires after exactly 60_000 ticks of virtual
// time. Real AbortSignal.timeout(ms) cannot be advanced under test.

export interface GeneHit {
  readonly accession?: string;
  /** Uppercase canonical gene symbol. */
  readonly geneSymbol: string;
  readonly reviewed: boolean;
  /** 9606 expected. */
  readonly taxon?: number;
}

export interface UniprotPort {
  /** Batch SPARQL with reviewed=true filter. The map keys are the
   *  upper-cased query labels; values are zero-or-more GeneHit per
   *  label. */
  searchSparqlReviewed(
    labels: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ReadonlyArray<GeneHit>>>;

  /** Same shape as reviewed, against TrEMBL. */
  searchSparqlTrembl(
    labels: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ReadonlyArray<GeneHit>>>;

  /** Per-label REST search. Returns reviewed-first ordered hits.
   *  `reviewedOnly: true` is the first call; the canonizer falls back
   *  to `reviewedOnly: false` for labels that came up empty. */
  searchRest(
    label: string,
    reviewedOnly: boolean,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<GeneHit>>;
}

export interface Clock {
  now(): number;
  /** Resolves after `ms` virtual ms; rejects with the AbortError raised
   *  by `signal` if the wait is interrupted. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Run `body(child)` with a child AbortSignal that fires when either
   *  `parent` aborts or `ms` elapses. Cleans up on resolve/reject. */
  withTimeout<T>(
    ms: number,
    parent: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

/** Minimal fetch-shaped port consumed by the production UniProt adapter.
 *  Keeping this separate from globalThis.fetch lets tests drive the
 *  real adapter under virtual time. */
export interface HttpFetch {
  (url: string, init?: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
    signal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}
