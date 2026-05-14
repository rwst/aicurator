// In-memory UniprotPort fake — three queue maps, declarative test
// scenarios, plus a `calls` log for priority-invariant assertions.

import type { GeneHit, UniprotPort } from '../ports';

export interface UniprotCall {
  method: 'searchSparqlReviewed' | 'searchSparqlAlt' | 'searchRest';
  labels: ReadonlyArray<string>;
  /** REST only. */
  reviewedOnly?: boolean;
  at: number;
}

export interface FakeUniprotControls {
  /** Queue a canned reviewed-gene-SPARQL response. The next call to
   *  searchSparqlReviewed pops it. */
  queueReviewed(hits: ReadonlyMap<string, ReadonlyArray<GeneHit>>): void;
  /** Queue a canned alt-protein-name SPARQL response. The next call to
   *  searchSparqlAlt pops it. */
  queueAlt(hits: ReadonlyMap<string, ReadonlyArray<GeneHit>>): void;
  /** Programmer-supplied resolver for REST — given (label, reviewedOnly)
   *  return the canned hits. */
  setRestResolver(
    fn: (
      label: string,
      reviewedOnly: boolean,
    ) => Promise<ReadonlyArray<GeneHit>>,
  ): void;
  /** Make the next searchSparqlReviewed never resolve (for timeout tests). */
  hangNextReviewed(): void;
  rejectReviewedWith(err: Error): void;
  rejectAltWith(err: Error): void;

  calls(): ReadonlyArray<UniprotCall>;
}

export interface FakeUniprotOptions {
  now?: () => number;
}

export function createFakeUniprot(
  opts: FakeUniprotOptions = {},
): { port: UniprotPort; controls: FakeUniprotControls } {
  const now = opts.now ?? (() => 0);
  const reviewedQueue: (
    | ReadonlyMap<string, ReadonlyArray<GeneHit>>
    | Error
    | 'hang'
  )[] = [];
  const altQueue: (
    | ReadonlyMap<string, ReadonlyArray<GeneHit>>
    | Error
  )[] = [];
  let restResolver:
    | ((
        label: string,
        reviewedOnly: boolean,
      ) => Promise<ReadonlyArray<GeneHit>>)
    | null = null;
  const callLog: UniprotCall[] = [];

  const port: UniprotPort = {
    async searchSparqlReviewed(labels, signal) {
      callLog.push({
        method: 'searchSparqlReviewed',
        labels: [...labels],
        at: now(),
      });
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      const next = reviewedQueue.shift();
      if (next === 'hang') {
        return new Promise<ReadonlyMap<string, ReadonlyArray<GeneHit>>>(
          (_resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort);
              reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort);
          },
        );
      }
      if (next instanceof Error) throw next;
      return next ?? new Map();
    },
    async searchSparqlAlt(labels, signal) {
      callLog.push({
        method: 'searchSparqlAlt',
        labels: [...labels],
        at: now(),
      });
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      const next = altQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? new Map();
    },
    async searchRest(label, reviewedOnly, signal) {
      callLog.push({
        method: 'searchRest',
        labels: [label],
        reviewedOnly,
        at: now(),
      });
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      if (!restResolver) return [];
      return restResolver(label, reviewedOnly);
    },
  };

  const controls: FakeUniprotControls = {
    queueReviewed(hits) {
      reviewedQueue.push(hits);
    },
    queueAlt(hits) {
      altQueue.push(hits);
    },
    setRestResolver(fn) {
      restResolver = fn;
    },
    hangNextReviewed() {
      reviewedQueue.push('hang');
    },
    rejectReviewedWith(err) {
      reviewedQueue.push(err);
    },
    rejectAltWith(err) {
      altQueue.push(err);
    },
    calls: () => callLog.map((c) => ({ ...c, labels: [...c.labels] })),
  };

  return { port, controls };
}
