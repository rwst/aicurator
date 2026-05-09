// Anthropic provider, composed from strategies.
//
// Schema enforcement: prompt-only (PassThrough). Anthropic doesn't
// honor a server-side schema parameter; the post-parse validate() inside
// composeProvider is what guarantees the result shape.

import type { Provider } from './types';
import type { HttpTransport, Base64Encoder } from './ports';
import { composeProvider } from './compose';
import { PassThroughDialect } from './strategies/schemaDialect';
import { AnthropicThinking } from './strategies/thinkingPolicy';
import { AnthropicFormat } from './strategies/messageFormat';

export function makeAnthropicProvider(
  apiKey: string,
  modelName: string,
  ports: { transport: HttpTransport; base64: Base64Encoder },
): Provider {
  return composeProvider({
    id: 'anthropic',
    enforcement: 'prompt-only',
    droppedFeatures: new Set(),
    dialect: PassThroughDialect,
    thinking: AnthropicThinking,
    format: AnthropicFormat,
    transport: ports.transport,
    base64: ports.base64,
    modelName,
    apiKey,
  });
}
