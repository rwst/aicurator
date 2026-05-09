// DoiBatchStrategy — chunks DOI inputs at doiBatchSize and calls
// ncbi.searchByDoi per chunk. Each chunk's HTTP burden (the production
// adapter's ESearch+ESummary) is opaque here; the rate-limit budget
// lives at the adapter's HTTP boundary so this strategy can stay
// concerned only with chunking + applying results.

import type { NcbiPort } from '../ports';
import type {
  ResolutionStrategy,
  Slot,
  StrategyContext,
  StrategyRunResult,
} from '../strategy';

export const DOI_BATCH_NAME = 'doi-batch';

export function createDoiBatchStrategy(opts: {
  ncbi: NcbiPort;
  batchSize: number;
}): ResolutionStrategy {
  return {
    name: DOI_BATCH_NAME,
    accepts(slot: Slot): boolean {
      return !slot.ref.pmid && !!slot.ref.doi;
    },
    async run(
      slots: readonly Slot[],
      ctx: StrategyContext,
    ): Promise<StrategyRunResult> {
      const resolutions: { slotId: string; pmid?: string; pmcid?: string; source: 'esearch:doi' }[] = [];
      const errors: { refId?: string; message: string }[] = [];

      const total = slots.length;
      let done = 0;
      let resolved = 0;

      for (let start = 0; start < slots.length; start += opts.batchSize) {
        if (ctx.signal.aborted) {
          throw ctx.signal.reason ?? new DOMException('aborted', 'AbortError');
        }
        const batch = slots.slice(start, start + opts.batchSize);
        try {
          const inputs = batch.map((s) => ({
            id: s.id,
            doi: s.ref.doi as string,
          }));
          const hits = await opts.ncbi.searchByDoi(inputs, ctx.signal);
          for (const slot of batch) {
            const hit = hits.get(slot.id);
            if (hit?.pmid) {
              resolutions.push({
                slotId: slot.id,
                pmid: hit.pmid,
                pmcid: hit.pmcid,
                source: 'esearch:doi',
              });
              resolved += 1;
            }
          }
        } catch (err) {
          if (isAbort(err)) throw err;
          // Whole-batch failure — record once with no refId. Refs in
          // this batch fall through to subsequent strategies with their
          // doi unresolved.
          errors.push({ message: (err as Error).message });
        }
        done += batch.length;
        ctx.emit({
          kind: 'progress',
          name: DOI_BATCH_NAME,
          done,
          total,
          resolved,
        });
      }

      return { resolutions, errors };
    },
  };
}

function isAbort(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return (err as Error)?.name === 'AbortError';
}
