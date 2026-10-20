import { z } from 'zod';

/**
 * 0.16.15: who answers. `openai` is any OpenAI-compatible chat-completions
 * endpoint (OpenAI, Azure gateways, Ollama, LM Studio, …) and what every
 * configuration stored before 0.16.15 means; `anthropic` is Claude through
 * the Anthropic Messages API.
 */
export const AI_PROVIDERS = ['openai', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The Anthropic API, used when an `anthropic` configuration names no base URL. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
/** What the settings form offers for `anthropic` before a model is chosen. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * AI (BYO-key) configuration. The API key never lives here — it is stored
 * separately, encrypted at rest — and this shape only carries the provider,
 * the endpoint and the model to call.
 */
export const aiConfig = z
  .object({
    /** 0.16.15; absent means `openai`, as every earlier configuration does. */
    provider: z.enum(AI_PROVIDERS).optional(),
    /** OpenAI-compatible base URL (e.g. https://api.openai.com/v1); optional for `anthropic`. */
    baseUrl: z.string().trim().url().max(300).optional(),
    /** Model name as the upstream expects it (e.g. gpt-4o-mini, llama3.1, claude-sonnet-5-5). */
    model: z.string().trim().min(1).max(120),
  })
  .refine((c) => (c.provider ?? 'openai') !== 'openai' || !!c.baseUrl, {
    message: 'An OpenAI-compatible provider needs its base URL',
    path: ['baseUrl'],
  });

export type AiConfig = z.infer<typeof aiConfig>;

/** PUT /v1/ai/config body — the key is optional so the provider, base URL or model can change without re-entering it. */
export const aiConfigUpdate = z
  .object({
    provider: z.enum(AI_PROVIDERS).optional(),
    baseUrl: z.string().trim().url().max(300).optional(),
    model: z.string().trim().min(1).max(120),
    apiKey: z.string().trim().min(8).max(400).optional(),
  })
  .refine((c) => (c.provider ?? 'openai') !== 'openai' || !!c.baseUrl, {
    message: 'An OpenAI-compatible provider needs its base URL',
    path: ['baseUrl'],
  });

export type AiConfigUpdate = z.infer<typeof aiConfigUpdate>;

/** GET /v1/ai/config response — never carries key material. */
export const aiConfigStatus = z.object({
  configured: z.boolean(),
  /** 0.16.15 (absent on older panels, which only speak `openai`). */
  provider: z.enum(AI_PROVIDERS).optional(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  hasApiKey: z.boolean(),
});

/** 0.16.15: `POST /v1/ai/services/:id/logs/analyze` — what the model made of a service's recent runtime logs. */
export const runtimeLogAnalysis = z.object({
  analysis: z.string(),
  model: z.string(),
  /** How many log lines were sent (after sanitizing), so a reader knows what the analysis saw. */
  lines: z.number().int(),
});
export type RuntimeLogAnalysis = z.infer<typeof runtimeLogAnalysis>;

export type AiConfigStatus = z.infer<typeof aiConfigStatus>;
