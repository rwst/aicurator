// Ports for the reference resolver.
//
// Why semantic methods, not raw esearch/esummary: the two-call dance
// (ESearch first, then ESummary on the returned IDs) is an
// implementation detail of NCBI's protocol, not part of the contract
// the resolver needs. Exposing it would force the rate-limit budget
// calculation to count "1 batch = 1 or 2 calls?" at the wrong layer
// and would push every test to script both halves.
//
// Why Clock is a port but RateLimiter is not: a token-bucket rate
// limiter is a pure algorithm parameterized by time. Keeping the
// limiter concrete and parameterizing it on a Clock port lets real
// production code run under virtual time in tests, so the
// "≤3 calls/sec" assertion is millisecond-precision against the
// production algorithm, not a mock.

export interface NcbiPort {
  /** Resolve a chunk of DOIs to PMIDs (and PMCIDs when available). The
   *  ESearch + ESummary dance is the production adapter's business.
   *  Returns an empty Map (or a subset) on no-match; throws on
   *  network/HTTP failure (the orchestrator turns the throw into a
   *  whole-batch transient-error). */
  searchByDoi(
    inputs: readonly { id: string; doi: string }[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, { pmid: string; pmcid?: string }>>;

  /** Per-ref title+author probe with NCBI's strict-single-match rule
   *  encoded inside the adapter (`candidateCount` exposes how many
   *  candidates were returned for tests / future heuristics). */
  searchByTitleAuthor(
    q: { title: string; firstAuthor: string; year?: string },
    signal: AbortSignal,
  ): Promise<{ pmid?: string; candidateCount: number }>;
}

export interface Clock {
  now(): number;
  /** Resolves after `ms` virtual ms; rejects with the AbortError raised
   *  by `signal` if the wait is interrupted. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Minimal fetch-shaped port consumed by the production NCBI adapter.
 *  Keeping this separate from `globalThis.fetch` lets tests drive the
 *  real adapter under virtual time (and lets the millisecond-precision
 *  shared-rate-limit invariant be tested against the actual production
 *  algorithm rather than against a mock). */
export interface HttpFetch {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}
