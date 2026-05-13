// Composition tests with the fake transport. RFC tests 12–16, plus the
// phase-2 public-surface tests 17–21.
//
// Verifies the byte-equivalent wire-body invariants that compose
// preserves from the v2604 hand-rolled providers.

import { describe, expect, it } from 'vitest';
import { makeAnthropicProvider } from './anthropic';
import { makeGoogleProvider } from './google';
import { makeOpenAIProvider } from './openai';
import { makeOpenRouterProvider } from './openrouter';
import {
  createFakeTransport,
  createNodeBase64Encoder,
} from './adapters/fake';
import {
  assertSchemaCompatible,
  type ProviderSettings,
} from './provider';
import { SchemaIncompatibleError } from './types';

// A schema that exercises Gemini's stripping rules (additionalProperties).
const SCHEMA_WITH_ADDITIONAL_PROPS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
  },
  required: ['title'],
};

// A clean small schema valid on every provider.
const CLEAN_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
};

const SCHEMA_WITH_ONEOF = {
  type: 'object',
  properties: {
    v: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
  },
  required: ['v'],
};

function makePorts() {
  const transport = createFakeTransport();
  const base64 = createNodeBase64Encoder();
  return { transport, base64 };
}

function geminiResponse(jsonText: string): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: jsonText }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
}

function openAIResponse(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function anthropicResponse(text: string): string {
  return JSON.stringify({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

describe('Composition wire bodies', () => {
  it('12. Google sanitization removes additionalProperties from generationConfig.responseSchema', async () => {
    const { transport, base64 } = makePorts();
    const provider = makeGoogleProvider('K', 'gemini-2.5-pro', {
      transport: transport.port,
      base64,
    });
    transport.controls.enqueue({
      status: 200,
      body: geminiResponse('{"title":"ok"}'),
    });

    await provider.generateJson(
      {
        systemPrompt: 'sys',
        userText: 'u',
        schema: SCHEMA_WITH_ADDITIONAL_PROPS,
      },
      new AbortController().signal,
    );

    const sent = transport.controls.sent();
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].body);
    expect(body.generationConfig.responseSchema).toBeDefined();
    expect(body.generationConfig.responseSchema).not.toHaveProperty(
      'additionalProperties',
    );
  });

  it('13. OpenRouter unconditional reasoning across diverse upstream models', async () => {
    for (const model of [
      'anthropic/claude-opus-4-5',
      'openai/gpt-4o-mini',
      'meta-llama/llama-3-8b',
    ]) {
      const { transport, base64 } = makePorts();
      const provider = makeOpenRouterProvider('K', model, {
        transport: transport.port,
        base64,
      });
      transport.controls.enqueue({
        status: 200,
        body: openAIResponse('hello'),
      });

      await provider.generateText(
        { systemPrompt: 's', userText: 'u' },
        new AbortController().signal,
      );

      const body = JSON.parse(transport.controls.sent()[0].body);
      expect(body.reasoning).toEqual({ effort: 'high' });
    }
  });

  it('14. Token-cap dispatch picks the right wire field per model', async () => {
    // OpenAI o-series → max_completion_tokens (and reasoning_effort).
    const a = makePorts();
    const oai_o3 = makeOpenAIProvider('K', 'o3', {
      transport: a.transport.port,
      base64: a.base64,
    });
    a.transport.controls.enqueue({
      status: 200,
      body: openAIResponse('ok'),
    });
    await oai_o3.generateText(
      { systemPrompt: 's', userText: 'u', maxOutputTokens: 32000 },
      new AbortController().signal,
    );
    let body = JSON.parse(a.transport.controls.sent()[0].body);
    expect(body.max_completion_tokens).toBe(32000);
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_tokens).toBeUndefined();

    // OpenAI gpt-4-turbo → max_tokens.
    const b = makePorts();
    const oai_gpt = makeOpenAIProvider('K', 'gpt-4-turbo', {
      transport: b.transport.port,
      base64: b.base64,
    });
    b.transport.controls.enqueue({
      status: 200,
      body: openAIResponse('ok'),
    });
    await oai_gpt.generateText(
      { systemPrompt: 's', userText: 'u', maxOutputTokens: 32000 },
      new AbortController().signal,
    );
    body = JSON.parse(b.transport.controls.sent()[0].body);
    expect(body.max_tokens).toBe(32000);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();

    // Anthropic non-thinking → max_tokens.
    const c = makePorts();
    const anth_old = makeAnthropicProvider('K', 'claude-3-5-sonnet', {
      transport: c.transport.port,
      base64: c.base64,
    });
    c.transport.controls.enqueue({
      status: 200,
      body: anthropicResponse('ok'),
    });
    await anth_old.generateText(
      { systemPrompt: 's', userText: 'u', maxOutputTokens: 32000 },
      new AbortController().signal,
    );
    body = JSON.parse(c.transport.controls.sent()[0].body);
    expect(body.max_tokens).toBe(32000);

    // Anthropic thinking → max_tokens auto-bumped to >= min-output-32000.
    const d = makePorts();
    const anth_new = makeAnthropicProvider('K', 'claude-opus-4-5', {
      transport: d.transport.port,
      base64: d.base64,
    });
    d.transport.controls.enqueue({
      status: 200,
      body: anthropicResponse('ok'),
    });
    await anth_new.generateText(
      { systemPrompt: 's', userText: 'u', maxOutputTokens: 16000 },
      new AbortController().signal,
    );
    body = JSON.parse(d.transport.controls.sent()[0].body);
    expect(body.max_tokens).toBeGreaterThanOrEqual(32000);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 24000 });

    // Anthropic adaptive-thinking models (opus-4-7+) → thinking.type=adaptive
    // with a top-level output_config.effort. Legacy budget_tokens is rejected
    // server-side for these models.
    const e = makePorts();
    const anth_adaptive = makeAnthropicProvider('K', 'claude-opus-4-7', {
      transport: e.transport.port,
      base64: e.base64,
    });
    e.transport.controls.enqueue({
      status: 200,
      body: anthropicResponse('ok'),
    });
    await anth_adaptive.generateText(
      { systemPrompt: 's', userText: 'u', maxOutputTokens: 16000 },
      new AbortController().signal,
    );
    body = JSON.parse(e.transport.controls.sent()[0].body);
    expect(body.max_tokens).toBeGreaterThanOrEqual(32000);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('15. Construction-time warnings populate after a lossy schema is seen', async () => {
    const { transport, base64 } = makePorts();
    const provider = makeGoogleProvider('K', 'gemini-2.5-pro', {
      transport: transport.port,
      base64,
    });
    expect(provider.warnings).toHaveLength(0);

    transport.controls.enqueue({
      status: 200,
      body: geminiResponse('{"v":"x"}'),
    });
    // generateJson with a oneOf schema is lossy under Gemini.
    await provider.generateJson(
      { systemPrompt: 's', userText: 'u', schema: SCHEMA_WITH_ONEOF },
      new AbortController().signal,
    );
    expect(provider.warnings).toHaveLength(1);
    expect(provider.warnings[0].lossy).toBe(true);
    expect(provider.warnings[0].stripped.map((s) => s.key)).toContain('oneOf');
  });

  it('16. Non-2xx responses surface a normalized error with provider label and status', async () => {
    const { transport, base64 } = makePorts();
    const provider = makeOpenAIProvider('K', 'gpt-4o-mini', {
      transport: transport.port,
      base64,
    });
    transport.controls.enqueue({
      status: 429,
      body: '{"error":{"message":"rate-limited"}}',
    });
    await expect(
      provider.generateText(
        { systemPrompt: 's', userText: 'u' },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/OpenAI 429:/);
  });
});

describe('Public surface', () => {
  it('17. generateJson returns strict for OpenAI / OpenRouter, best-effort for Google (with degraded.lossy reflecting the schema)', async () => {
    // OpenAI: strict
    const a = makePorts();
    const oai = makeOpenAIProvider('K', 'gpt-4o-mini', {
      transport: a.transport.port,
      base64: a.base64,
    });
    a.transport.controls.enqueue({
      status: 200,
      body: openAIResponse('{"title":"x"}'),
    });
    const r1 = await oai.generateJson(
      { systemPrompt: 's', userText: 'u', schema: CLEAN_SCHEMA },
      new AbortController().signal,
    );
    expect(r1.kind).toBe('strict');

    // Google clean schema: best-effort but not lossy.
    const b = makePorts();
    const goog = makeGoogleProvider('K', 'gemini-2.5-pro', {
      transport: b.transport.port,
      base64: b.base64,
    });
    b.transport.controls.enqueue({
      status: 200,
      body: geminiResponse('{"title":"x"}'),
    });
    const r2 = await goog.generateJson(
      { systemPrompt: 's', userText: 'u', schema: CLEAN_SCHEMA },
      new AbortController().signal,
    );
    expect(r2.kind).toBe('best-effort');
    if (r2.kind !== 'best-effort') throw new Error('unreachable');
    expect(r2.degraded.lossy).toBe(false);

    // Google lossy schema: best-effort, degraded.lossy === true.
    const c = makePorts();
    const goog2 = makeGoogleProvider('K', 'gemini-2.5-pro', {
      transport: c.transport.port,
      base64: c.base64,
    });
    c.transport.controls.enqueue({
      status: 200,
      body: geminiResponse('{"v":"x"}'),
    });
    const r3 = await goog2.generateJson(
      { systemPrompt: 's', userText: 'u', schema: SCHEMA_WITH_ONEOF },
      new AbortController().signal,
    );
    if (r3.kind !== 'best-effort') throw new Error('unreachable');
    expect(r3.degraded.lossy).toBe(true);
  });

  it('18. generateJson for Anthropic always returns best-effort (provider enforces nothing)', async () => {
    const { transport, base64 } = makePorts();
    const anth = makeAnthropicProvider('K', 'claude-opus-4-5', {
      transport: transport.port,
      base64,
    });
    transport.controls.enqueue({
      status: 200,
      body: anthropicResponse('{"title":"x"}'),
    });
    const r = await anth.generateJson(
      { systemPrompt: 's', userText: 'u', schema: CLEAN_SCHEMA },
      new AbortController().signal,
    );
    expect(r.kind).toBe('best-effort');
  });

  it('19. generateText cannot be called with a schema field — compile-time error', () => {
    // This test exists for the type-checker; if the next line still
    // compiles, that's a regression.
    const { transport, base64 } = makePorts();
    const oai = makeOpenAIProvider('K', 'gpt-4o-mini', {
      transport: transport.port,
      base64,
    });
    void (async () => {
      await oai.generateText(
        // @ts-expect-error generateText rejects JsonRequest — schema is not in TextRequest
        { systemPrompt: 's', userText: 'u', schema: CLEAN_SCHEMA },
        new AbortController().signal,
      );
    });
  });

  it('20. assertSchemaCompatible throws synchronously for Google with lossy schema', () => {
    expect(() =>
      assertSchemaCompatible(SCHEMA_WITH_ONEOF, 'Google'),
    ).toThrow(SchemaIncompatibleError);
    expect(() => assertSchemaCompatible(CLEAN_SCHEMA, 'Google')).not.toThrow();
    expect(() =>
      assertSchemaCompatible(SCHEMA_WITH_ONEOF, 'OpenAI'),
    ).not.toThrow();
    // Anthropic uses PassThrough — never lossy regardless of schema.
    expect(() =>
      assertSchemaCompatible(SCHEMA_WITH_ONEOF, 'Anthropic'),
    ).not.toThrow();
  });

  it('21. provider.id is preserved across all four factories', () => {
    const { transport, base64 } = makePorts();
    const settings: Omit<ProviderSettings, 'apiKey' | 'modelName'> = {} as never;
    void settings;
    expect(
      makeAnthropicProvider('K', 'claude-3-5-sonnet', {
        transport: transport.port,
        base64,
      }).id,
    ).toBe('anthropic');
    expect(
      makeGoogleProvider('K', 'gemini-2.5-pro', {
        transport: transport.port,
        base64,
      }).id,
    ).toBe('google');
    expect(
      makeOpenAIProvider('K', 'gpt-4o-mini', {
        transport: transport.port,
        base64,
      }).id,
    ).toBe('openai');
    expect(
      makeOpenRouterProvider('K', 'openai/gpt-4o-mini', {
        transport: transport.port,
        base64,
      }).id,
    ).toBe('openrouter');
  });
});
