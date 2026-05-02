import type { LlmCall, LlmResult, Provider } from './provider';
import { arrayBufferToBase64 } from '../lib/base64';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 16384;

export interface OpenAILikeOptions {
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  providerLabel?: string; // for error messages
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIUserContent {
  type: 'text' | 'file';
  text?: string;
  file?: { filename: string; file_data: string };
}

interface OpenAIRequestBody {
  model: string;
  messages: {
    role: 'system' | 'user';
    content: string | OpenAIUserContent[];
  }[];
  max_tokens: number;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: object; strict?: boolean };
  };
}

export function makeOpenAIProvider(
  apiKey: string,
  modelName: string,
  options: OpenAILikeOptions = {},
): Provider {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const label = options.providerLabel ?? 'OpenAI';
  const extra = options.extraHeaders ?? {};

  return {
    async call(req: LlmCall, signal: AbortSignal): Promise<LlmResult> {
      const userContent: OpenAIUserContent[] = [];
      for (const pdf of req.pdfs) {
        const b64 = await arrayBufferToBase64(pdf.bytes);
        userContent.push({
          type: 'file',
          file: {
            filename: pdf.name,
            file_data: `data:application/pdf;base64,${b64}`,
          },
        });
      }
      userContent.push({ type: 'text', text: req.userText });

      const body: OpenAIRequestBody = {
        model: modelName,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };

      if (req.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'output', schema: req.schema, strict: true },
        };
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...extra,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`${label} ${resp.status}: ${text.slice(0, 200)}`);
      }

      const json = (await resp.json()) as OpenAIChatResponse;
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        text,
        usage: json.usage
          ? {
              input: json.usage.prompt_tokens,
              output: json.usage.completion_tokens,
            }
          : undefined,
      };
    },
  };
}
