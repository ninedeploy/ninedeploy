import { z } from 'zod';

/**
 * AI failure diagnosis (BYO-key) configuration. The API key never lives
 * here — it is stored separately, encrypted at rest — and this shape only
 * carries the OpenAI-compatible endpoint and model to call.
 */
export const aiConfig = z.object({
  /** OpenAI-compatible chat-completions base URL (e.g. https://api.openai.com/v1). */
  baseUrl: z.string().trim().url().max(300),
  /** Model name as the upstream expects it (e.g. gpt-4o-mini, llama3.1). */
  model: z.string().trim().min(1).max(120),
});

export type AiConfig = z.infer<typeof aiConfig>;

/** PUT /v1/ai/config body — the key is optional so base URL/model can change without re-entering it. */
export const aiConfigUpdate = aiConfig.extend({
  apiKey: z.string().trim().min(8).max(400).optional(),
});

export type AiConfigUpdate = z.infer<typeof aiConfigUpdate>;

/** GET /v1/ai/config response — never carries key material. */
export const aiConfigStatus = z.object({
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  hasApiKey: z.boolean(),
});

export type AiConfigStatus = z.infer<typeof aiConfigStatus>;
