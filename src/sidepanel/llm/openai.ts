// OpenAI provider, composed from strategies.
//
// Schema enforcement: strict — server-side response_format.json_schema
// with strict:true. The post-parse validate() in composeProvider runs
// anyway so callers get uniform "data is valid or call rejects"
// semantics.

import type { Provider } from './types';
import type { HttpTransport, Base64Encoder } from './ports';
import { composeProvider } from './compose';
import { OpenAIStrictDialect } from './strategies/schemaDialect';
import { OpenAIThinking } from './strategies/thinkingPolicy';
import { OpenAIFormat } from './strategies/messageFormat';

export function makeOpenAIProvider(
  apiKey: string,
  modelName: string,
  ports: { transport: HttpTransport; base64: Base64Encoder },
): Provider {
  return composeProvider({
    id: 'openai',
    enforcement: 'strict',
    droppedFeatures: new Set(),
    dialect: OpenAIStrictDialect,
    thinking: OpenAIThinking,
    format: OpenAIFormat,
    transport: ports.transport,
    base64: ports.base64,
    modelName,
    apiKey,
  });
}
