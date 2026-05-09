// SchemaDialect — pure value strategy that converts a caller's JSON
// Schema into the wire fragment the target provider expects. Three
// implementations cover the four providers:
//
//   PassThrough — Anthropic. Provider has no server-side schema
//     enforcement; we send no schema fragment, post-parse validation
//     does the work. fragment is undefined, report is empty.
//
//   OpenAIStrict — OpenAI + OpenRouter. Wraps the schema in
//     response_format.json_schema with strict:true. Lossless. Caller
//     gets server-side enforcement.
//
//   GeminiSanitizing — Google. Walks the schema, strips the nine
//     keywords Gemini's responseSchema rejects, records every removal
//     as a JSON-pointer path so the lossy-degradation case is visible
//     to callers (provider.warnings + JsonResult.degraded).

export interface SanitizationReport {
  stripped: { path: string; key: string }[];
  lossy: boolean;
}

export interface SchemaPreparation {
  fragment: unknown; // provider-shaped fragment, or undefined
  report: SanitizationReport;
}

export interface SchemaDialect {
  readonly name: 'none' | 'gemini' | 'openai-strict';
  /** Pure: same input always yields same output + report. */
  prepare(schema: object | undefined): SchemaPreparation;
}

const EMPTY_REPORT: SanitizationReport = Object.freeze({
  stripped: [],
  lossy: false,
});

// ── PassThrough ──────────────────────────────────────────

export const PassThroughDialect: SchemaDialect = {
  name: 'none',
  prepare(_schema) {
    return { fragment: undefined, report: EMPTY_REPORT };
  },
};

// ── OpenAIStrict ─────────────────────────────────────────

export const OpenAIStrictDialect: SchemaDialect = {
  name: 'openai-strict',
  prepare(schema) {
    if (!schema) return { fragment: undefined, report: EMPTY_REPORT };
    return {
      fragment: {
        type: 'json_schema',
        json_schema: { name: 'output', schema, strict: true },
      },
      report: EMPTY_REPORT,
    };
  },
};

// ── GeminiSanitizing ─────────────────────────────────────

// Gemini's responseSchema is an OpenAPI-3 subset, not full JSON Schema.
// These keys are silently rejected by the responseSchema validator.
const GEMINI_UNSUPPORTED_KEYS: ReadonlySet<string> = new Set([
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

export const GEMINI_DROPPED_FEATURES: ReadonlySet<string> = GEMINI_UNSUPPORTED_KEYS;

function sanitize(
  node: unknown,
  path: string,
  removed: { path: string; key: string }[],
): unknown {
  if (Array.isArray(node)) {
    return node.map((v, i) => sanitize(v, `${path}/${i}`, removed));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (GEMINI_UNSUPPORTED_KEYS.has(k)) {
        removed.push({ path: `${path}/${escapeJsonPointer(k)}`, key: k });
        continue;
      }
      out[k] = sanitize(v, `${path}/${escapeJsonPointer(k)}`, removed);
    }
    return out;
  }
  return node;
}

function escapeJsonPointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export const GeminiSanitizingDialect: SchemaDialect = {
  name: 'gemini',
  prepare(schema) {
    if (!schema) return { fragment: undefined, report: EMPTY_REPORT };
    const removed: { path: string; key: string }[] = [];
    const sanitized = sanitize(schema, '', removed);
    return {
      fragment: sanitized,
      report: { stripped: removed, lossy: removed.length > 0 },
    };
  },
};
