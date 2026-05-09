// Internal seam: a resolution strategy is one phase of the chain.
//
// The orchestrator iterates strategies in array order. For each, it:
//   1. filters slots by `accepts(slot)`,
//   2. emits 'strategy-started',
//   3. calls `run(filteredSlots, ctx)`,
//   4. applies returned resolutions to the master slot table,
//   5. removes resolved slots from the input the next strategy sees.
//
// Step 5 is the priority guarantee — encoded structurally, not as a
// caller convention. A future strategy is one new file plus one entry
// in the strategies array.

import type { PmidSource, RawRef, ResolverEvent } from './types';

export interface Slot {
  readonly id: string;
  readonly ref: Readonly<RawRef>;
}

export interface StrategyResolution {
  readonly slotId: string;
  readonly pmid?: string;
  readonly pmcid?: string;
  /** PmidSource | '' so a strategy can record a "negative resolution"
   *  (e.g. the inline-strip case) — treated as a final disposition for
   *  the slot, not as "fall through to the next strategy". */
  readonly source: PmidSource | '';
}

export interface StrategyContext {
  readonly signal: AbortSignal;
  readonly emit: (event: ResolverEvent) => void;
  /** Strategies use this for elapsed-ms timing in the
   *  'strategy-complete' event. The shared rate-limit budget is owned
   *  by the production adapter, not the orchestrator. */
  readonly now: () => number;
}

export interface StrategyRunResult {
  readonly resolutions: readonly StrategyResolution[];
  readonly errors: readonly { refId?: string; message: string }[];
}

export interface ResolutionStrategy {
  readonly name: string;
  /** Pure filter — orchestrator pre-selects slots before invoking. */
  accepts(slot: Slot): boolean;
  run(
    slots: readonly Slot[],
    ctx: StrategyContext,
  ): Promise<StrategyRunResult>;
}
