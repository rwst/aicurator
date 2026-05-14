// RFC tests 1–14 for the deepened canonizer. Vitest, node env, no
// jsdom, no real network, no real time.

import { describe, expect, it } from 'vitest';
import {
  CanonizerAbortedError,
  createCanonizer,
  REACTION_LAYOUT,
  type CanonizeColumnLayout,
  type GeneHit,
} from './index';
import { createFakeUniprot } from './adapters/uniprotFake';
import { createVirtualClock } from './adapters/clockVirtual';
import {
  compileReplacements,
  rewriteFreeText,
} from '../entityParser';

// ── Helpers ──────────────────────────────────────────────

function hit(symbol: string, reviewed = true): GeneHit {
  return { geneSymbol: symbol, reviewed, taxon: 9606 };
}

function rangeOf(rows: ReadonlyArray<ReadonlyArray<string>>) {
  return { startRow: 1, endRow: rows.length };
}

function row(...cells: string[]): string[] {
  return cells;
}

// ── 1. Priority — reviewed-SPARQL hit short-circuits TrEMBL and REST ─

describe('createCanonizer', () => {
  it('1. Priority — reviewed-SPARQL hit short-circuits TrEMBL and REST', async () => {
    const { port, controls } = createFakeUniprot();
    controls.queueReviewed(new Map([['TP53', [hit('TP53')]]]));
    // queueing nothing for alt/rest — calls would be visible but
    // also the assertion below is on the `calls` log.
    controls.setRestResolver(async () => {
      throw new Error('rest must not be called for TP53');
    });

    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'TP53 [cytosol]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    // counts.reviewedSparql is 0 because TP53 is a true no-op (canonical
    // === curator's spelling) — strategy ATTRIBUTION counts the pass
    // when a real replacement is recorded. The call-log invariant is
    // what proves priority.
    const calls = controls.calls();
    expect(calls.some((c) => c.method === 'searchSparqlReviewed')).toBe(true);
    expect(calls.some((c) => c.method === 'searchSparqlAlt')).toBe(false);
    expect(calls.some((c) => c.method === 'searchRest')).toBe(false);
    expect(r.report.replacements.size).toBe(0);
  });

  it('1b. Priority + counts — reviewed pass attribution when a real replacement is recorded', async () => {
    const { port, controls } = createFakeUniprot();
    // Curator types 'Tipin'; uppercase query 'TIPIN' resolves to 'TIPIN'.
    controls.queueReviewed(new Map([['TIPIN', [hit('TIPIN')]]]));
    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'Tipin [cytosol]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.report.replacements.get('Tipin')).toBe('TIPIN');
    expect(r.report.counts).toEqual({
      reviewedSparql: 1,
      altName: 0,
      rest: 0,
    });
  });

  it('1c. Alt-protein-name fallback — "Ku86" resolves to XRCC5 via the alt-name pass when the gene-name pass misses', async () => {
    const { port, controls } = createFakeUniprot();
    // Gene-name SPARQL returns nothing for KU86 — Ku86 is not a gene
    // alias, only a protein synonym (UniProt up:alternativeName/fullName
    // on P13010). Alt-name SPARQL is what catches it.
    controls.queueReviewed(new Map());
    controls.queueAlt(new Map([['KU86', [hit('XRCC5')]]]));
    // REST must not run — the alt-name pass already resolved it.
    controls.setRestResolver(async () => {
      throw new Error('rest must not be called for Ku86');
    });

    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'Ku86 [nucleoplasm]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.report.replacements.get('Ku86')).toBe('XRCC5');
    expect(r.report.counts.altName).toBe(1);
    expect(r.rewritten[0].after[2]).toBe('XRCC5 [nucleoplasm]');
  });

  it('2. Ambiguity — two distinct reviewed gene hits leave the label unchanged', async () => {
    const { port, controls } = createFakeUniprot();
    controls.queueReviewed(
      new Map([['CDC2', [hit('CDK1'), hit('CDC2')]]]),
    );
    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'CDC2 [cytosol]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.report.replacements.has('CDC2')).toBe(false);
    expect([...r.report.ambiguous]).toContain('CDC2');
  });

  it('3. Case preservation — replacement key is curator spelling, value is uppercase; true no-ops drop out', async () => {
    const { port, controls } = createFakeUniprot();
    controls.queueReviewed(
      new Map([
        ['TP53', [hit('TP53')]],
      ]),
    );
    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'Tp53 [cytosol] | TP53 [nucleoplasm]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.report.replacements.get('Tp53')).toBe('TP53');
    expect(r.report.replacements.has('TP53')).toBe(false);
  });

  it('4. Small-molecule short-circuit — ATP never reaches UniProt', async () => {
    const { port, controls } = createFakeUniprot();
    controls.queueReviewed(new Map());
    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'ATP [cytosol]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.report.skippedSmallMolecules).toContain('ATP');
    const calls = controls.calls();
    for (const c of calls) {
      expect(c.labels).not.toContain('ATP');
    }
  });

  it('5. Complex-component rewriting — colon-separated parts canonized independently, scaffolding preserved', async () => {
    const { port, controls } = createFakeUniprot();
    controls.queueReviewed(
      new Map([
        ['P65', [hit('RELA')]],
        ['P50', [hit('NFKB1')]],
      ]),
    );
    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'p65:p50 [nucleoplasm]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.rewritten[0].after[2]).toBe('RELA:NFKB1 [nucleoplasm]');
  });

  it('6. Free-text word boundaries — "ORC" rewrites in prose but "OORCBinder" stays', () => {
    const compiled = compileReplacements(new Map([['ORC', 'ORC1']]));
    expect(rewriteFreeText('ORC binds origin', compiled)).toBe(
      'ORC1 binds origin',
    );
    expect(rewriteFreeText('OORCBinder is intact', compiled)).toBe(
      'OORCBinder is intact',
    );
  });

  it('7. Longest-first rewrite ordering — "ORC complex" wins over "ORC"', () => {
    const compiled = compileReplacements(
      new Map([
        ['ORC', 'ORC1'],
        ['ORC complex', 'ORC1234'],
      ]),
    );
    expect(rewriteFreeText('ORC complex assembles', compiled)).toBe(
      'ORC1234 assembles',
    );
  });

  it('8. Length<3 filter — "p1" replacement is dropped at compile time', () => {
    const compiled = compileReplacements(new Map([['p1', 'CDK1']]));
    expect(rewriteFreeText('p1 binding', compiled)).toBe('p1 binding');
    expect(compiled.entries).toHaveLength(0);
  });

  it('9. End-to-end mixed batch — counts reflect per-pass attribution', async () => {
    const { port, controls } = createFakeUniprot();
    // 5 reviewed hits with real diffs.
    controls.queueReviewed(
      new Map([
        ['Cdk1Lower', [hit('CDK1')]],
        ['Cdk2Lower', [hit('CDK2')]],
        ['Cdk4Lower', [hit('CDK4')]],
        ['Cdk6Lower', [hit('CDK6')]],
        ['Cdk7Lower', [hit('CDK7')]],
      ].map(([k, v]) => [
        (k as string).toUpperCase(),
        v as ReadonlyArray<GeneHit>,
      ])),
    );
    // 3 alt-protein-name hits — mapped via up:alternativeName.
    controls.queueAlt(
      new Map([
        ['AltName1', [hit('AN1')]],
        ['AltName2', [hit('AN2')]],
        ['AmbigA', [hit('A'), hit('B')]], // ambiguous via alt-name pass
      ].map(([k, v]) => [
        (k as string).toUpperCase(),
        v as ReadonlyArray<GeneHit>,
      ])),
    );
    // 2 REST hits + 1 noMatch (REST returns []).
    const restByUpper: Record<string, GeneHit[]> = {
      REST1LOWER: [hit('REST1A')],
      REST2LOWER: [hit('REST2A')],
      NOMATCH1LOWER: [],
    };
    controls.setRestResolver(async (label) => restByUpper[label] ?? []);

    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const labels = [
      'Cdk1Lower',
      'Cdk2Lower',
      'Cdk4Lower',
      'Cdk6Lower',
      'Cdk7Lower',
      'AltName1',
      'AltName2',
      'AmbigA',
      'Rest1Lower',
      'Rest2Lower',
      'NoMatch1Lower',
    ];
    const cells = labels.map((l) => `${l} [cytosol]`).join(' | ');
    const rows = [row('Title', '', cells, '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.report.counts.reviewedSparql).toBe(5);
    expect(r.report.counts.altName).toBe(2);
    expect(r.report.counts.rest).toBe(2);
    expect([...r.report.ambiguous]).toContain('AmbigA');
    expect([...r.report.noMatch]).toContain('NoMatch1Lower');
    expect(r.report.replacements.size).toBe(9);
  });

  it('10. AbortSignal mid-flight — no further SPARQL calls after abort', async () => {
    const { port, controls } = createFakeUniprot();
    const ctrl = new AbortController();
    controls.queueReviewed(new Map());
    // After reviewed returns empty, the alt-name pass is next; it
    // should never run because we abort first.
    controls.rejectAltWith(new Error('alt must not run'));
    // Abort right after reviewed resolves: schedule via Promise.resolve.
    Promise.resolve().then(() => ctrl.abort());

    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [row('Title', '', 'NotInReviewed [cytosol]', '', '', '')];
    await expect(
      canonizer.canonize({
        rows,
        range: rangeOf(rows),
        signal: ctrl.signal,
      }),
    ).rejects.toBeInstanceOf(CanonizerAbortedError);
    expect(controls.calls().some((c) => c.method === 'searchSparqlAlt')).toBe(false);
  });

  it('11. 60s SPARQL timeout under virtual time — searchSparqlReviewed hangs forever; canonize rejects after 60_000 virtual ms', async () => {
    const clock = createVirtualClock();
    // Build the production HTTP adapter with a fake fetch that hangs.
    // We get the real withTimeout behavior under virtual time.
    const { createHttpUniprotAdapter } = await import('./adapters/uniprotHttp');
    const fakeFetch = (
      _url: string,
      init?: { signal?: AbortSignal },
    ): Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
      text(): Promise<string>;
    }> => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return; // would hang forever
        if (sig.aborted) {
          reject(sig.reason ?? new DOMException('aborted', 'AbortError'));
          return;
        }
        sig.addEventListener('abort', () => {
          reject(sig.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    };
    const uniprot = createHttpUniprotAdapter({ fetch: fakeFetch, clock });
    const canonizer = createCanonizer({
      uniprot,
      layout: REACTION_LAYOUT,
      clock,
    });
    const rows = [row('Title', '', 'TIPIN [cytosol]', '', '', '')];
    const ctrl = new AbortController();
    // Attach the rejection handler synchronously — any rejection that
    // surfaces during clock.runAll() then has a registered handler and
    // can't be flagged as unhandled by vitest.
    const settled = canonizer
      .canonize({
        rows,
        range: rangeOf(rows),
        signal: ctrl.signal,
      })
      .then(
        () => ({ ok: true } as const),
        (err: Error) => ({ ok: false as const, err }),
      );
    await clock.runAll();
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.message).toMatch(/timed out/i);
    }
  });

  it('12. Layout dispatch — column-mechanism mapping is honored', async () => {
    const { port, controls } = createFakeUniprot();
    controls.queueReviewed(new Map([['P65', [hit('RELA')]]]));

    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    // Column 2 is 'entities' in REACTION_LAYOUT — pipe-delimited
    // entities should be parsed and canonized cell-aware, preserving
    // pipe-separator and compartment formatting.
    const rows = [row('Title', '', 'p65 [nucleoplasm] | p65 [cytosol]', '', '', '')];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    expect(r.rewritten[0].after[2]).toBe(
      'RELA [nucleoplasm] | RELA [cytosol]',
    );
  });

  it('13. Layout future-proofing — alternate layout (8-column sheet, columns shifted) works', async () => {
    const { port, controls } = createFakeUniprot();
    controls.queueReviewed(new Map([['P65', [hit('RELA')]]]));

    // 8-column sheet: free-text 0..2, entity 3..6, untouched 7.
    const layout: CanonizeColumnLayout = {
      freeText: [0, 1, 2],
      entities: [3, 4, 5, 6],
      isSkippableRow: (row) => !row[0],
    };
    const canonizer = createCanonizer({ uniprot: port, layout });
    // Row of 8 columns.
    const rows = [
      [
        'Type',
        'Title',
        'Notes',
        'p65 [nucleoplasm]',
        'p65 [cytosol]',
        '',
        '',
        'tag',
      ],
    ];
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    const after = r.rewritten[0].after;
    expect(after[3]).toBe('RELA [nucleoplasm]');
    expect(after[4]).toBe('RELA [cytosol]');
    expect(after[7]).toBe('tag'); // untouched column unchanged
  });

  it('14. Skip-row predicate respected — skipped rows do not contribute bare names and are not in result.rewritten', async () => {
    const { port, controls } = createFakeUniprot();
    // Queue a reviewed map that would resolve "X" if it were sent —
    // the skip predicate should ensure it isn't.
    controls.queueReviewed(new Map([['X', [hit('XGENE')]]]));
    controls.setRestResolver(async () => []);

    const canonizer = createCanonizer({
      uniprot: port,
      layout: REACTION_LAYOUT,
    });
    const rows = [
      row('## Branch heading', '', 'X [cytosol]', '', '', ''), // skippable subtitle
      row('(parens-gap)', '', 'X [cytosol]', '', '', ''), // skippable gap
      row('Real reaction', '', 'p65 [cytosol]', '', '', ''), // not skippable
    ];
    controls.queueReviewed(new Map([['P65', [hit('RELA')]]]));
    const r = await canonizer.canonize({
      rows,
      range: rangeOf(rows),
      signal: new AbortController().signal,
    });
    // Only one row processed.
    expect(r.rewritten).toHaveLength(1);
    expect(r.rewritten[0].rowIndex).toBe(3);
    // 'X' was a skippable-row payload — so it should never have been
    // queried. The first reviewed call should have queried only ['P65'].
    const reviewedCalls = controls
      .calls()
      .filter((c) => c.method === 'searchSparqlReviewed');
    // The first call's labels should be exactly the queryable from
    // non-skipped rows.
    expect(reviewedCalls[0].labels).toEqual(['P65']);
  });
});
