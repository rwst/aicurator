// Production Base64Encoder: delegates to the existing browser-only
// FileReader-backed implementation in lib/base64.ts. That implementation
// is materially faster than the String.fromCharCode loop for the
// multi-MB PDF inputs the LLM module typically encodes.

import type { Base64Encoder } from '../../ports';
import { arrayBufferToBase64 } from '../../../lib/base64';

export function createBrowserBase64Encoder(): Base64Encoder {
  return { encode: arrayBufferToBase64 };
}
