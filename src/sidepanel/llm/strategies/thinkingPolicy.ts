// ThinkingPolicy — pure value strategy mapping a model name to whatever
// "extended thinking / reasoning" the provider expects. Each policy
// holds the model-name regex table for one provider; no regex machinery
// leaks into the message format or the public API.

export interface ThinkingDecision {
  kind: 'anthropic' | 'gemini' | 'openai-effort' | 'openrouter-effort';
  /** Anthropic wire shape: legacy `thinking.type=enabled` + `budget_tokens`,
   *  or the newer `thinking.type=adaptive` + top-level `output_config.effort`
   *  required by opus-4-7+. Only meaningful when kind is 'anthropic'. */
  style?: 'budget' | 'adaptive';
  /** Anthropic-style budget tokens. Set when kind is 'gemini', or when kind
   *  is 'anthropic' with style='budget'. */
  budgetTokens?: number;
  /** OpenAI/OpenRouter-style effort, and Anthropic adaptive-style effort. */
  effort?: 'low' | 'medium' | 'high';
  /** Anthropic auto-bumps max_tokens to fit budget + visible-response headroom. */
  minOutputTokens?: number;
}

export interface ThinkingPolicy {
  /** Pure. null means "this model does not support reasoning under
   *  this provider's policy — emit no reasoning fragment". */
  decide(modelName: string): ThinkingDecision | null;
}

// ── Anthropic ────────────────────────────────────────────
// Models that accept the `thinking` parameter. Older models reject it.
const ANTHROPIC_THINKING_MODELS = /^claude-(opus-4|sonnet-4|haiku-4|3-7-sonnet)/i;
// Opus 4-7 (and future 4-N, N≥7) reject the legacy `thinking.type=enabled` +
// `budget_tokens` shape and require `thinking.type=adaptive` plus a top-level
// `output_config.effort`. Other 4.x models (sonnet-4-6, haiku-4-5, opus-4-5)
// still take the legacy shape.
const ANTHROPIC_ADAPTIVE_MODELS = /^claude-opus-4-([7-9]|[1-9][0-9])/i;
const ANTHROPIC_BUDGET = 24000;
const ANTHROPIC_MIN_OUTPUT = 32000;

export const AnthropicThinking: ThinkingPolicy = {
  decide(modelName) {
    if (!ANTHROPIC_THINKING_MODELS.test(modelName)) return null;
    if (ANTHROPIC_ADAPTIVE_MODELS.test(modelName)) {
      return {
        kind: 'anthropic',
        style: 'adaptive',
        effort: 'high',
        minOutputTokens: ANTHROPIC_MIN_OUTPUT,
      };
    }
    return {
      kind: 'anthropic',
      style: 'budget',
      budgetTokens: ANTHROPIC_BUDGET,
      minOutputTokens: ANTHROPIC_MIN_OUTPUT,
    };
  },
};

// ── Google ───────────────────────────────────────────────
// Gemini 2.5 family supports thinking. Older models (1.5, 2.0) reject
// thinkingConfig. Pro maxes at 32768 thinking tokens; Flash and
// Flash-Lite at 24576.
const GOOGLE_THINKING_MODELS = /^gemini-2\.5/i;

export const GoogleThinking: ThinkingPolicy = {
  decide(modelName) {
    if (!GOOGLE_THINKING_MODELS.test(modelName)) return null;
    const budgetTokens = /pro/i.test(modelName) ? 32768 : 24576;
    return { kind: 'gemini', budgetTokens };
  },
};

// ── OpenAI ───────────────────────────────────────────────
// Reasoning models. Gated by name prefix; older Chat-Completions models
// (gpt-4*, gpt-3.5-*) reject `reasoning_effort` and require `max_tokens`
// instead of `max_completion_tokens`.
const OPENAI_REASONING_MODELS = /^(o1|o3|o4|gpt-5)/i;

export const OpenAIThinking: ThinkingPolicy = {
  decide(modelName) {
    if (!OPENAI_REASONING_MODELS.test(modelName)) return null;
    return { kind: 'openai-effort', effort: 'high' };
  },
};

// ── OpenRouter ───────────────────────────────────────────
// OpenRouter accepts `reasoning: { effort }` for any upstream model.
// Models without reasoning support silently ignore the field, so we
// always emit it without any model-name gating. The receiving model's
// namespace prefix (`anthropic/...`, `openai/...`) is opaque to us.
export const OpenRouterUnconditional: ThinkingPolicy = {
  decide(_modelName) {
    return { kind: 'openrouter-effort', effort: 'high' };
  },
};
