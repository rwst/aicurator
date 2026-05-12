// Provider enum lives in its own module so non-store consumers
// (services/userSettingsFile.ts in particular) can import it without
// pulling in the whole reactive store and creating a circular import.

export type Provider = 'Anthropic' | 'OpenAI' | 'OpenRouter' | 'Google';

export const PROVIDERS: readonly Provider[] = [
  'Anthropic',
  'OpenAI',
  'OpenRouter',
  'Google',
] as const;
