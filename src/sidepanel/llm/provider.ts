// Public entry point for the LLM module.
//
// makeProvider(settings) wires the production HTTP transport + base64
// encoder into one of the four provider compositions. Callers get a
// Provider exposing `generateText` and `generateJson<T>` with a
// discriminated `JsonResult<T>` — strict on OpenAI/OpenRouter,
// best-effort (with a SanitizationReport) on Google and Anthropic.

import type { Provider as ProviderName } from '../store';
import { makeAnthropicProvider } from './anthropic';
import { makeGoogleProvider } from './google';
import { makeOpenAIProvider } from './openai';
import { makeOpenRouterProvider } from './openrouter';
import { createFetchTransport } from './adapters/prod/fetchTransport';
import { createBrowserBase64Encoder } from './adapters/prod/browserBase64';

export type {
  PdfInput,
  TextRequest,
  JsonRequest,
  TextResult,
  JsonResult,
  Provider,
  ProviderId,
  ProviderCapabilities,
  EnforcementMode,
  ReasoningLevel,
  Usage,
  SanitizationReport,
} from './types';
export { SchemaIncompatibleError } from './types';

export interface ProviderSettings {
  provider: ProviderName;
  apiKey: string;
  modelName: string;
}

export function makeProvider(settings: ProviderSettings) {
  if (!settings.apiKey) throw new Error('API key is not set');
  if (!settings.modelName) throw new Error('Model name is not set');
  const ports = {
    transport: createFetchTransport(),
    base64: createBrowserBase64Encoder(),
  };
  switch (settings.provider) {
    case 'Anthropic':
      return makeAnthropicProvider(settings.apiKey, settings.modelName, ports);
    case 'OpenAI':
      return makeOpenAIProvider(settings.apiKey, settings.modelName, ports);
    case 'OpenRouter':
      return makeOpenRouterProvider(
        settings.apiKey,
        settings.modelName,
        ports,
      );
    case 'Google':
      return makeGoogleProvider(settings.apiKey, settings.modelName, ports);
  }
}

// assertSchemaCompatible is exported separately from compose.ts because
// it requires the dialect — runners that want to fail fast call it
// against the constructed provider's dialect, accessed via this helper
// keyed off provider id.

import { assertSchemaCompatible as compatCheck } from './compose';
import type { SchemaDialect } from './strategies/schemaDialect';
import {
  GeminiSanitizingDialect,
  OpenAIStrictDialect,
  PassThroughDialect,
} from './strategies/schemaDialect';

const DIALECT_BY_PROVIDER: Record<ProviderName, SchemaDialect> = {
  Anthropic: PassThroughDialect,
  Google: GeminiSanitizingDialect,
  OpenAI: OpenAIStrictDialect,
  OpenRouter: OpenAIStrictDialect,
};

/** Throws SchemaIncompatibleError if the chosen provider would silently
 *  strip schema features. Run this at config-save time / pre-flight. */
export function assertSchemaCompatible(
  schema: object,
  provider: ProviderName,
): void {
  compatCheck(schema, { dialect: DIALECT_BY_PROVIDER[provider] });
}
