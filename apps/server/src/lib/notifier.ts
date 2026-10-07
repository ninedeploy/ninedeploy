import { eq } from 'drizzle-orm';
import { type DB, notificationChannels, notificationLog, serviceNotificationChannels, services, type NotificationChannel } from '@ninedeploy/db';
import { webhookChannelConfig, type WebhookChannelConfig } from '@ninedeploy/schemas';
import { createHmac } from 'node:crypto';
import { decrypt } from './crypto.js';
import type { AppEvent } from './events.js';
import { encrypt } from './crypto.js';
import { guardedFetch } from './egressGuard.js';
import { sendFcm } from './fcm.js';
import { isOperator } from './resourceAccess.js';

/** Check if an event matches a channel's filter (comma-separated prefixes). */
function matchesFilter(eventAction: string, filter: string): boolean {
  // F112: drop empty segments — a trailing/doubled comma left a '' prefix that
  // every action startsWith, so "deploy.failed," received every event.
  const prefixes = filter.split(',').map((f) => f.trim()).filter((f) => f.length > 0);
  if (prefixes.length === 0) return true; // empty = all events
  return prefixes.some((prefix) => eventAction.startsWith(prefix));
}

/**
 * r473: read a channel's stored `config_json` tolerantly. The blob carries
 * provider secrets (webhook HMAC signing keys, FCM service-account private
 * keys), so it is stored as an envelope under the master key; rows written
 * before r473 hold bare JSON and keep working until the notifications
 * module's boot normalization rewrites them.
 */
export function channelConfigOf(ch: { configJson: string | null }): string | null {
  if (!ch.configJson) return null;
  return ch.configJson.startsWith('{') ? ch.configJson : decrypt(ch.configJson);
}

/**
 * Does a per-service subscription `scope` cover this audit action?
 * Pure and exported — the manifest wiring and its tests share it.
 */
export function scopeMatchesAction(scope: 'deploy' | 'failure' | 'alert', action: string): boolean {
  if (scope === 'deploy') return action.startsWith('deploy.');
  if (scope === 'failure') return action === 'deploy.failed';
  return action.startsWith('alert.');
}

/** Escape HTML special chars so user-controlled entities can't break Telegram's HTML parse mode. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format an event into a human-readable message. */
function formatMessage(action: string, entity?: string | null): string {
  const parts = action.split('.');
  const verb = parts[1] ?? parts[0]!;
  const subject = parts[0]!;
  const emoji: Record<string, string> = {
    service: '🖥️', database: '🗄️', domain: '🌐', deploy: '🚀', backup: '💾',
    tunnel: '☁️', user: '👤', template: '✨', source: '🔑', alert: '🔔',
  };
  const icon = emoji[subject] ?? '•';
  // F113: plain text. The entity is user-controlled, but escaping is per
  // channel (dispatchChannel: Telegram HTML, Slack & < >) — escaping here put
  // literal "&gt;" into Discord/email/ntfy/webhook/… messages.
  return `${icon} ${subject} ${verb}${entity ? `: ${entity}` : ''}`;
}

/** A slow notification target must not stall its channel's dispatch. */
const FETCH_TIMEOUT_MS = 10_000;

/** Backoff delays between delivery retries (attempt 1 → wait 500ms → attempt 2 → wait 2s → attempt 3). */
export const RETRY_DELAYS_MS = [500, 2000];

/** Run an async send with up to RETRY_DELAYS_MS.length retries; returns the attempt count. */
export async function withRetry(fn: () => Promise<void>, delays: number[] = RETRY_DELAYS_MS): Promise<number> {
  let attempt = 1;
  for (;;) {
    try {
      await fn();
      return attempt;
    } catch (err) {
      const delay = delays[attempt - 1];
      if (delay === undefined) throw err;
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Send to a Telegram bot chat. */
async function sendTelegram(botToken: string, chatId: string, message: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Telegram API ${res.status}: ${await res.text()}`);
}

/**
 * Send to a generic webhook (POST JSON) with optional
 * HMAC signing and a custom body template. The signing
 * secret, header name, algorithm, and template are read
 * from the channel's `configJson` blob (G-06).
 *
 * Signature format: the header carries
 * `<algorithm>=<hex-digest>`. The receiver verifies by
 * recomputing HMAC over the EXACT body bytes — the panel
 * does not strip whitespace or re-encode.
 */
async function sendWebhook(
  url: string,
  payload: { event: string; entity: string | null; ts: string; message: string },
  configJson: string | null,
): Promise<void> {
  const cfg = parseWebhookConfig(configJson);
  const body = renderWebhookBody(cfg, payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.secret) {
    const algo = cfg.algorithm ?? 'sha256';
    const sig = createHmac(algo, cfg.secret).update(body).digest('hex');
    headers[cfg.headerName ?? 'X-NineDeploy-Signature'] = `${algo}=${sig}`;
  }
  const res = await guardedFetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Webhook ${res.status}`);
}

/** Validate the channel's `configJson` blob against the
 *  webhook config schema; malformed input falls back to
 *  the default (no signing, default envelope). */
function parseWebhookConfig(raw: string | null | undefined): WebhookChannelConfig {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = webhookChannelConfig.safeParse(parsed);
  return result.success ? result.data : {};
}

/**
 * Render the request body. The default is the
 * `{ event, entity, ts, message }` envelope. A
 * `template: { ... }` object has its `${...}` placeholders
 * expanded string-by-string; a `template: "..."` string is
 * passed through JSON-encoded (after expansion).
 */
function renderWebhookBody(
  cfg: WebhookChannelConfig,
  payload: { event: string; entity: string | null; ts: string; message: string },
): string {
  if (!cfg.template) {
    return JSON.stringify(payload);
  }
  const substitutions: Record<string, string> = {
    event: payload.event,
    entity: payload.entity ?? '',
    ts: payload.ts,
    message: payload.message,
  };
  const expand = (s: string): string =>
    s.replace(/\$\{(event|entity|ts|message)\}/g, (_, k) => substitutions[k] ?? '');
  if (typeof cfg.template === 'string') {
    // The user wrote a JSON template. We expand placeholders
    // BEFORE JSON.parse so they don't conflict with the
    // string-delimiter escape rules.
    // r653: each substituted value is JSON-escaped first. The entity is a
    // service name, which may carry a `"` — expanded raw, a name like
    // `x","admin":true,"y":"` injected its own keys into the operator's
    // payload (and a signed one: the HMAC covers the injected body).
    const expanded = cfg.template.replace(/\$\{(event|entity|ts|message)\}/g, (_, k: string) =>
      JSON.stringify(substitutions[k] ?? '').slice(1, -1),
    );
    try {
      return JSON.stringify(JSON.parse(expanded));
    } catch {
      return JSON.stringify(expanded);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg.template)) {
    out[k] = typeof v === 'string' ? expand(v) : v;
  }
  return JSON.stringify(out);
}

/** Public shape of a Discord channel's `config_json` blob (Sprint 5 G-18 PR #24). */
export interface DiscordChannelConfig {
  /** Override the webhook's display name. */
  username?: string;
  /** Override the webhook's avatar (must be a Discord-hosted https URL). */
  avatarUrl?: string;
  /** When set, a coloured embed is appended with this title. */
  title?: string;
  /** Embed sidebar colour (24-bit RGB). Defaults to blue when `title` is set. */
  color?: number;
}

/** Send to a Discord webhook (Sprint 5 G-18 PR #24).
 *
 *  Uses Discord's `embeds` shape so the operator's webhook lights
 *  up with a coloured sidebar and structured fields, not just a
 *  plain text line. The shape is the same one Discord's own
 *  webhook editor produces; an operator who pastes the same URL
 *  into Discord's UI gets a richer preview than our plain
 *  `content` payload.
 *
 *  If a custom username / avatar is configured in the channel's
 *  `config_json` we forward it too; otherwise Discord uses the
 *  webhook's default identity.
 *
 *  Exported for tests; production code reaches it via
 *  `dispatchChannel(..., { configJson: channelConfigOf(ch) })`.
 */
export async function sendDiscord(
  webhookUrl: string,
  message: string,
  options?: DiscordChannelConfig,
): Promise<void> {
  // r653: the message carries tenant-chosen text (service names), so Discord
  // must not parse mentions out of it — `@everyone` in a service name pinged
  // the whole operator server.
  const body: Record<string, unknown> = { content: message, allowed_mentions: { parse: [] } };
  if (options?.username || options?.avatarUrl) {
    if (options.username) body.username = options.username;
    if (options.avatarUrl) body.avatar_url = options.avatarUrl;
  }
  // An optional embed with a coloured sidebar. Operators opt in by
  // setting `title` in the channel config; the default skips the
  // embed so a plain `content` line stays clean.
  if (options?.title) {
    body.embeds = [
      {
        title: options.title,
        description: message,
        color: typeof options.color === 'number' ? options.color : 0x2563eb,
      },
    ];
  }
  const res = await guardedFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

/** Send to a Slack incoming webhook. */
async function sendSlack(webhookUrl: string, message: string): Promise<void> {
  const res = await guardedFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}`);
}

/** Publish to an ntfy topic (target = topic URL, e.g. https://ntfy.sh/my-topic). */
async function sendNtfy(topicUrl: string, message: string): Promise<void> {
  const res = await guardedFetch(topicUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: message,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}

/** Push to a self-hosted Gotify server (target = the /message endpoint
 * including its app-token query, e.g. https://push.x.com/message?token=Axxx). */
async function sendGotify(endpoint: string, message: string): Promise<void> {
  const res = await guardedFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'NineDeploy', message, priority: 5 }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gotify ${res.status}`);
}

/** Pushover (target = `<appToken>@<userKey>` — the same packed form the
 * Telegram channel uses for its bot/chat pair). */
async function sendPushover(appToken: string, userKey: string, message: string): Promise<void> {
  const res = await guardedFetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: appToken, user: userKey, title: 'NineDeploy', message }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Pushover ${res.status}`);
}

/** Lark / Feishu custom-bot webhook. The bot answers HTTP 200 even on
 * rejection — the failure only shows up as a code in the JSON body. */
async function sendLark(webhookUrl: string, message: string): Promise<void> {
  const res = await guardedFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text: message } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Lark ${res.status}`);
  try {
    const body = (await res.json()) as { code?: number; msg?: string };
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(`Lark error ${body.code}: ${body.msg ?? 'rejected'}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Lark error')) throw err;
    /* non-JSON success body — treat as delivered */
  }
}

export interface EmailTarget {
  host: string;
  port: number;
  from: string;
  to: string;
  user?: string;
  pass?: string;
  secure?: boolean;
}

/** Parse (and validate the shape of) an email channel target. */
export function parseEmailTarget(target: string): EmailTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(target);
  } catch {
    throw new Error('Invalid email target (expected JSON with host, port, from, to)');
  }
  const t = parsed as Partial<EmailTarget>;
  if (!t.host || !t.port || !t.from || !t.to) {
    throw new Error('Invalid email target (expected JSON with host, port, from, to)');
  }
  return t as EmailTarget;
}

/** Send an email through SMTP (target = JSON config, credentials encrypted at rest). */
async function sendEmail(target: string, subject: string, message: string, recipient?: string): Promise<void> {
  const cfg = parseEmailTarget(target);
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure ?? cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
  });
  try {
    await transport.sendMail({ from: cfg.from, to: recipient ?? cfg.to, subject, text: message });
  } finally {
    transport.close();
  }
}

/**
 * Parse a `config_json` blob into a typed object, swallowing the
 * `null` / `''` / malformed case. Channels created before G-18 PR #24
 * have nothing stored here and we want them to keep working with the
 * default plain-content payload.
 */
function parseChannelConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * F924: FCM's verdict that the device token itself is permanently dead —
 * HTTP 404 (UNREGISTERED: app uninstalled / token rotated) or a 400 naming the
 * token as invalid (INVALID_ARGUMENT for the token, not the payload). sendFcm
 * reports `FCM send failed: <status> <body…>`; the body's errorCode is often
 * cut by its 200-char truncation, so the status is the reliable signal.
 * Transient errors (429/5xx) are not dead tokens.
 */
function isDeadFcmToken(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = /^FCM send failed: (\d{3})\b/.exec(err.message);
  if (!m) return false;
  return m[1] === '404' || (m[1] === '400' && /not a valid FCM registration token/i.test(err.message));
}

/** Dispatch a message to one channel by type. */
export async function dispatchChannel(
  type: string,
  target: string,
  event: AppEvent,
  message: string,
  options?: { configJson?: string | null },
): Promise<void> {
  if (type === 'telegram') {
    const idx = target.lastIndexOf(':');
    const botToken = idx > 0 ? target.slice(0, idx) : '';
    const chatId = idx > 0 ? target.slice(idx + 1) : '';
    if (!botToken || !chatId) throw new Error('Invalid Telegram target (expected botToken:chatId)');
    // parse_mode HTML: user-controlled text (<b>, malformed tags) must not break it (F113).
    await sendTelegram(botToken, chatId, escapeHtml(message));
  } else if (type === 'webhook') {
    await sendWebhook(target, { event: event.action, entity: event.entity, ts: event.ts, message }, options?.configJson ?? null);
  } else if (type === 'discord') {
    // Forward the operator's embed / identity overrides. Each key is
    // optional; missing keys fall through to Discord's default
    // webhook identity and the plain `content` line.
    const cfg = parseChannelConfig(options?.configJson);
    const discordOpts: DiscordChannelConfig = {};
    if (typeof cfg.username === 'string') discordOpts.username = cfg.username;
    if (typeof cfg.avatarUrl === 'string') discordOpts.avatarUrl = cfg.avatarUrl;
    if (typeof cfg.title === 'string') discordOpts.title = cfg.title;
    if (typeof cfg.color === 'number' && Number.isFinite(cfg.color)) discordOpts.color = cfg.color;
    await sendDiscord(target, message, discordOpts);
  } else if (type === 'slack') {
    // Slack treats & < > as control chars (<!channel>, <url|label>) — F113.
    await sendSlack(target, escapeHtml(message));
  } else if (type === 'ntfy') {
    await sendNtfy(target, message);
  } else if (type === 'gotify') {
    if (!/[?&]token=/.test(target)) throw new Error('Invalid Gotify target (expected the message endpoint URL including ?token=)');
    await sendGotify(target, message);
  } else if (type === 'pushover') {
    const at = target.indexOf('@');
    const appToken = at > 0 ? target.slice(0, at) : '';
    const userKey = at > 0 ? target.slice(at + 1) : '';
    if (!appToken || !userKey) throw new Error('Invalid Pushover target (expected appToken@userKey)');
    await sendPushover(appToken, userKey, message);
  } else if (type === 'lark') {
    await sendLark(target, message);
  } else if (type === 'email') {
    await sendEmail(target, `NineDeploy: ${event.action}`, message);
  } else if (type === 'fcm') {
    // `target` is the device token; `configJson` carries
    // the service account JSON. The body is the
    // notification body; the title defaults to the brand
    // inside `sendFcm`.
    if (!options?.configJson) {
      throw new Error('FCM channel missing service account configJson');
    }
    await sendFcm({
      deviceToken: target,
      serviceAccountJson: options.configJson,
      body: message,
      data: {
        // Hand the receiver the action + entity so a
        // mobile client can route on it without parsing
        // the localised body.
        action: event.action,
        entity: event.entity ?? '',
        ts: event.ts,
      },
    });
  } else {
    // Unknown channel types would otherwise log a misleading "sent" entry.
    throw new Error(`Unknown notification channel type: ${type}`);
  }
}

/**
 * Process an event through all active notification channels.
 * Telegram target format: `botToken:chatId`
 * Webhook/Discord/Slack target format: URL
 * ntfy target format: topic URL
 * Email target format: JSON {host, port, from, to, user?, pass?}
 *
 * Channels are dispatched CONCURRENTLY so a slow target (e.g. a dead SMTP with
 * retries) never stalls the event bus or every other channel behind it.
 */
export async function notifyEvent(db: DB, event: AppEvent): Promise<void> {
  let channels: NotificationChannel[];
  try {
    channels = await db.query.notificationChannels.findMany();
  } catch {
    return; // table might not exist yet
  }

  // Per-service subscriptions (manifest `notifications` rules) apply only to
  // events that carry a serviceId in their audit meta — most events don't.
  const serviceId = typeof event.meta?.['serviceId'] === 'number' ? (event.meta['serviceId'] as number) : null;
  let rules: Array<{ channelId: number; scope: string }> = [];
  if (serviceId != null) {
    try {
      rules = await db
        .select({ channelId: serviceNotificationChannels.channelId, scope: serviceNotificationChannels.scope })
        .from(serviceNotificationChannels)
        .where(eq(serviceNotificationChannels.serviceId, serviceId));
    } catch {
      rules = []; // table might not exist yet (pre-migration)
    }
    // r652: a rule bypasses the channel's own event filter, and channels are
    // operator configuration — so rules only count for a service an operator
    // owns. The manifest stopped writing them for anyone else; this also
    // silences rules an earlier release wrote, without waiting for a deploy.
    if (rules.length > 0) {
      try {
        const svc = await db.query.services.findFirst({
          where: eq(services.id, serviceId),
          columns: { ownerUserId: true },
        });
        if (svc?.ownerUserId == null || !(await isOperator(db, { id: svc.ownerUserId }))) rules = [];
      } catch {
        rules = [];
      }
    }
  }

  const deliver = async (ch: NotificationChannel): Promise<void> => {
    const message = formatMessage(event.action, event.entity);
    try {
      // r179: inside the try. A target that no longer decrypts (key retired)
      // threw out of deliver: no `failed` row was logged and the rejection
      // vanished into audit()'s catch, so the operator never learned the
      // channel was dead.
      const target = decrypt(ch.targetEncrypted);
      const attempts = await withRetry(() => dispatchChannel(ch.type, target, event, message, { configJson: channelConfigOf(ch) }));
      await db.insert(notificationLog).values({ channelId: ch.id, event: event.action, entity: event.entity, status: 'sent', attempts });
    } catch (err) {
      // F924: an fcm channel's target IS the device token. Once FCM declares it
      // dead, deactivate the channel — otherwise every later event re-sends
      // (3 attempts) to it and logs another failure, forever. Best-effort: the
      // failed row below must be written even if this update fails.
      const deadToken = ch.type === 'fcm' && isDeadFcmToken(err);
      if (deadToken) {
        try {
          await db.update(notificationChannels).set({ active: false }).where(eq(notificationChannels.id, ch.id));
        } catch {
          /* the failed row still records FCM's verdict */
        }
      }
      const reason = err instanceof Error ? err.message : String(err);
      await db
        .insert(notificationLog)
        .values({
          channelId: ch.id,
          event: event.action,
          entity: event.entity,
          status: 'failed',
          attempts: RETRY_DELAYS_MS.length + 1,
          error: deadToken ? `${reason} (device token rejected by FCM; channel deactivated)` : reason,
        })
        .catch(() => undefined); // one channel's log write must not sink the others
    }
  };

  await Promise.all(
    channels.map(async (ch) => {
      if (!ch.active) return;
      // Global path: the channel's own event filter, exactly as always.
      if (matchesFilter(event.action, ch.eventFilter)) {
        await deliver(ch);
        return;
      }
      // Additive path: a service rule subscribed this channel to this
      // service's events. The rule is explicit intent, so it bypasses the
      // global filter — a channel filtered to `backup.` can still receive
      // one service's deploy failures because a manifest asked for that.
      if (
        serviceId != null &&
        rules.some((r) => r.channelId === ch.id && scopeMatchesAction(r.scope as 'deploy' | 'failure' | 'alert', event.action))
      ) {
        await deliver(ch);
      }
    }),
  );
}

/**
 * Send an ad-hoc email through the first active email channel. `recipient` is
 * deliberately separate from the channel's configured fallback address: reset
 * links and invitations must go to the account they were issued for, never to
 * a shared operations mailbox. Returns false when no email channel exists.
 */
export async function sendSystemEmail(db: DB, recipient: string, subject: string, text: string): Promise<boolean> {
  let channel: NotificationChannel | undefined;
  try {
    channel = (await db.query.notificationChannels.findMany()).find((c) => c.active && c.type === 'email');
  } catch {
    return false; // table might not exist yet
  }
  if (!channel) return false;
  try {
    // F114: inside the try (r179 parity) — an undecryptable target must log
    // `failed` and return false, not reject past every caller's catch.
    const target = decrypt(channel.targetEncrypted);
    // F115: log the real attempt count, not a hard-coded 1.
    const attempts = await withRetry(() => sendEmail(target, subject, text, recipient));
    await db.insert(notificationLog).values({ channelId: channel.id, event: 'email.system', entity: subject, status: 'sent', attempts });
    return true;
  } catch (err) {
    await db.insert(notificationLog).values({
      channelId: channel.id,
      event: 'email.system',
      entity: subject,
      status: 'failed',
      attempts: RETRY_DELAYS_MS.length + 1,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Re-export encrypt for the notifications module
export { encrypt };
