// Public surface types for the deepened reference resolver.

export type PmidSource =
  | 'inline'
  | 'esearch:doi'
  | 'esearch:title-author'
  | 'crossref:doi'
  | 'openalex:title';

export interface RawRef {
  /** Stable id chosen by the caller (e.g. `${reactionIdx}:${refIdx}`). */
  readonly id: string;
  readonly doi?: string;
  readonly pmcid?: string;
  readonly title?: string;
  readonly firstAuthor?: string;
  readonly year?: string;
  /** LLM-asserted source flag. 'inline' triggers verification (or
   *  unconditional strip until PDF text-extraction lands). */
  readonly pmid_source?: 'inline';
  /** LLM-asserted PMID alongside pmid_source==='inline'. */
  readonly pmid?: string;
}

export interface ResolvedRef {
  readonly id: string;
  /** '' when unresolved. */
  readonly pmid: string;
  /** '' when unknown. */
  readonly pmcid: string;
  /** '' when unresolved. */
  readonly pmid_source: PmidSource | '';
}

export interface ResolutionSummary {
  readonly total: number;
  readonly strippedInline: number;
  readonly bySource: Readonly<Record<PmidSource, number>>;
  readonly unresolved: number;
}

export interface TransientError {
  readonly strategy: string;
  /** Present iff this was a per-ref failure; absent for whole-batch failures. */
  readonly refId?: string;
  readonly message: string;
}

export interface ResolutionResult {
  /** 1:1 with input order. */
  readonly refs: readonly ResolvedRef[];
  readonly summary: ResolutionSummary;
  readonly transientErrors: readonly TransientError[];
}

export type ResolverEvent =
  | {
      kind: 'started';
      total: number;
      perStrategy: { name: string; candidates: number }[];
    }
  | { kind: 'strategy-started'; name: string; candidates: number }
  | {
      kind: 'progress';
      name: string;
      done: number;
      total: number;
      resolved: number;
    }
  | {
      kind: 'strategy-complete';
      name: string;
      resolved: number;
      candidates: number;
      elapsedMs: number;
    }
  | { kind: 'transient-error'; name: string; refId?: string; message: string }
  | { kind: 'finished'; summary: ResolutionSummary };

export class ResolverAbortedError extends Error {
  constructor(message = 'reference resolution aborted') {
    super(message);
    this.name = 'ResolverAbortedError';
  }
}

export interface RefResolver {
  resolve(
    refs: readonly RawRef[],
    signal: AbortSignal,
  ): Promise<ResolutionResult>;
}
