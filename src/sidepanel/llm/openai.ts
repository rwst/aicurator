import type { LlmCall, LlmResult, Provider } from './provider';
import { arrayBufferToBase64 } from '../lib/base64';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 16384;

// OpenAI reasoning models. `reasoning_effort` and `max_completion_tokens`
// only apply to these — older Chat Completions models (gpt-4*, gpt-3.5-*)
// reject both, so we gate by model-name prefix. The OpenAI provider
// uses this directly; OpenRouter overrides via `extraBody` since its
// model names are namespaced (`openai/o3`, `anthropic/claude-…`).
const OPENAI_REASONING_MODELS = /^(o1|o3|o4|gpt-5)/i;

export interface OpenAILikeOptions {
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  providerLabel?: string; // for error messages
  // Caller can inject extra request-body fields based on model name.
  // OpenRouter uses this to always send `reasoning: { effort: 'high' }`
  // as a normalised passthrough across upstream providers.
  extraBody?: (modelName: string) => Record<string, unknown>;
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
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
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

      const tokenCap = req.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
      const isReasoning = OPENAI_REASONING_MODELS.test(modelName);
      const body: OpenAIRequestBody = {
        model: modelName,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: userContent },
        ],
      };
      if (isReasoning) {
        body.max_completion_tokens = tokenCap;
        body.reasoning_effort = 'high';
      } else {
        body.max_tokens = tokenCap;
      }

      if (req.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'output', schema: req.schema, strict: true },
        };
      }

      if (options.extraBody) {
        Object.assign(body, options.extraBody(modelName));
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
