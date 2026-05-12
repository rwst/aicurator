// OpenRouter provider — same wire format as OpenAI, with a different
// thinking policy (unconditional) and a custom base URL. The compose
// hides what used to be an `extraBody` callback and a base-URL toggle:
// OpenRouter is now a clean composition of standard parts.

import type { Provider } from './types';
import type { HttpTransport, Base64Encoder } from './ports';
import type { MessageFormat } from './strategies/messageFormat';
import { composeProvider } from './compose';
import { OpenAIStrictDialect } from './strategies/schemaDialect';
import { OpenRouterUnconditional } from './strategies/thinkingPolicy';
import { makeOpenAIFormat } from './strategies/messageFormat';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const baseFormat = makeOpenAIFormat({
  baseUrl: OPENROUTER_BASE_URL,
  errorLabel: 'OpenRouter',
});

// Force OpenRouter to only route to upstream providers that honor every
// parameter we send (response_format, reasoning, max_tokens, …). Without
// this OpenRouter may silently fall back to a provider that drops
// response_format, in which case Extract's structured-output schema
// becomes a non-binding suggestion and the response comes back as prose.
const OpenRouterFormat: MessageFormat = {
  errorLabel: baseFormat.errorLabel,
  format(input) {
    const f = baseFormat.format(input);
    return {
      ...f,
      body: {
        ...(f.body as Record<string, unknown>),
        provider: { require_parameters: true },
      },
    };
  },
  parse: baseFormat.parse,
};

// Optional attribution — OpenRouter recommends but does not require these.
// chrome.runtime.getURL is unavailable in node tests; we degrade gracefully.
function openRouterAttributionHeaders(): Record<string, string> {
  let referer = '';
  try {
    referer = chrome.runtime.getURL('/');
  } catch {
    /* not running in extension context (e.g. tests) — skip Referer */
  }
  return {
    ...(referer ? { 'HTTP-Referer': referer } : {}),
    'X-Title': 'AICurator',
  };
}

export function makeOpenRouterProvider(
  apiKey: string,
  modelName: string,
  ports: { transport: HttpTransport; base64: Base64Encoder },
): Provider {
  return composeProvider({
    id: 'openrouter',
    enforcement: 'strict',
    droppedFeatures: new Set(),
    dialect: OpenAIStrictDialect,
    thinking: OpenRouterUnconditional,
    format: OpenRouterFormat,
    transport: ports.transport,
    base64: ports.base64,
    modelName,
    apiKey,
    extraHeaders: openRouterAttributionHeaders(),
  });
}
