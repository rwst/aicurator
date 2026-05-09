// createRefResolver — orchestrator. Owns:
//   - the strategy chain (priority enforced structurally by stripping
//     resolved slots before the next strategy runs),
//   - the single error-path invariant (resolve() throws only on abort;
//     every other failure becomes data on `transientErrors`),
//   - the 1:1 input-order output guarantee,
//   - the audit aggregation (summary.bySource computed from the final
//     ResolvedRef[] so per-ref provenance and the aggregate count
//     cannot drift),
//   - the event stream (started → strategy-started* → progress* →
//     strategy-complete* → finished, plus transient-error events at
//     emission time).
//
// What lives outside the orchestrator:
//   - The shared rate-limit budget — owned by the production NCBI
//     adapter, where the actual HTTP calls happen. Exposing it here
//     would force the orchestrator to count "1 batch = N calls" at
//     the wrong layer.
//   - Strategy-specific config (doiBatchSize, titleAuthorConcurrency)
//     — accepted as factory options here, threaded into the strategies
//     at construction.

import type { NcbiPort, Clock } from './ports';
import {
  ResolverAbortedError,
  type PmidSource,
  type RawRef,
  type RefResolver,
  type ResolutionResult,
  type ResolutionSummary,
  type ResolvedRef,
  type ResolverEvent,
  type TransientError,
} from './types';
import {
  type ResolutionStrategy,
  type Slot,
  type StrategyResolution,
} from './strategy';
import { createInlineVerifierStrategy, INLINE_VERIFIER_NAME } from './strategies/inlineVerifier';
import { createDoiBatchStrategy } from './strategies/doiBatch';
import { createTitleAuthorStrategy } from './strategies/titleAuthor';

export type {
  PmidSource,
  RawRef,
  RefResolver,
  ResolutionResult,
  ResolutionSummary,
  ResolvedRef,
  ResolverEvent,
  TransientError,
} from './types';
export { ResolverAbortedError } from './types';
export type { NcbiPort, Clock, HttpFetch } from './ports';
export type {
  ResolutionStrategy,
  Slot,
  StrategyContext,
  StrategyResolution,
  StrategyRunResult,
} from './strategy';
export { createTokenBucketLimiter, type RateLimiter } from './rateLimiter';

const ALL_SOURCES: readonly PmidSource[] = [
  'inline',
  'esearch:doi',
  'esearch:title-author',
  'crossref:doi',
  'openalex:title',
];

export interface CreateRefResolverOptions {
  ncbi: NcbiPort;
  clock?: Clock;
  onEvent?: (e: ResolverEvent) => void;
  doiBatchSize?: number;
  titleAuthorConcurrency?: number;
  /** Append additional strategies after the three built-ins. */
  extraStrategies?: readonly ResolutionStrategy[];
}

export function createRefResolver(
  opts: CreateRefResolverOptions,
): RefResolver {
  const doiBatchSize = opts.doiBatchSize ?? 200;
  const titleAuthorConcurrency = opts.titleAuthorConcurrency ?? 3;

  const strategies: ResolutionStrategy[] = [
    createInlineVerifierStrategy(),
    createDoiBatchStrategy({ ncbi: opts.ncbi, batchSize: doiBatchSize }),
    createTitleAuthorStrategy({
      ncbi: opts.ncbi,
      concurrency: titleAuthorConcurrency,
    }),
    ...(opts.extraStrategies ?? []),
  ];

  const now = opts.clock ? () => opts.clock!.now() : () => Date.now();

  return {
    async resolve(
      refs: readonly RawRef[],
      signal: AbortSignal,
    ): Promise<ResolutionResult> {
      const emit = (event: ResolverEvent): void => {
        opts.onEvent?.(event);
      };

      const slots: Slot[] = refs.map((ref) => ({ id: ref.id, ref }));

      // outcomes is keyed by slot id and built up as strategies run.
      // Order is preserved by walking refs at the end.
      const outcomes = new Map<string, StrategyResolution>();
      const transientErrors: TransientError[] = [];

      // Pre-compute the per-strategy candidate counts for the 'started' event.
      const perStrategy = strategies.map((s) => ({
        name: s.name,
        candidates: slots.filter((slot) => s.accepts(slot)).length,
      }));
      emit({ kind: 'started', total: slots.length, perStrategy });

      // Walking pool of unresolved slots — each strategy strips its
      // resolved slots before the next strategy sees them.
      let pool: Slot[] = slots.slice();

      try {
        for (const strategy of strategies) {
          if (signal.aborted) throw new ResolverAbortedError();
          const candidates = pool.filter((slot) => strategy.accepts(slot));
          emit({
            kind: 'strategy-started',
            name: strategy.name,
            candidates: candidates.length,
          });
          if (candidates.length === 0) {
            emit({
              kind: 'strategy-complete',
              name: strategy.name,
              resolved: 0,
              candidates: 0,
              elapsedMs: 0,
            });
            continue;
          }
          const t0 = now();
          let runResult;
          try {
            runResult = await strategy.run(candidates, {
              signal,
              now,
              emit,
            });
          } catch (err) {
            if (isAbortError(err)) throw new ResolverAbortedError();
            // Strategy unexpectedly threw — record as a whole-batch
            // failure and continue the chain.
            const message = (err as Error).message ?? String(err);
            transientErrors.push({ strategy: strategy.name, message });
            emit({
              kind: 'transient-error',
              name: strategy.name,
              message,
            });
            emit({
              kind: 'strategy-complete',
              name: strategy.name,
              resolved: 0,
              candidates: candidates.length,
              elapsedMs: now() - t0,
            });
            continue;
          }
          if (signal.aborted) throw new ResolverAbortedError();
          for (const r of runResult.resolutions) {
            outcomes.set(r.slotId, r);
          }
          for (const e of runResult.errors) {
            transientErrors.push({ strategy: strategy.name, ...e });
            emit({
              kind: 'transient-error',
              name: strategy.name,
              refId: e.refId,
              message: e.message,
            });
          }
          // Strip slots that received any disposition (positive or
          // negative) from the pool — that's the priority guarantee.
          pool = pool.filter((slot) => !outcomes.has(slot.id));
          const resolvedThisStrategy = runResult.resolutions.filter(
            (r) => !!r.pmid,
          ).length;
          emit({
            kind: 'strategy-complete',
            name: strategy.name,
            resolved: resolvedThisStrategy,
            candidates: candidates.length,
            elapsedMs: now() - t0,
          });
        }
      } catch (err) {
        if (err instanceof ResolverAbortedError) throw err;
        if (isAbortError(err)) throw new ResolverAbortedError();
        throw err; // Genuinely unexpected — programmer error, propagate.
      }

      // Build 1:1 ResolvedRef[] from outcomes + originals.
      const resolved: ResolvedRef[] = refs.map((ref) => {
        const o = outcomes.get(ref.id);
        if (!o) {
          // No strategy emitted a disposition for this ref — surface as
          // unresolved. Carry through caller-supplied pmcid since some
          // refs come in already pmcid-equipped.
          return {
            id: ref.id,
            pmid: '',
            pmcid: ref.pmcid ?? '',
            pmid_source: '',
          };
        }
        return {
          id: ref.id,
          pmid: o.pmid ?? '',
          pmcid: o.pmcid ?? ref.pmcid ?? '',
          pmid_source: o.source,
        };
      });

      // Aggregate the audit summary from the final ResolvedRef[] — same
      // data that `pmid_source` is computed from, so per-ref labels and
      // aggregate counts cannot drift.
      const bySource: Record<PmidSource, number> = Object.fromEntries(
        ALL_SOURCES.map((s) => [s, 0]),
      ) as Record<PmidSource, number>;
      let strippedInline = 0;
      let unresolved = 0;
      for (const r of resolved) {
        if (r.pmid && r.pmid_source !== '') {
          bySource[r.pmid_source] += 1;
        } else {
          unresolved += 1;
          // Only count as "stripped inline" if the original ref was
          // inline-flagged AND the inline-verifier wrote a (negative)
          // outcome for it — i.e. we actively removed it, not "strategy
          // never accepted".
          const original = refs.find((ref) => ref.id === r.id);
          const out = outcomes.get(r.id);
          if (
            original?.pmid_source === 'inline' &&
            out &&
            !out.pmid
          ) {
            strippedInline += 1;
          }
        }
      }
      const summary: ResolutionSummary = {
        total: refs.length,
        strippedInline,
        bySource,
        unresolved,
      };
      emit({ kind: 'finished', summary });
      return {
        refs: resolved,
        summary,
        transientErrors,
      };
    },
  };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof ResolverAbortedError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return (err as Error)?.name === 'AbortError';
}

// ── Inline-verifier name re-export so callers/tests can refer to it
// without bouncing through the strategies subdir. ──────────────────
export { INLINE_VERIFIER_NAME };
