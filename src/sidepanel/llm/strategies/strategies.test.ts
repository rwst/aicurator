// Pure-strategy tests — no transport, no compose. RFC tests 1–11.

import { describe, expect, it } from 'vitest';
import {
  GeminiSanitizingDialect,
  OpenAIStrictDialect,
  PassThroughDialect,
} from './schemaDialect';
import {
  AnthropicThinking,
  GoogleThinking,
  OpenAIThinking,
  OpenRouterUnconditional,
} from './thinkingPolicy';

describe('SchemaDialect', () => {
  it('1. GeminiSanitizingDialect strips $ref and additionalProperties and records every removal', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        kid: { $ref: '#/$defs/Other' },
      },
      $defs: { Other: { type: 'string' } },
    };
    const { fragment, report } = GeminiSanitizingDialect.prepare(schema);
    expect(report.lossy).toBe(true);
    const keys = report.stripped.map((s) => s.key).sort();
    expect(keys).toEqual(['$defs', '$ref', 'additionalProperties']);
    expect(fragment).toEqual({
      type: 'object',
      properties: { kid: {} },
    });
  });

  it('2. GeminiSanitizingDialect is identity-with-empty-report for a clean schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        n: { type: 'integer' },
      },
      required: ['name'],
    };
    const { fragment, report } = GeminiSanitizingDialect.prepare(schema);
    expect(report.lossy).toBe(false);
    expect(report.stripped).toEqual([]);
    expect(fragment).toEqual(schema);
    // Non-mutating
    expect(fragment).not.toBe(schema);
  });

  it('3. OpenAIStrictDialect wraps the schema with strict:true', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const { fragment, report } = OpenAIStrictDialect.prepare(schema);
    expect(report.lossy).toBe(false);
    expect(fragment).toEqual({
      type: 'json_schema',
      json_schema: { name: 'output', schema, strict: true },
    });
  });

  it('4. PassThroughDialect returns undefined fragment, lossy:false for any input', () => {
    const a = PassThroughDialect.prepare(undefined);
    const b = PassThroughDialect.prepare({ type: 'object' });
    const c = PassThroughDialect.prepare({ oneOf: [{ type: 'string' }] });
    for (const r of [a, b, c]) {
      expect(r.fragment).toBeUndefined();
      expect(r.report.lossy).toBe(false);
    }
  });
});

describe('ThinkingPolicy', () => {
  it('5. AnthropicThinking on claude-opus-4-5 → anthropic, budget 24000, min-output 32000', () => {
    expect(AnthropicThinking.decide('claude-opus-4-5')).toEqual({
      kind: 'anthropic',
      budgetTokens: 24000,
      minOutputTokens: 32000,
    });
  });

  it('6. AnthropicThinking on claude-3-5-sonnet → null', () => {
    expect(AnthropicThinking.decide('claude-3-5-sonnet')).toBeNull();
  });

  it('7. GoogleThinking on gemini-2.5-pro → budget 32768', () => {
    const d = GoogleThinking.decide('gemini-2.5-pro');
    expect(d?.kind).toBe('gemini');
    expect(d?.budgetTokens).toBe(32768);
  });

  it('8. GoogleThinking on gemini-2.5-flash → budget 24576', () => {
    expect(GoogleThinking.decide('gemini-2.5-flash')?.budgetTokens).toBe(24576);
    expect(GoogleThinking.decide('gemini-2.5-flash-lite')?.budgetTokens).toBe(
      24576,
    );
  });

  it('9. GoogleThinking on gemini-1.5-pro → null', () => {
    expect(GoogleThinking.decide('gemini-1.5-pro')).toBeNull();
  });

  it('10. OpenAIThinking on o3 → effort high; on gpt-4-turbo → null', () => {
    expect(OpenAIThinking.decide('o3')).toEqual({
      kind: 'openai-effort',
      effort: 'high',
    });
    expect(OpenAIThinking.decide('gpt-4-turbo')).toBeNull();
  });

  it('11. OpenRouterUnconditional always returns effort high', () => {
    for (const m of [
      'anthropic/claude-opus-4-5',
      'openai/gpt-4o-mini',
      'meta-llama/llama-3-8b',
      'mistralai/mistral-large',
    ]) {
      expect(OpenRouterUnconditional.decide(m)).toEqual({
        kind: 'openrouter-effort',
        effort: 'high',
      });
    }
  });
});
