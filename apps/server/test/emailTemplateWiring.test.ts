/**
 * r610 regression guard: the workspace email templates are WIRED.
 *
 * `lib/emailTemplates.ts`, the `email_template_overrides` table and the
 * `/:wid/email-templates` routes shipped together: an admin could store an
 * override, list it and preview it — and every email NineDeploy actually sent
 * (invitations from both invite routes, the password reset) was hardcoded
 * text that never looked at it. Written, tested, never wired.
 *
 * These tests drive the real routes with the SMTP seam (`sendSystemEmail`)
 * mocked and assert what would go out:
 *  - an invitation sends the inviting workspace's override when one exists,
 *    and exactly the 0.10.37 text when none does (upgrade-safe);
 *  - the password reset is instance-scoped and never takes a workspace's
 *    override, and still sends exactly the 0.10.37 text.
 *
 * The source scan at the bottom keeps the declaration and the senders in
 * step: every template marked `sent` has a sender that renders it, nothing
 * renders a template marked unsent, and no file sends a system email with
 * text that did not come out of the renderer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { ALL_TEMPLATE_NAMES, TEMPLATE_DELIVERY } from '../src/lib/emailTemplates.js';
import { authRoutes } from '../src/modules/auth.js';
import { invitationRoutes } from '../src/modules/invitations.js';
import { workspaceRoutes } from '../src/modules/workspaces.js';
import { asUser, buildTestApp, createFakeDb, userRow } from './helpers.js';

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const notifierMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(async (..._args: unknown[]) => true),
  notifyEvent: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/notifier.js', () => notifierMocks);

beforeEach(() => {
  notifierMocks.sendSystemEmail.mockClear();
});

/** Every bound value in a drizzle `where` (the `eq(col, value)` params). */
function boundValues(where: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    const n = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
    if (Array.isArray(n.queryChunks)) {
      for (const chunk of n.queryChunks) walk(chunk);
    } else if ('value' in n && 'encoder' in n) {
      out.push(n.value);
    }
  };
  walk(where);
  return out;
}

interface StoredOverride {
  workspaceId: number;
  name: string;
  subject: string;
  text: string;
}

/** A findFirst resolver for `email_template_overrides` that answers the
 *  (workspace_id, name) predicate the renderer really builds. */
function overrideLookup(rows: StoredOverride[]) {
  return (args: unknown) => {
    const values = boundValues((args as { where?: unknown } | undefined)?.where);
    return rows.find((r) => values.includes(r.workspaceId) && values.includes(r.name));
  };
}

const WORKSPACE = {
  id: 1,
  name: 'Acme Workspace',
  slug: 'acme-workspace',
  description: null,
  // r621: the owner is a separate operator account (id 9), so the owner-is-
  // operator lookup never answers the inviter lookup (user 2, by id).
  ownerId: 9,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const pendingInvite = (email: string) => ({
  id: 100,
  workspaceId: 1,
  email,
  role: 'member',
  token: 'x'.repeat(64),
  invitedByUserId: 2,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  acceptedAt: null,
  acceptedByUserId: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

function inviteDb(email: string, overrides: StoredOverride[]) {
  return createFakeDb({
    findFirst: {
      workspaces: WORKSPACE,
      workspace_members: { id: 1, workspaceId: 1, userId: 2, role: 'owner' },
      // r621: overrides apply only when the workspace owner (user 2) is an
      // instance operator; every other users lookup (the invitee, by email)
      // finds no account.
      users: (args: unknown) =>
        boundValues((args as { where?: unknown } | undefined)?.where).includes(WORKSPACE.ownerId)
          ? userRow({ id: 9, email: 'owner@example.com', isInstanceOperator: true })
          : undefined,
      workspace_invitations: undefined,
      emailTemplateOverrides: overrideLookup(overrides),
    },
    insert: { workspace_invitations: [pendingInvite(email)] },
  });
}

/** The invitation email exactly as 0.10.37's hardcoded builder wrote it. */
function legacyInvite(acceptUrl: string) {
  return {
    subject: "You're invited to join Acme Workspace on NineDeploy",
    text: [
      'A workspace owner invited you to join the "Acme Workspace" workspace on NineDeploy as member.',
      '',
      'Click the link below to accept:',
      acceptUrl,
      '',
      'This invitation expires in 7 days.',
      '',
      "If you don't have an account yet, you'll be asked to create one before accepting.",
    ].join('\n'),
  };
}

const INVITE_OVERRIDE: StoredOverride = {
  workspaceId: 1,
  name: 'workspace-invitation',
  subject: 'Welcome aboard {{workspaceName}}',
  text: 'Hi! {{inviter}} wants you in {{workspaceName}} as {{role}}: {{acceptUrl}} ({{ttlDays}}d)',
};

// Both invite routes: POST /:id/invitations and the unified POST /:id/members
// (an unknown address drops into the invitation flow there).
const INVITE_ROUTES = [
  { label: 'POST /workspaces/:id/invitations', plugin: invitationRoutes, url: '/workspaces/1/invitations', role: true },
  { label: 'POST /workspaces/:id/members', plugin: workspaceRoutes, url: '/workspaces/1/members', role: false },
] as const;

describe('r610: invitation emails render through the workspace template', () => {
  for (const route of INVITE_ROUTES) {
    async function invite(overrides: StoredOverride[]) {
      const email = 'newbie@example.com';
      const app = await buildTestApp({ db: inviteDb(email, overrides) });
      await app.register(route.plugin, { prefix: '/workspaces' });
      const res = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: route.role ? { email, role: 'member' } : { email },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
      const token = res.headers['x-invitation-token'] as string;
      return { email, acceptUrl: `${config.publicUrl}/invite/${token}` };
    }

    it(`${route.label}: sends the workspace override when one is stored`, async () => {
      const { email, acceptUrl } = await invite([INVITE_OVERRIDE]);
      expect(notifierMocks.sendSystemEmail).toHaveBeenCalledTimes(1);
      expect(notifierMocks.sendSystemEmail).toHaveBeenCalledWith(
        expect.anything(),
        email,
        'Welcome aboard Acme Workspace',
        `Hi! A workspace owner wants you in Acme Workspace as member: ${acceptUrl} (7d)`,
      );
    });

    it(`${route.label}: sends the 0.10.37 text byte for byte without an override`, async () => {
      const { email, acceptUrl } = await invite([]);
      const legacy = legacyInvite(acceptUrl);
      expect(notifierMocks.sendSystemEmail).toHaveBeenCalledWith(expect.anything(), email, legacy.subject, legacy.text);
    });

    it(`${route.label}: ignores another workspace's override`, async () => {
      const { email, acceptUrl } = await invite([{ ...INVITE_OVERRIDE, workspaceId: 2 }]);
      const legacy = legacyInvite(acceptUrl);
      expect(notifierMocks.sendSystemEmail).toHaveBeenCalledWith(expect.anything(), email, legacy.subject, legacy.text);
    });
  }
});

describe('r610: the password reset renders the instance-wide template', () => {
  async function forgot(overrides: StoredOverride[]) {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          users: userRow({ id: 1, email: 'admin@example.com' }),
          emailTemplateOverrides: overrideLookup(overrides),
        },
        delete: { password_reset_tokens: [{}] },
        insert: { password_reset_tokens: [{}] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/forgot-password', payload: { email: 'Admin@Example.com' } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(notifierMocks.sendSystemEmail).toHaveBeenCalledTimes(1);
    const [, to, subject, text] = notifierMocks.sendSystemEmail.mock.calls[0] as [unknown, string, string, string];
    return { to, subject, text };
  }

  it('sends the 0.10.37 text byte for byte', async () => {
    const { to, subject, text } = await forgot([]);
    expect(to).toBe('admin@example.com');
    expect(subject).toBe('NineDeploy password reset');
    const link = text.match(/\n(https?:\/\/\S+\/reset-password\?token=\S+)\n/)?.[1];
    expect(link?.startsWith(`${config.publicUrl}/reset-password?token=`)).toBe(true);
    expect(text).toBe(
      `A password reset was requested for Admin@Example.com.\n\nOpen this link within 30 minutes to set a new password:\n${link}\n\nIf you did not request this, you can ignore this email.`,
    );
  });

  it("never sends a workspace's password-reset override", async () => {
    const { subject, text } = await forgot([
      { workspaceId: 1, name: 'password-reset', subject: 'PHISH', text: 'https://evil.example' },
    ]);
    expect(subject).toBe('NineDeploy password reset');
    expect(text).not.toContain('evil');
  });
});

describe('r610: every declared template has a sender, every system email a template', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.join(here, '..', 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  const engine = path.join(srcDir, 'lib', 'emailTemplates.ts');
  const sources = walk(srcDir)
    .filter((f) => f !== engine)
    .map((f) => ({ file: path.relative(srcDir, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') }));
  const renders = (name: string) => new RegExp(`renderTemplate\\(\\s*[\\w.]+,\\s*'${name}'`);

  it('a template marked sent is rendered by some sender', () => {
    const unsent = ALL_TEMPLATE_NAMES.filter(
      (name) => TEMPLATE_DELIVERY[name].sent && !sources.some((s) => renders(name).test(s.text)),
    );
    expect(unsent).toEqual([]);
  });

  it('a template marked unsent is rendered by nothing (flip `sent` when you wire one)', () => {
    const wired = ALL_TEMPLATE_NAMES.filter(
      (name) => !TEMPLATE_DELIVERY[name].sent && sources.some((s) => renders(name).test(s.text)),
    );
    expect(wired).toEqual([]);
    // Pinned so a NEW template cannot be declared unsent without a decision.
    expect(ALL_TEMPLATE_NAMES.filter((n) => !TEMPLATE_DELIVERY[n].sent)).toEqual([
      'domain-transfer',
      'backup-drill-failed',
    ]);
  });

  it('every file that sends a system email renders it through the engine', () => {
    const hardcoded = sources
      .filter((s) => s.file !== 'lib/notifier.ts' && /\bsendSystemEmail\(/.test(s.text))
      .filter((s) => !/\b(?:renderTemplate|render\w*Email)\(/.test(s.text))
      .map((s) => s.file);
    expect(hardcoded).toEqual([]);
  });
});
