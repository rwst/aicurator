import type { LlmCall, LlmResult, Provider } from './provider';
import { arrayBufferToBase64 } from '../lib/base64';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MAX_TOKENS = 16384;

// Gemini 2.5 family supports thinking. Older models (1.5, 2.0) reject
// `thinkingConfig`. Pro maxes at 32768 thinking tokens; Flash and
// Flash-Lite at 24576.
const THINKING_MODELS = /^gemini-2\.5/i;
function maxThinkingBudget(modelName: string): number {
  return /pro/i.test(modelName) ? 32768 : 24576;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}

// Gemini's responseSchema is an OpenAPI-3 subset, not full JSON Schema.
// Notably it rejects `additionalProperties`, plus a handful of keywords
// the rest of the codebase doesn't currently use. Walk the schema and
// strip the unsupported keys so the same EXTRACT_SCHEMA can target all
// providers without per-provider definitions.
const GEMINI_UNSUPPORTED_KEYS = new Set([
  'additionalProperties',
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'allOf',
  'not',
  'patternProperties',
  'unevaluatedProperties',
]);

function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (GEMINI_UNSUPPORTED_KEYS.has(k)) continue;
      out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return node;
}

export function makeGoogleProvider(
  apiKey: string,
  modelName: string,
): Provider {
  return {
    async call(req: LlmCall, signal: AbortSignal): Promise<LlmResult> {
      const parts: GeminiPart[] = [];
      for (const pdf of req.pdfs) {
        const data = await arrayBufferToBase64(pdf.bytes);
        parts.push({
          inlineData: { mimeType: 'application/pdf', data },
        });
      }
      parts.push({ text: req.userText });

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (req.schema) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = sanitizeSchema(req.schema);
      }
      if (THINKING_MODELS.test(modelName)) {
        generationConfig.thinkingConfig = {
          thinkingBudget: maxThinkingBudget(modelName),
          includeThoughts: false,
        };
      }

      const body = {
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
      };

      const url = `${ENDPOINT_BASE}/${encodeURIComponent(modelName)}:generateContent`;
      const resp = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Google ${resp.status}: ${text.slice(0, 200)}`);
      }

      const json = (await resp.json()) as GeminiResponse;
      if (json.error?.message) {
        throw new Error(`Google: ${json.error.message}`);
      }
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('');
      const u = json.usageMetadata;
      return {
        text,
        usage:
          u && (u.promptTokenCount != null || u.candidatesTokenCount != null)
            ? {
                input: u.promptTokenCount ?? 0,
                output: u.candidatesTokenCount ?? 0,
              }
            : undefined,
      };
    },
  };
}
