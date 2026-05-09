// InlineVerifier — first phase of the chain.
//
// Today: returns a "negative resolution" (pmid:'', source:'') for every
// inline-flagged ref, which the orchestrator records as
// summary.strippedInline and then strips the slot from the chain. This
// satisfies the no-fabrication rule: an LLM-claimed inline PMID cannot
// be verified without PDF text-extraction, so we drop them and let
// downstream strategies (DOI, title+author) re-discover.
//
// Future: when PDF text extraction lands, this strategy verifies each
// inline PMID against the extracted text. Verified ones become
// real resolutions with source='inline'; the rest fall through with
// negative resolutions.

import type {
  ResolutionStrategy,
  Slot,
  StrategyRunResult,
} from '../strategy';

export const INLINE_VERIFIER_NAME = 'inline-verifier';

export function createInlineVerifierStrategy(): ResolutionStrategy {
  return {
    name: INLINE_VERIFIER_NAME,
    accepts(slot: Slot): boolean {
      return slot.ref.pmid_source === 'inline';
    },
    async run(slots): Promise<StrategyRunResult> {
      // No PDF text-extraction integration yet — strip everything.
      const resolutions = slots.map((s) => ({
        slotId: s.id,
        pmid: '',
        source: '' as const,
      }));
      return { resolutions, errors: [] };
    },
  };
}
