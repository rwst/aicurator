// RFC tests 1–12 for the deepened reference resolver. Vitest, node
// env, no jsdom, no real network, no real time.

import { describe, expect, it } from 'vitest';
import {
  createRefResolver,
  createTokenBucketLimiter,
  ResolverAbortedError,
  type RawRef,
  type ResolutionStrategy,
  type ResolverEvent,
} from './index';
import { createFakeNcbiAdapter } from './adapters/ncbiFake';
import { createVirtualClock } from './adapters/clockVirtual';
import { createHttpNcbiAdapter } from './adapters/ncbiHttp';

// ── Helpers ──────────────────────────────────────────────

function dropController(): {
  controller: AbortController;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  return { controller, signal: controller.signal };
}

const ID = (s: string) => s;

// ── Tests 1–10: state-machine semantics with the cheap fake ─────────────

describe('createRefResolver', () => {
  it('1. Priority — DOI wins over title+author; title+author never consulted', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    controls.queueDoiBatch(
      new Map([['r0', { pmid: '100' }]]),
    );
    controls.setTitleAuthorResolver(async () => {
      throw new Error('title+author should never be called');
    });

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = [
      {
        id: ID('r0'),
        doi: '10.1/foo',
        title: 'X',
        firstAuthor: 'A',
      },
    ];
    const r = await resolver.resolve(refs, dropController().signal);
    expect(r.refs[0].pmid).toBe('100');
    expect(r.refs[0].pmid_source).toBe('esearch:doi');
    expect(controls.titleAuthorCalls()).toHaveLength(0);
  });

  it('2. Strict single-match — 5 candidates → unresolved', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    controls.setTitleAuthorResolver(async () => ({ candidateCount: 5 }));

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = [
      { id: 'r0', title: 'X', firstAuthor: 'A' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);
    expect(r.refs[0].pmid).toBe('');
    expect(r.refs[0].pmid_source).toBe('');
    expect(r.summary.unresolved).toBe(1);
  });

  it('3. Strict single-match — 1 candidate adopts as esearch:title-author', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    controls.setTitleAuthorResolver(async () => ({
      pmid: '777',
      candidateCount: 1,
    }));

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = [
      { id: 'r0', title: 'X', firstAuthor: 'A' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);
    expect(r.refs[0].pmid).toBe('777');
    expect(r.refs[0].pmid_source).toBe('esearch:title-author');
  });

  it('4. Inline-strip — every pmid_source==="inline" is cleared; summary.strippedInline reflects count', async () => {
    const { port } = createFakeNcbiAdapter();
    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = [
      { id: 'r0', pmid: '111', pmid_source: 'inline' },
      { id: 'r1', pmid: '222', pmid_source: 'inline' },
      { id: 'r2', title: 'X', firstAuthor: 'A' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);
    expect(r.refs[0].pmid).toBe('');
    expect(r.refs[1].pmid).toBe('');
    expect(r.summary.strippedInline).toBe(2);
  });

  it('5. Batch chunking — 450 DOIs go in 3 batches sized 200/200/50', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    // Queue empty hits per batch — we only care about call shape.
    for (let i = 0; i < 3; i += 1)
      controls.queueDoiBatch(new Map());

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = Array.from({ length: 450 }, (_, i) => ({
      id: `r${i}`,
      doi: `10.1/${i}`,
    }));
    await resolver.resolve(refs, dropController().signal);
    const sizes = controls.doiCalls().map((c) => c.inputs.length);
    expect(sizes).toEqual([200, 200, 50]);
  });

  it('6. Shared rate limit — 1 DOI batch (= 2 NCBI HTTP calls) + 50 title+author calls obey ≤3/sec across the combined call log', async () => {
    // This test exercises the production HTTP NCBI adapter under a
    // virtual clock and a fake fetch — the millisecond-precision
    // assertion lands on the actual production algorithm.
    const clock = createVirtualClock();
    const limiter = createTokenBucketLimiter({ ratePerSec: 3, clock });

    interface FakeReq {
      url: string;
      at: number;
    }
    const calls: FakeReq[] = [];

    const fakeFetch = async (url: string): Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
      text(): Promise<string>;
    }> => {
      calls.push({ url, at: clock.now() });
      // Different responses per endpoint.
      if (url.includes('esearch') && url.includes('AID')) {
        return makeFakeJson({ esearchresult: { idlist: ['1'] } });
      }
      if (url.includes('esummary')) {
        return makeFakeJson({
          result: {
            '1': {
              uid: '1',
              articleids: [
                { idtype: 'doi', value: '10.1/foo' },
                { idtype: 'pubmed', value: '1' },
              ],
            },
          },
        });
      }
      if (url.includes('esearch') && url.includes('TITL')) {
        return makeFakeJson({ esearchresult: { idlist: [] } });
      }
      return makeFakeJson({});
    };

    const ncbi = createHttpNcbiAdapter({ fetch: fakeFetch, limiter });
    const resolver = createRefResolver({ ncbi, clock });

    const refs: RawRef[] = [
      { id: 'd0', doi: '10.1/foo' },
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `t${i}`,
        title: `Reaction ${i} kinase activity in pathway`,
        firstAuthor: `Author${i}`,
      })),
    ];

    const ctrl = new AbortController();
    const promise = resolver.resolve(refs, ctrl.signal);
    await clock.runAll();
    await promise;

    expect(calls.length).toBeGreaterThan(0);
    // Sliding 1000ms window: at most 3 calls in any window.
    const at = calls.map((c) => c.at).sort((a, b) => a - b);
    for (let i = 0; i < at.length; i += 1) {
      const windowEnd = at[i] + 999; // window is (at[i], at[i]+999] inclusive
      let count = 0;
      for (let j = i; j < at.length && at[j] <= windowEnd; j += 1)
        count += 1;
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('7. Per-ref error containment — one title+author throw lands in transientErrors with refId', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    controls.setTitleAuthorResolver(async (q) => {
      if (q.title === 'BAD') throw new Error('ECONNRESET');
      return { pmid: '500', candidateCount: 1 };
    });

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = [
      { id: 'g0', title: 'GOOD', firstAuthor: 'A' },
      { id: 'b0', title: 'BAD', firstAuthor: 'A' },
      { id: 'g1', title: 'GOOD', firstAuthor: 'A' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);

    expect(r.transientErrors).toHaveLength(1);
    expect(r.transientErrors[0].refId).toBe('b0');
    expect(r.transientErrors[0].strategy).toBe('title-author');
    expect(r.transientErrors[0].message).toBe('ECONNRESET');
    expect(r.refs.find((x) => x.id === 'g0')?.pmid).toBe('500');
    expect(r.refs.find((x) => x.id === 'g1')?.pmid).toBe('500');
    expect(r.refs.find((x) => x.id === 'b0')?.pmid).toBe('');
  });

  it('8. Whole-batch DOI failure — strategy-level transient-error, no throw, title+author still runs on its own candidates', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    controls.rejectDoiBatchWith(new Error('NCBI 503: Service Unavailable'));
    controls.setTitleAuthorResolver(async () => ({
      pmid: '900',
      candidateCount: 1,
    }));

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = [
      // DOI-only ref — DOI batch fails, no fallback path.
      { id: 'd0', doi: '10.1/x' },
      // Title-only ref — title+author still runs.
      { id: 't0', title: 'Some kinase study', firstAuthor: 'B' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);

    const batchErrors = r.transientErrors.filter(
      (e) => e.strategy === 'doi-batch' && !e.refId,
    );
    expect(batchErrors).toHaveLength(1);
    expect(batchErrors[0].message).toMatch(/NCBI 503/);

    expect(r.refs.find((x) => x.id === 'd0')?.pmid).toBe('');
    expect(r.refs.find((x) => x.id === 't0')?.pmid).toBe('900');
  });

  it('9. AbortSignal mid-flight — resolver rejects with ResolverAbortedError', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    let calls = 0;
    controls.setTitleAuthorResolver(async () => {
      calls += 1;
      if (calls === 3) ctrl.abort();
      return { candidateCount: 0 };
    });

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      title: `Title ${i}`,
      firstAuthor: 'A',
    }));
    const ctrl = new AbortController();
    await expect(resolver.resolve(refs, ctrl.signal)).rejects.toBeInstanceOf(
      ResolverAbortedError,
    );
  });

  it('10. Audit aggregation matches per-ref provenance', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    controls.queueDoiBatch(
      new Map([
        ['d0', { pmid: '1' }],
        ['d1', { pmid: '2' }],
        ['d2', { pmid: '3' }],
        ['d3', { pmid: '4' }],
        ['d4', { pmid: '5' }],
      ]),
    );
    controls.setTitleAuthorResolver(async (q) => {
      if (q.title === 'TA-OK') return { pmid: '777', candidateCount: 1 };
      return { candidateCount: 5 }; // ambiguous — unresolved
    });

    const resolver = createRefResolver({ ncbi: port });
    const refs: RawRef[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `d${i}`,
        doi: `10.1/${i}`,
      })),
      { id: 'ta0', title: 'TA-OK', firstAuthor: 'A' },
      { id: 'ta1', title: 'TA-OK', firstAuthor: 'B' },
      { id: 'u0', title: 'AMBIG', firstAuthor: 'C' },
      { id: 'u1', title: 'AMBIG', firstAuthor: 'D' },
      { id: 'u2', title: 'AMBIG', firstAuthor: 'E' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);

    const counts = countByPmidSource(r.refs);
    expect(counts['esearch:doi']).toBe(r.summary.bySource['esearch:doi']);
    expect(counts['esearch:title-author']).toBe(
      r.summary.bySource['esearch:title-author'],
    );
    expect(counts['esearch:doi']).toBe(5);
    expect(counts['esearch:title-author']).toBe(2);
    expect(r.summary.unresolved).toBe(3);
  });

  it('11. Event stream invariants — started exactly once, each strategy emits exactly one strategy-started + strategy-complete, finished once with the same summary', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    controls.queueDoiBatch(new Map([['d0', { pmid: '1' }]]));
    controls.setTitleAuthorResolver(async () => ({ candidateCount: 0 }));

    const events: ResolverEvent[] = [];
    const resolver = createRefResolver({
      ncbi: port,
      onEvent: (e) => events.push(e),
    });
    const refs: RawRef[] = [
      { id: 'd0', doi: '10.1/x' },
      { id: 't0', title: 'X', firstAuthor: 'A' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);

    expect(events.filter((e) => e.kind === 'started')).toHaveLength(1);
    const finishedEvents = events.filter((e) => e.kind === 'finished');
    expect(finishedEvents).toHaveLength(1);
    if (finishedEvents[0].kind !== 'finished') throw new Error('unreachable');
    expect(finishedEvents[0].summary).toEqual(r.summary);

    // Each non-empty strategy emits exactly one started + one complete.
    const startedNames = events
      .filter((e) => e.kind === 'strategy-started')
      .map((e) => (e as { name: string }).name);
    const completedNames = events
      .filter((e) => e.kind === 'strategy-complete')
      .map((e) => (e as { name: string }).name);
    expect(startedNames).toEqual([
      'inline-verifier',
      'doi-batch',
      'title-author',
    ]);
    expect(completedNames).toEqual(startedNames);
  });

  it('12. Future-strategy plug-in — extra strategy runs in priority order and contributes to bySource', async () => {
    const { port, controls } = createFakeNcbiAdapter();
    // Pre-populate DOI hits so the built-in DOI strategy resolves them first.
    controls.queueDoiBatch(new Map([['d0', { pmid: '1' }]]));

    // FakeStrategy: claims any ref with `id` starting with 'fake-'.
    const fakeStrategy: ResolutionStrategy = {
      name: 'fake-cross-ref',
      accepts: (slot) => slot.ref.id.startsWith('fake-'),
      async run(slots) {
        return {
          resolutions: slots.map((s) => ({
            slotId: s.id,
            pmid: '999',
            source: 'crossref:doi' as const,
          })),
          errors: [],
        };
      },
    };

    const resolver = createRefResolver({
      ncbi: port,
      extraStrategies: [fakeStrategy],
    });
    const refs: RawRef[] = [
      { id: 'd0', doi: '10.1/x' },
      { id: 'fake-1' },
      { id: 'fake-2' },
    ];
    const r = await resolver.resolve(refs, dropController().signal);
    expect(r.summary.bySource['crossref:doi']).toBe(2);
    expect(r.refs.find((x) => x.id === 'fake-1')?.pmid_source).toBe('crossref:doi');
    expect(r.refs.find((x) => x.id === 'd0')?.pmid_source).toBe('esearch:doi');
  });
});

// ── Helpers ──────────────────────────────────────────────

function makeFakeJson(payload: unknown): {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
} {
  const body = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    },
  };
}

function countByPmidSource(
  refs: readonly { pmid: string; pmid_source: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of refs) {
    if (!r.pmid) continue;
    counts[r.pmid_source] = (counts[r.pmid_source] ?? 0) + 1;
  }
  return counts;
}
