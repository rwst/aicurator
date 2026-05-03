import type { Provider } from './provider';
import { makeOpenAIProvider } from './openai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function makeOpenRouterProvider(
  apiKey: string,
  modelName: string,
): Provider {
  return makeOpenAIProvider(apiKey, modelName, {
    baseUrl: OPENROUTER_BASE_URL,
    providerLabel: 'OpenRouter',
    extraHeaders: {
      // Optional attribution headers — OpenRouter recommends them but does
      // not require them. The Referer points at our extension origin so
      // OpenRouter dashboards can group requests by app.
      'HTTP-Referer': chrome.runtime.getURL('/'),
      'X-Title': 'AICurator',
    },
    // OpenRouter normalises this passthrough across upstream providers
    // (Anthropic thinking, OpenAI reasoning_effort, Gemini thinkingConfig).
    // Models without reasoning support silently ignore the field.
    extraBody: () => ({ reasoning: { effort: 'high' } }),
  });
}
