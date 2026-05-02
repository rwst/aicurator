import type { LlmCall, LlmResult, Provider } from './provider';
import { arrayBufferToBase64 } from '../lib/base64';

const ANTHROPIC_VERSION = '2023-06-01';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_TOKENS = 16384;

interface AnthropicContentBlock {
  type: 'text' | 'document';
  text?: string;
  source?: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
}

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
}

export function makeAnthropicProvider(
  apiKey: string,
  modelName: string,
): Provider {
  return {
    async call(req: LlmCall, signal: AbortSignal): Promise<LlmResult> {
      const content: AnthropicContentBlock[] = [];
      for (const pdf of req.pdfs) {
        const data = await arrayBufferToBase64(pdf.bytes);
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
        });
      }
      content.push({ type: 'text', text: req.userText });

      const body = {
        model: modelName,
        max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        system: req.systemPrompt,
        messages: [{ role: 'user', content }],
      };

      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 200)}`);
      }

      const json = (await resp.json()) as AnthropicResponse;
      const text = (json.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      return {
        text,
        usage: json.usage
          ? { input: json.usage.input_tokens, output: json.usage.output_tokens }
          : undefined,
      };
    },
  };
}
