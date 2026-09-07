/**
 * `ninedeploy email-templates {list,set,reset,preview}` —
 * G-30 transactional email template overrides.
 *
 * The CLI is a thin wrapper around the SDK; the heavy
 * lifting is `lib/emailTemplates.ts`. The `set` and
 * `reset` commands require the workspace's admin role
 * server-side, so a non-admin operator gets a clean
 * 403 rather than a silent no-op.
 */
import type { NineDeployClient, EmailTemplateName } from '@ninedeploy/sdk';
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

const NAMES: EmailTemplateName[] = [
  'password-reset',
  'workspace-invitation',
  'domain-transfer',
  'backup-drill-failed',
];

export async function emailTemplatesList(client: NineDeployClient, widStr: string): Promise<void> {
  const wid = num(widStr, 'Usage: ninedeploy email-templates list <workspaceId>');
  const res = await spinner('Fetching', () => client.emailTemplates.list(wid));
  header(`Email templates (workspace ${wid})`);
  table(
    res.templates.map((t) => ({
      name: t.name,
      overridden: t.overridden ? 'yes' : c.dim('no'),
      subject: t.subject ?? c.dim('(default)'),
    })),
    ['name', 'overridden', 'subject'],
  );
}

export async function emailTemplatesPreview(
  client: NineDeployClient,
  widStr: string,
  name: string,
  vars: string[] = [],
): Promise<void> {
  const wid = num(widStr, 'Usage: ninedeploy email-templates preview <workspaceId> <name> [key=value ...]');
  if (!NAMES.includes(name as EmailTemplateName)) {
    error(`Unknown template: ${name}. Valid names: ${NAMES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const parsed: Record<string, string> = {};
  for (const raw of vars) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      error(`--var expects key=value pairs, got: ${raw}`);
      return;
    }
    parsed[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  const res = await spinner('Rendering', () =>
    client.emailTemplates.preview(wid, name as EmailTemplateName, parsed),
  );
  header(`Preview: ${name}${res.overridden ? c.cyan(' (overridden)') : ''}`);
  info(`Subject:  ${res.subject}`);
  console.log();
  console.log(res.text);
}

export async function emailTemplatesSet(
  client: NineDeployClient,
  widStr: string,
  name: string,
  opts: { subject: string; text: string },
): Promise<void> {
  const wid = num(widStr, 'Usage: ninedeploy email-templates set <workspaceId> <name> --subject <s> --text <t>');
  if (!NAMES.includes(name as EmailTemplateName)) {
    error(`Unknown template: ${name}. Valid names: ${NAMES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (!opts.subject || !opts.text) {
    error('Both --subject and --text are required');
    process.exitCode = 1;
    return;
  }
  try {
    await client.emailTemplates.set(wid, name as EmailTemplateName, opts.subject, opts.text);
    success(`Override set for ${name}.`);
  } catch (err) { fail(err); }
}

export async function emailTemplatesReset(client: NineDeployClient, widStr: string, name: string): Promise<void> {
  const wid = num(widStr, 'Usage: ninedeploy email-templates reset <workspaceId> <name>');
  if (!NAMES.includes(name as EmailTemplateName)) {
    error(`Unknown template: ${name}. Valid names: ${NAMES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  try {
    await client.emailTemplates.reset(wid, name as EmailTemplateName);
    success(`Override removed for ${name}.`);
  } catch (err) { fail(err); }
}
