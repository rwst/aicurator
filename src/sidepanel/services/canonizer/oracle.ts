// Default SmallMoleculeOracle — wraps the existing isLikelySmallMolecule
// classifier. Bundled as a one-line wrapper so callers can replace it
// (e.g. with a curator-managed list backed by chrome.storage.sync)
// without touching the canonizer itself.

import { isLikelySmallMolecule } from '../smallMolecules';
import type { SmallMoleculeOracle } from './types';

export function createDefaultOracle(): SmallMoleculeOracle {
  return { isLikelySmallMolecule };
}
