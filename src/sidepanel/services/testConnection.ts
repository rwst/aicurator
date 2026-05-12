import { makeProvider } from '../llm/provider';
import { currentApiKey, settings } from '../store';

export interface TestResult {
  ok: boolean;
  message: string;
  usage?: { input: number; output: number };
}

const TIMEOUT_MS = 30_000;

// Minimal smoke-test call: 1-token completion to validate auth + model
// + network reachability. Used by the "Test connection" button in
// Settings — never used by the real Extract / Summate pipelines.
export async function testConnection(): Promise<TestResult> {
  const apiKey = currentApiKey();
  if (!apiKey) {
    return { ok: false, message: `${settings.provider} API key is not set` };
  }
  if (!settings.modelName) {
    return { ok: false, message: 'Model name is not set' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const provider = makeProvider({
      provider: settings.provider,
      apiKey,
      modelName: settings.modelName,
    });
    const result = await provider.generateText(
      {
        systemPrompt: 'You are a connectivity probe. Reply with just "ok".',
        userText: 'ping',
        maxOutputTokens: 16,
      },
      ctrl.signal,
    );
    return {
      ok: true,
      message: `OK${result.usage ? ` · ${result.usage.input}+${result.usage.output} tokens` : ''}`,
      usage: result.usage,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { ok: false, message: 'Timed out after 30s' };
    }
    return { ok: false, message: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
