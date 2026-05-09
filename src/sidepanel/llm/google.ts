// Google (Gemini) provider, composed from strategies.
//
// Schema enforcement: sanitized (GeminiSanitizingDialect). The dialect
// strips the nine JSON-Schema keywords Gemini's responseSchema rejects
// and records each removal in the SanitizationReport. Lossy schemas
// produce best-effort JsonResult variants that carry the report.

import type { Provider } from './types';
import type { HttpTransport, Base64Encoder } from './ports';
import { composeProvider } from './compose';
import {
  GEMINI_DROPPED_FEATURES,
  GeminiSanitizingDialect,
} from './strategies/schemaDialect';
import { GoogleThinking } from './strategies/thinkingPolicy';
import { GoogleFormat } from './strategies/messageFormat';

export function makeGoogleProvider(
  apiKey: string,
  modelName: string,
  ports: { transport: HttpTransport; base64: Base64Encoder },
): Provider {
  return composeProvider({
    id: 'google',
    enforcement: 'sanitized',
    droppedFeatures: GEMINI_DROPPED_FEATURES,
    dialect: GeminiSanitizingDialect,
    thinking: GoogleThinking,
    format: GoogleFormat,
    transport: ports.transport,
    base64: ports.base64,
    modelName,
    apiKey,
  });
}
