// MessageFormat — wire-format strategy. format() takes a fully-prepared
// request (PDFs already base64-encoded, schema fragment shaped by the
// dialect, thinking decision shaped by the policy) and emits the
// FormattedRequest the transport will ship. parse() unwraps the
// response back into the LlmCallResult shape.
//
// Phase-1 invariant: byte-equivalent wire bodies to v2604.

import type { ThinkingDecision } from './thinkingPolicy';
import type { SchemaPreparation } from './schemaDialect';

export interface FormattedRequest {
  url: string;
  headers: Record<string, string>;
  /** Already a JS object — composeProvider serializes once via JSON.stringify. */
  body: unknown;
}

export interface LlmCallResult {
  text: string;
  usage?: { input: number; output: number };
}

export interface FormatInput {
  modelName: string;
  apiKey: string;
  systemPrompt: string;
  userText: string;
  pdfsB64: { name: string; data: string }[];
  /** Token budget the caller asked for. The format may override (Anthropic
   *  bumps for thinking models). undefined means "use provider default". */
  maxOutputTokens: number | undefined;
  schema: SchemaPreparation;
  thinking: ThinkingDecision | null;
  /** Caller-attached extra headers, used by OpenRouter. */
  extraHeaders?: Record<string, string>;
}

export interface MessageFormat {
  /** Used by error normalization in compose. */
  readonly errorLabel: string;
  format(input: FormatInput): FormattedRequest;
  parse(json: unknown): LlmCallResult;
}

// ── Anthropic ────────────────────────────────────────────

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_DEFAULT_MAX = 16384;

interface AnthropicContentBlock {
  type: 'text' | 'document';
  text?: string;
  source?: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
}

export const AnthropicFormat: MessageFormat = {
  errorLabel: 'Anthropic',
  format(input): FormattedRequest {
    const content: AnthropicContentBlock[] = [];
    for (const pdf of input.pdfsB64) {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdf.data,
        },
      });
    }
    content.push({ type: 'text', text: input.userText });

    const t = input.thinking;
    const requestedCap = input.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX;
    const maxTokens =
      t && t.kind === 'anthropic' && t.minOutputTokens !== undefined
        ? Math.max(requestedCap, t.minOutputTokens)
        : requestedCap;

    const body: Record<string, unknown> = {
      model: input.modelName,
      max_tokens: maxTokens,
      system: input.systemPrompt,
      messages: [{ role: 'user', content }],
    };
    if (t && t.kind === 'anthropic') {
      body.thinking = { type: 'enabled', budget_tokens: t.budgetTokens };
    }

    return {
      url: ANTHROPIC_ENDPOINT,
      headers: {
        'content-type': 'application/json',
        'x-api-key': input.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    };
  },
  parse(raw): LlmCallResult {
    const json = raw as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
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

// ── Google (Gemini) ──────────────────────────────────────

const GOOGLE_ENDPOINT_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';
const GOOGLE_DEFAULT_MAX = 16384;

export const GoogleFormat: MessageFormat = {
  errorLabel: 'Google',
  format(input): FormattedRequest {
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
    for (const pdf of input.pdfsB64) {
      parts.push({ inlineData: { mimeType: 'application/pdf', data: pdf.data } });
    }
    parts.push({ text: input.userText });

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: input.maxOutputTokens ?? GOOGLE_DEFAULT_MAX,
    };
    if (input.schema.fragment !== undefined) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = input.schema.fragment;
    }
    if (input.thinking && input.thinking.kind === 'gemini') {
      generationConfig.thinkingConfig = {
        thinkingBudget: input.thinking.budgetTokens,
        includeThoughts: false,
      };
    }

    const body = {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    };

    return {
      url: `${GOOGLE_ENDPOINT_BASE}/${encodeURIComponent(input.modelName)}:generateContent`,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': input.apiKey,
      },
      body,
    };
  },
  parse(raw): LlmCallResult {
    const json = raw as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      error?: { message?: string };
    };
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
          ? { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0 }
          : undefined,
    };
  },
};

// ── OpenAI / OpenRouter ──────────────────────────────────
//
// OpenRouter's wire format is a strict superset of OpenAI's
// (chat/completions over /v1). The only differences are base URL,
// optional attribution headers, and the unconditional reasoning
// passthrough — all of which compose injects through FormatInput.

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MAX = 16384;

interface OpenAIUserContent {
  type: 'text' | 'file';
  text?: string;
  file?: { filename: string; file_data: string };
}

export interface OpenAIFormatOptions {
  baseUrl?: string;
  errorLabel?: string;
}

export function makeOpenAIFormat(opts: OpenAIFormatOptions = {}): MessageFormat {
  const baseUrl = opts.baseUrl ?? OPENAI_DEFAULT_BASE;
  const label = opts.errorLabel ?? 'OpenAI';

  return {
    errorLabel: label,
    format(input): FormattedRequest {
      const userContent: OpenAIUserContent[] = [];
      for (const pdf of input.pdfsB64) {
        userContent.push({
          type: 'file',
          file: {
            filename: pdf.name,
            file_data: `data:application/pdf;base64,${pdf.data}`,
          },
        });
      }
      userContent.push({ type: 'text', text: input.userText });

      const tokenCap = input.maxOutputTokens ?? OPENAI_DEFAULT_MAX;
      const body: Record<string, unknown> = {
        model: input.modelName,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: userContent },
        ],
      };

      const t = input.thinking;
      if (t && t.kind === 'openai-effort') {
        body.max_completion_tokens = tokenCap;
        body.reasoning_effort = t.effort;
      } else {
        body.max_tokens = tokenCap;
      }

      // OpenRouter uses kind:'openrouter-effort' to inject reasoning
      // unconditionally. The wire format is identical (top-level
      // `reasoning: { effort }`).
      if (t && t.kind === 'openrouter-effort') {
        body.reasoning = { effort: t.effort };
      }

      if (input.schema.fragment !== undefined) {
        body.response_format = input.schema.fragment;
      }

      return {
        url: `${baseUrl}/chat/completions`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.apiKey}`,
          ...(input.extraHeaders ?? {}),
        },
        body,
      };
    },
    parse(raw): LlmCallResult {
      const json = raw as {
        error?: { message?: string; code?: string | number };
        choices?: {
          finish_reason?: string;
          message?: {
            content?: string | null;
            refusal?: string | null;
            reasoning?: string | null;
          };
        }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      // OpenRouter (and occasionally OpenAI) sometimes return HTTP 200
      // with a top-level `error` body — for example when the upstream
      // provider rejected the request after OpenRouter accepted it.
      // composeProvider only inspects HTTP status, so without this
      // check the error sails through as an empty `text`.
      if (json.error?.message) {
        throw new Error(`${label}: ${json.error.message}`);
      }
      const choice = json.choices?.[0];
      const msg = choice?.message;
      const text = msg?.content ?? '';
      if (text.length === 0) {
        // Empty visible content — surface the most useful next-best
        // signal so callers don't get a bare "no JSON object" downstream.
        if (msg?.refusal) {
          throw new Error(`${label}: model refused to answer: ${msg.refusal}`);
        }
        if (msg?.reasoning) {
          throw new Error(
            `${label}: response had only reasoning content (no visible answer); reasoning preview: ${msg.reasoning.slice(0, 300)}`,
          );
        }
        if (choice?.finish_reason && choice.finish_reason !== 'stop') {
          throw new Error(
            `${label}: response was empty (finish_reason: ${choice.finish_reason})`,
          );
        }
      }
      return {
        text,
        usage: json.usage
          ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens }
          : undefined,
      };
    },
  };
}

export const OpenAIFormat = makeOpenAIFormat();
