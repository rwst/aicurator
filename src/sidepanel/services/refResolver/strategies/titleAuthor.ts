// TitleAuthorStrategy — fans out per-ref title+author probes at
// `concurrency`. Strict-single-match acceptance lives inside the
// production NCBI adapter (it returns pmid only when candidateCount
// === 1), so this strategy just adopts whatever the port returns.
//
// Per-ref errors are contained — they record into transientErrors with
// a refId and the rest of the fan-out continues.

import type { NcbiPort } from '../ports';
import type {
  ResolutionStrategy,
  Slot,
  StrategyContext,
  StrategyRunResult,
} from '../strategy';
import { mapWithLimit } from '../../../lib/concurrent';

export const TITLE_AUTHOR_NAME = 'title-author';

export function createTitleAuthorStrategy(opts: {
  ncbi: NcbiPort;
  concurrency: number;
}): ResolutionStrategy {
  return {
    name: TITLE_AUTHOR_NAME,
    accepts(slot: Slot): boolean {
      return (
        !slot.ref.pmid && !!slot.ref.title && !!slot.ref.firstAuthor
      );
    },
    async run(
      slots: readonly Slot[],
      ctx: StrategyContext,
    ): Promise<StrategyRunResult> {
      const resolutions: {
        slotId: string;
        pmid?: string;
        source: 'esearch:title-author';
      }[] = [];
      const errors: { refId?: string; message: string }[] = [];
      const total = slots.length;
      let done = 0;
      let resolved = 0;

      await mapWithLimit(slots, opts.concurrency, async (slot) => {
        if (ctx.signal.aborted) {
          // Each in-flight worker checks; the orchestrator throws once
          // the run() promise resolves.
          return;
        }
        try {
          const res = await opts.ncbi.searchByTitleAuthor(
            {
              title: slot.ref.title as string,
              firstAuthor: slot.ref.firstAuthor as string,
              year: slot.ref.year || undefined,
            },
            ctx.signal,
          );
          if (res.pmid) {
            resolutions.push({
              slotId: slot.id,
              pmid: res.pmid,
              source: 'esearch:title-author',
            });
            resolved += 1;
          }
        } catch (err) {
          if (isAbort(err)) {
            // Orchestrator will detect abort via signal; don't record
            // as transient error.
            return;
          }
          errors.push({
            refId: slot.id,
            message: (err as Error).message,
          });
        } finally {
          done += 1;
          ctx.emit({
            kind: 'progress',
            name: TITLE_AUTHOR_NAME,
            done,
            total,
            resolved,
          });
        }
      });

      return { resolutions, errors };
    },
  };
}

function isAbort(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return (err as Error)?.name === 'AbortError';
}
