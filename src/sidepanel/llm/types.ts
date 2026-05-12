// Public surface types for the deepened LLM module.
//
// generateText vs generateJson are separate methods — the runtime split
// mirrors the conceptual split, and the discriminated JsonResult forces
// callers to acknowledge the strict-vs-best-effort axis at the type
// level.

import type { SanitizationReport } from './strategies/schemaDialect';
export type { SanitizationReport } from './strategies/schemaDialect';

export type ReasoningLevel = 'off' | 'low' | 'high';

export interface PdfInput {
  name: string;
  bytes: ArrayBuffer;
}

export interface BaseRequest {
  systemPrompt: string;
  userText: string;
  pdfs?: PdfInput[];
  maxOutputTokens?: number;
}

// Empty sub-interfaces today; kept distinct so callers (and the
// compile-time mode-confusion guard test) can see the conceptual split.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TextRequest extends BaseRequest {}

export interface JsonRequest extends BaseRequest {
  schema: object;
}

export interface Usage {
  input: number;
  output: number;
}

export interface TextResult {
  text: string;
  usage?: Usage;
}

export type JsonResult<T = unknown> =
  | { kind: 'strict'; data: T; raw: string; usage?: Usage }
  | {
      kind: 'best-effort';
      data: T;
      raw: string;
      usage?: Usage;
      degraded: SanitizationReport;
    };

export type EnforcementMode = 'strict' | 'sanitized' | 'prompt-only';

export interface ProviderCapabilities {
  enforcement: EnforcementMode;
  /** Which dialect-stripped JSON-Schema keywords this provider drops on
   *  the wire. Empty for strict / prompt-only providers. */
  droppedFeatures: ReadonlySet<string>;
}

export type ProviderId = 'anthropic' | 'google' | 'openai' | 'openrouter';

export interface Provider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Populated synchronously at construction time. Inspect for any
   *  `lossy: true` reports to surface a "schema-degraded" UI banner
   *  before any LLM call is made. */
  readonly warnings: SanitizationReport[];

  generateText(req: TextRequest, signal: AbortSignal): Promise<TextResult>;
  generateJson<T = unknown>(
    req: JsonRequest,
    signal: AbortSignal,
  ): Promise<JsonResult<T>>;
}

/** Thrown by generateJson when the provider returned a 2xx response
 *  whose body could not be coerced into the requested schema (no JSON
 *  object found, JSON.parse failed, or post-parse schema validation
 *  failed). Carries the raw response text so callers can dump it for
 *  inspection without re-running the LLM call. */
export class JsonParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'JsonParseError';
    this.raw = raw;
  }
}

/** Thrown by assertSchemaCompatible when the provider would silently
 *  drop schema features. Use to short-circuit at config-save time. */
export class SchemaIncompatibleError extends Error {
  readonly stripped: { path: string; key: string }[];
  constructor(stripped: { path: string; key: string }[]) {
    super(
      `Schema is incompatible with this provider — features dropped: ${stripped
        .map((s) => s.key)
        .join(', ')}`,
    );
    this.name = 'SchemaIncompatibleError';
    this.stripped = stripped;
  }
}
