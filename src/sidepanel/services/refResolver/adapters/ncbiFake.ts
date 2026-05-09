// In-memory NcbiPort fake for the cheap-path tests (priority,
// single-match acceptance, batch chunking, error containment).
//
// The shared-rate-limit invariant test does NOT use this fake — it
// exercises the production HTTP adapter (createHttpNcbiAdapter) under
// a virtual clock with a fake fetch, so the millisecond-precision
// assertions land on the actual production algorithm rather than on a
// mock.

import type { NcbiPort } from '../ports';

export interface DoiBatchInvocation {
  inputs: { id: string; doi: string }[];
  at: number;
}

export interface TitleAuthorInvocation {
  q: { title: string; firstAuthor: string; year?: string };
  at: number;
}

export interface FakeNcbiControls {
  /** Push a canned doi→hit map for the next searchByDoi call. */
  queueDoiBatch(hits: ReadonlyMap<string, { pmid: string; pmcid?: string }>): void;
  /** Push a rejection for the next searchByDoi call. */
  rejectDoiBatchWith(err: Error): void;
  /** Programmer-supplied resolver: given the query, return the result.
   *  Use this for fan-out tests where each call needs a distinct outcome. */
  setTitleAuthorResolver(
    fn: (
      q: { title: string; firstAuthor: string; year?: string },
    ) => Promise<{ pmid?: string; candidateCount: number }>,
  ): void;
  /** Inspect calls. */
  doiCalls(): DoiBatchInvocation[];
  titleAuthorCalls(): TitleAuthorInvocation[];
}

export function createFakeNcbiAdapter(opts?: {
  now?: () => number;
}): { port: NcbiPort; controls: FakeNcbiControls } {
  const now = opts?.now ?? (() => 0);
  const doiQueue: (ReadonlyMap<string, { pmid: string; pmcid?: string }> | Error)[] = [];
  let taResolver:
    | ((
        q: { title: string; firstAuthor: string; year?: string },
      ) => Promise<{ pmid?: string; candidateCount: number }>)
    | null = null;
  const doiCalls: DoiBatchInvocation[] = [];
  const titleAuthorCalls: TitleAuthorInvocation[] = [];

  const port: NcbiPort = {
    async searchByDoi(inputs, signal) {
      doiCalls.push({ inputs: [...inputs], at: now() });
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      const next = doiQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? new Map();
    },
    async searchByTitleAuthor(q, signal) {
      titleAuthorCalls.push({ q: { ...q }, at: now() });
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      if (!taResolver) return { candidateCount: 0 };
      return taResolver(q);
    },
  };

  const controls: FakeNcbiControls = {
    queueDoiBatch(hits) {
      doiQueue.push(hits);
    },
    rejectDoiBatchWith(err) {
      doiQueue.push(err);
    },
    setTitleAuthorResolver(fn) {
      taResolver = fn;
    },
    doiCalls: () => doiCalls.map((c) => ({ ...c, inputs: [...c.inputs] })),
    titleAuthorCalls: () =>
      titleAuthorCalls.map((c) => ({ ...c, q: { ...c.q } })),
  };

  return { port, controls };
}
