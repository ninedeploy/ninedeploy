import { z } from 'zod';
import { httpPath, repoBaseDir, repoRelativePath } from './common.js';
import { buildPack } from './service.js';

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

/**
 * 0.16.16: the service settings a diagnosis may propose — the ones that
 * decide how the app is built and checked, all of them inside the build or
 * the container. Lifecycle hooks are left out: for a non-operator they are
 * host-privileged. Applied through the ordinary `PATCH /v1/services/:id`,
 * so every rule of that route still holds.
 */
export const aiSettingsChange = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    healthPath: httpPath.optional(),
    build: z
      .object({
        buildPack: buildPack.optional(),
        baseDir: repoBaseDir.optional(),
        installCmd: z.string().max(500).optional(),
        buildCmd: z.string().max(500).optional(),
        startCmd: z.string().max(500).optional(),
        dockerfilePath: repoRelativePath.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AiSettingsChange = z.infer<typeof aiSettingsChange>;

/** 0.16.16: an edit to one repository file, as exact text to find and its replacement. */
export const aiFileChange = z
  .object({
    path: repoRelativePath,
    find: z.string().min(1).max(2000),
    replace: z.string().max(4000),
    why: z.string().max(300).optional(),
  })
  .strict();
export type AiFileChange = z.infer<typeof aiFileChange>;

/** 0.16.16: what a diagnosis proposes to change; either part may be absent. */
export const aiFixProposal = z
  .object({
    settings: aiSettingsChange.optional(),
    files: z.array(aiFileChange).max(5).optional(),
  })
  .strict();
export type AiFixProposal = z.infer<typeof aiFixProposal>;

/** 0.16.16: the diagnosis in parts, when the model answered in the structured form. */
export const aiDiagnosisParts = z.object({
  rootCause: z.string().min(1).max(600),
  evidence: z.array(z.string().max(600)).max(10),
  steps: z.array(z.string().max(600)).max(10),
});
export type AiDiagnosisParts = z.infer<typeof aiDiagnosisParts>;

/** `POST /v1/ai/services/:id/deploys/:depId/diagnose`. `diagnosis` is always the readable text; the rest is 0.16.16. */
export const aiDiagnosisResult = z.object({
  diagnosis: z.string(),
  model: z.string(),
  parts: aiDiagnosisParts.nullable().optional(),
  /** Null when the model proposed nothing that differs from the service's settings. */
  proposal: aiFixProposal.nullable().optional(),
});
export type AiDiagnosisResult = z.infer<typeof aiDiagnosisResult>;
