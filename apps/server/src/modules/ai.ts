import { eq } from 'drizzle-orm';
import { deployments, users, workspaces } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { aiConfigUpdate, ninedeployManifest, type AiConfigStatus as AiConfigStatusT } from '@ninedeploy/schemas';
import { z } from 'zod';
import { decrypt, encrypt } from '../lib/crypto.js';
import { HttpError, badRequest, forbidden, notFound, parseId as num } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getSettingJson, getSettingString, setSettingJson, setSettingString } from '../lib/settings.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertServiceRole, roleAtLeast, serviceWorkspaceIds, userWorkspaceMemberships } from '../lib/resourceAccess.js';
import { logBus } from '../engine/logs.js';
import { redactEgressTarget } from '../lib/egressGuard.js';
import {
  buildDiagnosisMessages,
  buildSuggestMessages,
  MAX_LOG_CHARS,
  parseChatCompletionContent,
  sanitizeLogForAi,
  stripJsonFence,
  truncateTail,
} from '../lib/aiDiagnosis.js';

/**
 * AI failure diagnosis (BYO-key). The operator configures an
 * OpenAI-compatible endpoint + model + API key once for the instance;
 * operators and the members of an operator's workspaces (r508) may then ask
 * for a failed build log to be diagnosed. The key is
 * stored encrypted at rest (settings table, `encrypt()` envelope) and never
 * returned by any route.
 *
 * The `baseUrl` is operator-configured by design — pointing it at a local
 * Ollama/LM Studio endpoint is an intended BYO scenario, so loopback is NOT
 * blocked. Only the instance operator can set it.
 */

const AI_CONFIG_KEY = 'ai_diagnosis_config';
const AI_KEY_KEY = 'ai_diagnosis_key_encrypted';

const DIAGNOSIS_TIMEOUT_MS = 30_000;
const DIAGNOSIS_MAX_TOKENS = 700;
const SUGGEST_MAX_TOKENS = 900;

/** Free-text app description — long enough to be useful, short enough
 * to stay a rounding error next to the system prompt. */
const suggestManifest = z.object({
  description: z.string().min(10).max(4000),
});

/**
 * r508: who may spend the operator's AI budget.
 *
 * r161 meant "a viewer or a seatless account must not loop this and run up
 * the operator's provider bill" — but it accepted a member seat in ANY
 * workspace, and any account can create a workspace it owns (POST
 * /v1/workspaces), so the gate held nobody back. A seat now counts only in a
 * workspace an instance OPERATOR owns — the operator's own team, which no one
 * can mint for themselves. Operators keep unconditional access (the default
 * every install has after upgrading); a member of an operator's team keeps
 * the access they had. For a diagnosis the seat must be in a workspace the
 * service belongs to, so the spend is the team's, not a side project's.
 */
const AI_ACCESS_REFUSED =
  'AI features are limited to instance operators and to members of a workspace an operator owns — ask an operator to add you to their team workspace';

async function assertMayUseAi(
  db: Parameters<typeof userWorkspaceMemberships>[0],
  user: { id: number; isOperator: boolean },
  withinWorkspaceIds: number[] | null,
): Promise<void> {
  if (user.isOperator) return;
  for (const seat of await userWorkspaceMemberships(db, user.id)) {
    if (!roleAtLeast(seat.role, 'member')) continue;
    if (withinWorkspaceIds && !withinWorkspaceIds.includes(seat.workspaceId)) continue;
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, seat.workspaceId) });
    if (!ws) continue;
    const owner = await db.query.users.findFirst({ where: eq(users.id, ws.ownerId) });
    if (owner?.isInstanceOperator === true && !owner.deactivatedAt) return;
  }
  throw forbidden(AI_ACCESS_REFUSED);
}

async function loadAiConfig(
  db: Parameters<typeof getSettingJson>[0],
): Promise<{ baseUrl: string; model: string; apiKey: string } | null> {
  const json = await getSettingJson<{ baseUrl?: string; model?: string }>(db, AI_CONFIG_KEY, null);
  const encrypted = await getSettingString(db, AI_KEY_KEY, null);
  if (!json?.baseUrl || !json.model || !encrypted) return null;
  try {
    return { baseUrl: json.baseUrl, model: json.model, apiKey: decrypt(encrypted) };
  } catch {
    // Undecryptable envelope (rotated-away master key) → treat as unconfigured
    // rather than half-working: the operator re-enters the key.
    return null;
  }
}

/** POST an OpenAI-compatible chat completion and return the assistant text. */
async function chatCompletion(
  cfg: { baseUrl: string; model: string; apiKey: string },
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  maxTokens: number,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages,
      }),
      signal: AbortSignal.timeout(DIAGNOSIS_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
    throw new HttpError(504, 'ai_upstream', `The AI provider ${reason}.`);
  }
  if (!res.ok) {
    // Body may echo the key on auth failures — never relay it upstream-text.
    throw new HttpError(502, 'ai_upstream', `The AI provider rejected the request (HTTP ${res.status}).`);
  }
  const content = parseChatCompletionContent(await res.json().catch(() => null));
  if (!content) throw new HttpError(502, 'ai_upstream', 'The AI provider returned an unreadable response.');
  return content;
}

async function requestDiagnosis(
  cfg: { baseUrl: string; model: string; apiKey: string },
  logTail: string,
): Promise<string> {
  return chatCompletion(cfg, buildDiagnosisMessages(logTail), DIAGNOSIS_MAX_TOKENS);
}

/**
 * F833: the log tail the provider sees, sanitized BEFORE the final cut. The
 * sanitizer keys on whole lines (`DB_PASSWORD=…`, `scheme://user:pass@`); a
 * character cut inside such a line left `WORD=hunter2` / `ploy:pw@host`
 * unmasked. Sanitize a window one MAX_LOG_CHARS wider, started on a line
 * boundary when it has one, then cut — every mask is applied in full context.
 */
function logTailForAi(raw: string): string {
  const window = truncateTail(raw, MAX_LOG_CHARS * 2);
  const midLine = window.length < raw.length && raw[raw.length - window.length - 1] !== '\n';
  const start = midLine ? window.indexOf('\n') + 1 : 0;
  return truncateTail(sanitizeLogForAi(window.slice(start)));
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // Config status — any authenticated user (the deploy tab needs it to decide
  // whether to offer the button). Carries no key material.
  app.get('/config', async (req) => {
    const json = await getSettingJson<{ baseUrl?: string; model?: string }>(app.db, AI_CONFIG_KEY, null);
    const hasKey = (await getSettingString(app.db, AI_KEY_KEY, null)) !== null;
    const status: AiConfigStatusT = {
      configured: !!(json?.baseUrl && json.model && hasKey),
      // r658: the provider endpoint is operator configuration — often an
      // internal gateway's address. Only the operator's Settings page needs it.
      baseUrl: req.user!.isOperator ? (json?.baseUrl ?? null) : null,
      model: json?.model ?? null,
      hasApiKey: hasKey,
    };
    return status;
  });

  // Config write — instance operator only. The key arrives once over the wire
  // and is immediately sealed; it is never echoed back.
  app.put('/config', { onRequest: [app.requireOperator] }, async (req) => {    const input = aiConfigUpdate.parse(req.body ?? {});
    await setSettingJson(app.db, AI_CONFIG_KEY, { baseUrl: input.baseUrl, model: input.model });
    if (input.apiKey) await setSettingString(app.db, AI_KEY_KEY, encrypt(input.apiKey));
    // F832: the audit entity fans out to the activity feed, the live event
    // stream and notifications — never the baseUrl's userinfo or path.
    void audit(app.db, req.user!.id, 'ai.config', `${input.model} @ ${redactEgressTarget(input.baseUrl)}`);
    return { ok: true };
  });

  // Diagnose a failed deployment: member floor on the service (this call
  // ships the log to the configured provider and spends the operator's
  // money — read-only viewers don't get to trigger it).
  // F834: and capped like suggest-manifest — each call ships up to 16 KB of
  // log to the paid provider; the global 1000/min limiter is no spend cap.
  app.post('/services/:id/deploys/:depId/diagnose', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const id = num((req.params as { id: string }).id);
    const depId = num((req.params as { depId: string }).depId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    // r508: a member role on the service is not enough on its own — a service
    // in a workspace the caller created for themselves would pass it.
    await assertMayUseAi(app.db, req.user!, await serviceWorkspaceIds(app.db, svc.id));

    // The deployment must belong to the service in the URL — same binding
    // rule as the log stream, for the same tenant-isolation reason.
    const dep = await app.db.query.deployments.findFirst({ where: eq(deployments.id, depId) });
    if (!dep || dep.serviceId !== id) throw notFound('Deployment not found');
    if (dep.status !== 'failed') throw badRequest('Only failed deployments can be diagnosed');

    const cfg = await loadAiConfig(app.db);
    if (!cfg) throw badRequest('AI diagnosis is not configured — ask the operator to set it up in Settings');

    const raw = logBus.read(depId);
    if (!raw.trim()) throw badRequest('This deployment has no build log to diagnose');

    const diagnosis = await requestDiagnosis(cfg, logTailForAi(raw));
    void audit(app.db, req.user!.id, 'ai.diagnose', `service=${svc.name} deployment=${depId}`);
    return { diagnosis, model: cfg.model };
  });

  // AI deploy assist: describe the app in plain language, get a schema-valid
  // .ninedeploy manifest back. The model's output is parsed and validated
  // against the STRICT manifest schema before it reaches the caller — an
  // LLM can hallucinate values, but it cannot invent fields or smuggle
  // unvalidated shapes into the creator form.
  // r161: same spend rule as diagnose — a viewer (or a seatless account) must
  // not be able to loop this and run up the operator's provider bill.
  // r508: …and a seat in a self-created workspace does not count either.
  app.post('/suggest-manifest', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    await assertMayUseAi(app.db, req.user!, null);
    const input = suggestManifest.parse(req.body ?? {});
    const cfg = await loadAiConfig(app.db);
    if (!cfg) throw badRequest('AI assist is not configured — ask the operator to set it up in Settings');

    const raw = await chatCompletion(cfg, buildSuggestMessages(input.description), SUGGEST_MAX_TOKENS);
    let candidate: unknown;
    try {
      candidate = JSON.parse(stripJsonFence(raw));
    } catch {
      throw new HttpError(502, 'ai_upstream', 'The AI returned malformed JSON — try rephrasing the description.');
    }
    const parsed = ninedeployManifest.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new HttpError(502, 'ai_upstream', `The AI suggested an invalid manifest (${first?.path.join('.') || 'root'}: ${first?.message ?? 'unknown'}). Try rephrasing.`);
    }
    void audit(app.db, req.user!.id, 'ai.suggest', 'manifest');
    return { manifest: parsed.data, model: cfg.model };
  });
};
