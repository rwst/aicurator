// Provider abstraction for LLM calls. Three concrete providers ship in
// v2601: Anthropic, OpenAI, OpenRouter. Each is a thin browser fetch
// wrapper — no SDKs, no service-worker proxy.

import type { Provider as ProviderName } from '../store';
import { makeAnthropicProvider } from './anthropic';
import { makeOpenAIProvider } from './openai';
import { makeOpenRouterProvider } from './openrouter';

export interface PdfInput {
  name: string;
  bytes: ArrayBuffer;
}

export interface LlmCall {
  systemPrompt: string;
  userText: string;
  pdfs: PdfInput[];
  // JSON schema for structured output. Honored where supported (OpenAI
  // and OpenRouter via response_format.json_schema). Anthropic falls back
  // to "ask for JSON in prompt + JS validate".
  schema?: object;
  // Optional cap. Defaults vary per provider.
  maxOutputTokens?: number;
}

export interface LlmResult {
  text: string;
  usage?: { input: number; output: number };
}

export interface Provider {
  call(req: LlmCall, signal: AbortSignal): Promise<LlmResult>;
}

export interface ProviderSettings {
  provider: ProviderName;
  apiKey: string;
  modelName: string;
}

export function makeProvider(settings: ProviderSettings): Provider {
  if (!settings.apiKey) throw new Error('API key is not set');
  if (!settings.modelName) throw new Error('Model name is not set');
  switch (settings.provider) {
    case 'Anthropic':
      return makeAnthropicProvider(settings.apiKey, settings.modelName);
    case 'OpenAI':
      return makeOpenAIProvider(settings.apiKey, settings.modelName);
    case 'OpenRouter':
      return makeOpenRouterProvider(settings.apiKey, settings.modelName);
  }
}
