// composeProvider wires a SchemaDialect + ThinkingPolicy + MessageFormat
// + HttpTransport + Base64Encoder into a Provider. The two public
// methods — generateText and generateJson — own response parsing and
// post-parse schema validation. The composer is the only place that
// touches `JSON.stringify` for the wire body and `JSON.parse` for
// responses.

import type { HttpTransport, Base64Encoder } from './ports';
import type { SchemaDialect } from './strategies/schemaDialect';
import type { ThinkingPolicy } from './strategies/thinkingPolicy';
import type { MessageFormat } from './strategies/messageFormat';
import { validate, type JsonSchema } from '../services/jsonSchema';
import {
  SchemaIncompatibleError,
  type EnforcementMode,
  type JsonRequest,
  type JsonResult,
  type Provider,
  type ProviderId,
  type TextRequest,
  type TextResult,
} from './types';

export interface ComposeParts {
  id: ProviderId;
  enforcement: EnforcementMode;
  droppedFeatures: ReadonlySet<string>;
  dialect: SchemaDialect;
  thinking: ThinkingPolicy;
  format: MessageFormat;
  transport: HttpTransport;
  base64: Base64Encoder;
  modelName: string;
  apiKey: string;
  /** Provider-specific extra headers (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
}

export function composeProvider(parts: ComposeParts): Provider {
  // Construction-time warnings — any lossy schema reports surfaced
  // through `provider.warnings` for sync UI banners. Phase-1 callers
  // construct providers lazily (per call), so the warnings list is
  // populated at the moment the schema is first seen, but synchronously
  // with respect to the generateJson call. To make this useful for UI
  // pre-flight, callers can pre-construct + pre-prepare via
  // assertSchemaCompatible() below.
  const warnings: ReturnType<SchemaDialect['prepare']>['report'][] = [];

  async function send(
    req: TextRequest | JsonRequest,
    schemaFragment: ReturnType<SchemaDialect['prepare']>,
    signal: AbortSignal,
  ): Promise<{ raw: string; result: TextResult }> {
    const pdfsB64 = await Promise.all(
      (req.pdfs ?? []).map(async (p) => ({
        name: p.name,
        data: await parts.base64.encode(p.bytes),
      })),
    );
    const formatted = parts.format.format({
      modelName: parts.modelName,
      apiKey: parts.apiKey,
      systemPrompt: req.systemPrompt,
      userText: req.userText,
      pdfsB64,
      maxOutputTokens: req.maxOutputTokens,
      schema: schemaFragment,
      thinking: parts.thinking.decide(parts.modelName),
      extraHeaders: parts.extraHeaders,
    });
    const resp = await parts.transport.send({
      url: formatted.url,
      method: 'POST',
      headers: formatted.headers,
      body: JSON.stringify(formatted.body),
      signal,
    });
    if (!resp.ok) {
      throw new Error(
        `${parts.format.errorLabel} ${resp.status}: ${resp.body.slice(0, 200)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(resp.body);
    } catch (err) {
      throw new Error(
        `${parts.format.errorLabel}: response was not JSON: ${(err as Error).message}`,
      );
    }
    const result = parts.format.parse(parsed);
    return { raw: result.text, result };
  }

  return {
    id: parts.id,
    capabilities: {
      enforcement: parts.enforcement,
      droppedFeatures: parts.droppedFeatures,
    },
    warnings,

    async generateText(req, signal): Promise<TextResult> {
      // No schema for text. Skip dialect prep entirely.
      const { result } = await send(
        req,
        { fragment: undefined, report: { stripped: [], lossy: false } },
        signal,
      );
      return result;
    },

    async generateJson<T = unknown>(
      req: JsonRequest,
      signal: AbortSignal,
    ): Promise<JsonResult<T>> {
      const prep = parts.dialect.prepare(req.schema);
      if (prep.report.lossy) warnings.push(prep.report);

      const { raw, result } = await send(req, prep, signal);
      const parsed = extractJsonObject(result.text);
      // Post-parse validation — uniform across providers regardless of
      // enforcement strictness, so callers always get "data is valid or
      // call rejects" semantics.
      validate(parsed, req.schema as JsonSchema);

      const data = parsed as T;
      if (parts.enforcement === 'strict') {
        return {
          kind: 'strict',
          data,
          raw,
          usage: result.usage,
        };
      }
      return {
        kind: 'best-effort',
        data,
        raw,
        usage: result.usage,
        degraded: prep.report,
      };
    },
  };
}

/** Sync precheck — throws SchemaIncompatibleError if the provider's
 *  dialect would silently strip features from the schema. Run this at
 *  config-save time to fail fast, not after a 30 s LLM call. */
export function assertSchemaCompatible(
  schema: object,
  parts: { dialect: SchemaDialect } | Provider,
): void {
  // Provider exposes `warnings` but not `dialect`. We accept both by
  // shape: if the second arg has `.dialect`, use it; otherwise the
  // caller has a Provider and we can re-prepare on a private fixture
  // — but that requires the dialect, so the canonical way is to call
  // this from the same factory site that built the provider.
  if (!('dialect' in parts)) {
    throw new Error(
      'assertSchemaCompatible: pass the dialect alongside the provider, or call before composing',
    );
  }
  const prep = parts.dialect.prepare(schema);
  if (prep.report.lossy) {
    throw new SchemaIncompatibleError(prep.report.stripped);
  }
}

// ── Response text extraction ─────────────────────────────
//
// LLM responses occasionally wrap JSON in ```json fences or have
// leading/trailing prose despite our schema asks. Be lenient: strip
// fences if present, then take the substring between the first '{' and
// last '}'.

function extractJsonObject(raw: string): unknown {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
  if (fence) s = fence[1].trim();
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0) {
    throw new Error('LLM response did not contain a JSON object');
  }
  return JSON.parse(s.slice(firstBrace, lastBrace + 1));
}
