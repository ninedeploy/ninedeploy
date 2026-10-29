import { ANTHROPIC_DEFAULT_BASE_URL, type AiProvider } from '@ninedeploy/schemas';
import { decrypt } from './crypto.js';
import { HttpError } from './errors.js';
import { getSettingJson, getSettingString } from './settings.js';
import { parseChatCompletionContent } from './aiDiagnosis.js';

/**
 * The instance's AI provider (BYO key), shared by every AI feature: failure
 * diagnosis, manifest suggestions and (0.16.15) runtime-log analysis.
 *
 * Two providers:
 *  - `openai`: any OpenAI-compatible `POST <baseUrl>/chat/completions`
 *    (OpenAI, gateways, a local Ollama / LM Studio). Every configuration
 *    stored before 0.16.15 has no `provider` and means this.
 *  - `anthropic` (0.16.15): Claude through the Messages API,
 *    `POST <baseUrl>/v1/messages` with `x-api-key` and `anthropic-version`.
 *
 * The base URL is operator configuration by design (loopback is an intended
 * BYO scenario), so it is not egress-guarded; only the operator sets it.
 */

export const AI_CONFIG_KEY = 'ai_diagnosis_config';
export const AI_KEY_KEY = 'ai_diagnosis_key_encrypted';

const AI_TIMEOUT_MS = 30_000;
const ANTHROPIC_VERSION = '2023-06-01';

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** The stored JSON half of the configuration (the key lives apart, sealed). */
export interface StoredAiConfig {
  provider?: AiProvider;
  baseUrl?: string;
  model?: string;
  /** ROADMAP item 6: investigate a service's firing alerts (lib/alertInvestigation.ts). */
  alertInvestigation?: boolean;
}

/** The base URL a configuration calls: its own, or the Anthropic API for `anthropic`. */
export function effectiveBaseUrl(json: StoredAiConfig | null): string | null {
  if (!json) return null;
  if (json.baseUrl) return json.baseUrl;
  return (json.provider ?? 'openai') === 'anthropic' ? ANTHROPIC_DEFAULT_BASE_URL : null;
}

export async function loadStoredAiConfig(db: Parameters<typeof getSettingJson>[0]): Promise<StoredAiConfig | null> {
  return getSettingJson<StoredAiConfig>(db, AI_CONFIG_KEY, null);
}

/** The configuration with its key, or null when anything is missing or the key cannot be opened. */
export async function loadAiConfig(db: Parameters<typeof getSettingJson>[0]): Promise<AiSettings | null> {
  const json = await loadStoredAiConfig(db);
  const encrypted = await getSettingString(db, AI_KEY_KEY, null);
  const baseUrl = effectiveBaseUrl(json);
  if (!json?.model || !baseUrl || !encrypted) return null;
  try {
    return { provider: json.provider ?? 'openai', baseUrl, model: json.model, apiKey: decrypt(encrypted) };
  } catch {
    // Undecryptable envelope (rotated-away master key) → treat as unconfigured
    // rather than half-working: the operator re-enters the key.
    return null;
  }
}

/** The text of an Anthropic Messages response (its `text` blocks, joined), or null for any other shape. */
export function parseAnthropicContent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type: 'text'; text: string } => {
      if (typeof b !== 'object' || b === null) return false;
      const block = b as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string';
    })
    .map((b) => b.text)
    .join('')
    .trim();
  return text.length > 0 ? text : null;
}

/** The request one provider expects for a system prompt and one user message. */
export function aiRequest(
  cfg: AiSettings,
  prompt: { system: string; user: string },
  maxTokens: number,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (cfg.provider === 'anthropic') {
    return {
      url: `${base}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: {
        model: cfg.model,
        max_tokens: maxTokens,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      },
    };
  }
  return {
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    },
  };
}

/** Ask the configured provider and return its text. Failures are HTTP errors that never echo the upstream body. */
export async function aiComplete(
  cfg: AiSettings,
  prompt: { system: string; user: string },
  maxTokens: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const req = aiRequest(cfg, prompt, maxTokens);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchImpl(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
    throw new HttpError(504, 'ai_upstream', `The AI provider ${reason}.`);
  }
  if (!res.ok) {
    // Body may echo the key on auth failures — never relay it upstream-text.
    throw new HttpError(502, 'ai_upstream', `The AI provider rejected the request (HTTP ${res.status}).`);
  }
  const json = await res.json().catch(() => null);
  const content = cfg.provider === 'anthropic' ? parseAnthropicContent(json) : parseChatCompletionContent(json);
  if (!content) throw new HttpError(502, 'ai_upstream', 'The AI provider returned an unreadable response.');
  return content;
}
