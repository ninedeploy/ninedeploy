/**
 * `ninedeploy notifications {list,create-webhook,test,rm}` — operator
 * UI for the notification channel registry. PR #49 (G-06) adds
 * the HMAC + body-template fields for the `webhook` channel type;
 * the other types (slack, discord, telegram, ntfy, email) keep
 * their existing surface and accept an opaque `configJson` blob.
 */
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, spinner, success, table } from '../lib/format.js';

const num = (v: string, usage: string): number => {
  const n = Number(v);
  if (Number.isNaN(n)) {
    error(usage);
    throw new Error(usage);
  }
  return n;
};

const fail = (err: unknown): void => {
  error(err instanceof Error ? err.message : String(err));
};

/** `ninedeploy notifications list` */
export async function notificationsList(client: NineDeployClient): Promise<void> {
  header('Notification Channels');
  const rows = await spinner('Fetching', () => client.notifications.listChannels());
  if (rows.length === 0) {
    info('No notification channels configured.');
    return;
  }
  table(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      events: r.eventFilter || c.dim('(all)'),
      active: r.active ? 'yes' : 'no',
    })),
    ['id', 'name', 'type', 'events', 'active'],
  );
}

/**
 * `ninedeploy notifications create-webhook <name> <url> [--secret s]
 *                                            [--header h] [--algo sha256|sha1]
 *                                            [--template k=v ...]`
 *
 * The `webhook` channel type is the G-06 outbound integration
 * (HMAC-signed POST). The CLI builds a `configJson` blob from
 * the flags and sends it through the existing channel create
 * endpoint. `--template` accepts a flat key=value list (e.g.
 * `--template title=Deploy message='${event} done'`) and
 * assembles a JSON object that the server's `renderWebhookBody`
 * expands at send time.
 */
export async function notificationsCreateWebhook(
  client: NineDeployClient,
  name: string,
  url: string,
  opts: {
    secret?: string;
    header?: string;
    algo?: 'sha256' | 'sha1';
    eventFilter?: string;
    template?: string[];
  } = {},
): Promise<void> {
  if (!name || !url) {
    error('Usage: ninedeploy notifications create-webhook <name> <url> [--secret s] [--header h] [--algo sha256|sha1] [--template k=v ...]');
    return;
  }
  const config: Record<string, unknown> = {};
  if (opts.secret) config.secret = opts.secret;
  if (opts.header) config.headerName = opts.header;
  if (opts.algo) config.algorithm = opts.algo;
  if (opts.template && opts.template.length > 0) {
    const tpl: Record<string, string> = {};
    for (const raw of opts.template) {
      const eq = raw.indexOf('=');
      if (eq <= 0) {
        error(`--template expects key=value pairs, got: ${raw}`);
        return;
      }
      tpl[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
    config.template = tpl;
  }
  try {
    const ch = await client.notifications.createChannel({
      name,
      type: 'webhook',
      target: url,
      eventFilter: opts.eventFilter,
      configJson: Object.keys(config).length > 0 ? JSON.stringify(config) : undefined,
    });
    success(`Webhook channel "${ch.name}" created (id: ${ch.id}).`);
    if (opts.secret) {
      info(`HMAC signature header: ${opts.header ?? 'X-NineDeploy-Signature'} (${opts.algo ?? 'sha256'})`);
    }
    if (opts.template && opts.template.length > 0) {
      info(`Custom body template: ${opts.template.length} field(s)`);
    }
  } catch (err) { fail(err); }
}

/**
 * `ninedeploy notifications create-fcm <name> <deviceToken>
 *                                          --service-account <file>`
 *
 * The `fcm` channel type is the G-22 push-notification
 * integration (Firebase Cloud Messaging HTTP v1). The
 * device token is the FCM registration token of a
 * target device; the service account JSON is the file
 * Firebase issues when the operator creates a project
 * service account with the `Firebase Cloud Messaging
 * API` role. The CLI reads the file from disk so the
 * service account never lands on the operator's shell
 * history.
 *
 * Caveat: the service account's `private_key` is a PEM
 * block; the SDK will store the rendered `configJson`
 * encrypted at rest by `notificationChannels`. Treat
 * the service account JSON as a secret — same posture
 * as an SMTP password.
 */
export async function notificationsCreateFcm(
  client: NineDeployClient,
  name: string,
  deviceToken: string,
  opts: { serviceAccount: string },
): Promise<void> {
  if (!name || !deviceToken || !opts.serviceAccount) {
    error('Usage: ninedeploy notifications create-fcm <name> <deviceToken> --service-account <file.json>');
    return;
  }
  const fs = await import('node:fs/promises');
  let sa: string;
  try {
    sa = await fs.readFile(opts.serviceAccount, 'utf8');
  } catch (err) {
    error(`Failed to read service account JSON: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    const ch = await client.notifications.createChannel({
      name,
      type: 'fcm',
      target: deviceToken,
      configJson: sa,
    });
    success(`FCM channel "${ch.name}" created (id: ${ch.id}).`);
    info('Send a test event with `ninedeploy notifications test <id>` to verify wiring.');
  } catch (err) { fail(err); }
}

/** `ninedeploy notifications test <id>` — fire a test event
 *  through the channel so the operator can verify wiring. */
export async function notificationsTest(client: NineDeployClient, idStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy notifications test <id>');
  try {
    await client.notifications.testChannel(id);
    success(`Test event fired through channel #${id}.`);
  } catch (err) { fail(err); }
}

/** `ninedeploy notifications rm <id>` */
export async function notificationsRemove(client: NineDeployClient, idStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy notifications rm <id>');
  try {
    await client.notifications.removeChannel(id);
    success(`Channel #${id} removed.`);
  } catch (err) { fail(err); }
}
