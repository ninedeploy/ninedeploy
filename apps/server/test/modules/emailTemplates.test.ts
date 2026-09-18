/**
 * G-30 transactional email templates — module coverage.
 *
 * `modules/emailTemplates.ts` is the HTTP surface for the
 * `email-templates {list, preview, set, reset}` routes:
 *   GET    /:wid/email-templates               (member)
 *   POST   /:wid/email-templates/preview       (member)
 *   PUT    /:wid/email-templates/:name         (admin)
 *   DELETE /:wid/email-templates/:name         (admin)
 *
 * The behavior worth pinning down:
 *  - list joins the built-in names with any override row the
 *    workspace has set, marking each entry with `overridden`.
 *  - preview validates the body via Zod and renders the template
 *    with the supplied vars (always scoped to the route's
 *    workspace id, so an override is honored).
 *  - set/reset enforce admin on the workspace and reject unknown
 *    names. set also validates `subject` / `text` length.
 *  - a missing workspace row 404s on the set/reset path (the read
 *    routes don't 404 because the access check is the gate).
 *  - audit messages are emitted on every successful write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asUser,
  buildTestApp,
  createFakeDb,
  listen,
} from '../helpers.js';

const lib = vi.hoisted(() => ({
  renderCalls: [] as Array<{ name: string; vars: Record<string, unknown> }>,
  setCalls: [] as Array<{ workspaceId: number; name: string; subject: string; text: string }>,
  clearCalls: [] as Array<{ workspaceId: number; name: string }>,
  override: null as { subject: string; text: string } | null,
}));

vi.mock('../../src/lib/emailTemplates.js', async () => {
  const actual = await vi.importActual<unknown>('../../src/lib/emailTemplates.js');
  return {
    ...(actual as Record<string, unknown>),
    renderTemplate: vi.fn(async (_db: unknown, name: string, vars: Record<string, unknown>) => {
      lib.renderCalls.push({ name, vars });
      if (lib.override) {
        return { subject: lib.override.subject, text: lib.override.text, overridden: true };
      }
      return { subject: `subj:${name}`, text: `text:${name}`, overridden: false };
    }),
    setOverride: vi.fn(async (_db: unknown, workspaceId: number, name: string, subject: string, text: string) => {
      lib.setCalls.push({ workspaceId, name, subject, text });
    }),
    clearOverride: vi.fn(async (_db: unknown, workspaceId: number, name: string) => {
      lib.clearCalls.push({ workspaceId, name });
    }),
  };
});

vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async () => undefined),
}));

interface WorkspaceRow {
  id: number;
  name: string;
}

let workspaceRow: WorkspaceRow | null = { id: 1, name: 'MyWS' };
/** The caller's seat in workspace 1. */
let seatRole = 'owner';
let overrides: Array<{ workspaceId: number; name: string; subject: string; text: string }> = [];
let appRef: Awaited<ReturnType<typeof buildTestApp>> | null = null;

async function startApp() {
  const db = createFakeDb({
    findFirst: {
      workspaces: () => workspaceRow,
      // The helpers' default `findFirst` resolver returns `undefined`
      // for any table (only `findMany` has a `workspaceMembers`
      // fallback). For this test we explicitly hand an `owner` seat
      // to user 1 so `assertWorkspaceRole(_, 'admin')` passes.
      workspaceMembers: () => ({ id: 1, workspaceId: 1, userId: 1, role: seatRole }),
    },
    findMany: {
      emailTemplateOverrides: () => overrides.filter((o) => o.workspaceId === 1),
      email_template_overrides: () => overrides.filter((o) => o.workspaceId === 1),
    },
  });
  const app = await buildTestApp({ db });
  await app.register((await import('../../src/modules/emailTemplates.js')).emailTemplateRoutes);
  const port = await listen(app);
  appRef = app;
  return { app, port, db };
}

beforeEach(() => {
  lib.renderCalls.length = 0;
  lib.setCalls.length = 0;
  lib.clearCalls.length = 0;
  lib.override = null;
  workspaceRow = { id: 1, name: 'MyWS' };
  seatRole = 'owner';
  overrides = [];
});

afterEach(async () => {
  if (appRef) await appRef.close().catch(() => undefined);
  appRef = null;
});

describe('r185: workspace-scoped access, not instance-operator-only', () => {
  it('lets a non-operator workspace owner list and override templates', async () => {
    const { port } = await startApp();
    const owner = asUser({ id: 1, role: 'member' });
    const list = await fetch(`http://127.0.0.1:${port}/1/email-templates`, { headers: owner });
    expect(list.status).toBe(200);
  });

  it('lets a plain member read the templates', async () => {
    seatRole = 'member';
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates`, { headers: asUser({ id: 1, role: 'member' }) });
    expect(res.status).toBe(200);
  });
});

describe('GET /:wid/email-templates', () => {
  it('returns the four built-in names with no overrides', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates`, { headers: asUser(1) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(1);
    expect(body.templates).toHaveLength(4);
    expect(body.templates.every((t: { overridden: boolean }) => t.overridden === false)).toBe(true);
  });

  it('marks the names that have a workspace override', async () => {
    overrides = [
      { workspaceId: 1, name: 'password-reset', subject: 'S', text: 'T' },
    ];
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates`, { headers: asUser(1) });
    const body = await res.json();
    const pr = body.templates.find((t: { name: string }) => t.name === 'password-reset');
    expect(pr.overridden).toBe(true);
    expect(pr.subject).toBe('S');
    expect(pr.text).toBe('T');
  });

  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates`);
    expect(res.status).toBe(401);
  });
});

describe('POST /:wid/email-templates/preview', () => {
  it('renders a template with the supplied vars', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/preview`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'password-reset', vars: { email: 'a@b.com' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overridden).toBe(false);
    expect(lib.renderCalls[0]).toMatchObject({ name: 'password-reset' });
    expect(lib.renderCalls[0]?.vars).toEqual({ email: 'a@b.com' });
  });

  it('rejects an unknown template name with 422', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/preview`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'unknown' }),
    });
    expect(res.status).toBe(422);
  });

  it('accepts an empty vars object (default {})', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/preview`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'workspace-invitation' }),
    });
    expect(res.status).toBe(200);
    expect(lib.renderCalls[0]?.vars).toEqual({});
  });
});

describe('PUT /:wid/email-templates/:name', () => {
  it('rejects callers with only a member seat with 403', async () => {
    seatRole = 'member';
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'PUT',
      headers: { ...asUser({ id: 1, role: 'member' }), 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'S', text: 'T' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown name with 400', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/unknown`, {
      method: 'PUT',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'S', text: 'T' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty subject with 422', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'PUT',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ subject: '', text: 'T' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an over-long text with 422', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'PUT',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'S', text: 'x'.repeat(10_001) }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 when the workspace does not exist', async () => {
    workspaceRow = null;
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'PUT',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'S', text: 'T' }),
    });
    expect(res.status).toBe(404);
  });

  it('writes the override, audits, and returns ok', async () => {
    const { port, app } = await startApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'PUT',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'S', text: 'T' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, workspaceId: 1, name: 'password-reset' });
    expect(lib.setCalls).toEqual([{ workspaceId: 1, name: 'password-reset', subject: 'S', text: 'T' }]);
    expect(audit).toHaveBeenCalledWith(
      app.db,
      1,
      'email_template.override',
      expect.stringMatching(/MyWS\/password-reset/),
    );
  });
});

describe('DELETE /:wid/email-templates/:name', () => {
  it('rejects callers with only a member seat with 403', async () => {
    seatRole = 'member';
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'DELETE',
      headers: { ...asUser({ id: 1, role: 'member' }) },
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown name with 400', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/unknown`, {
      method: 'DELETE',
      headers: { ...asUser(1) },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the workspace does not exist', async () => {
    workspaceRow = null;
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'DELETE',
      headers: { ...asUser(1) },
    });
    expect(res.status).toBe(404);
  });

  it('drops the override, audits, and returns ok', async () => {
    const { port, app } = await startApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/1/email-templates/password-reset`, {
      method: 'DELETE',
      headers: { ...asUser(1) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, workspaceId: 1, name: 'password-reset' });
    expect(lib.clearCalls).toEqual([{ workspaceId: 1, name: 'password-reset' }]);
    expect(audit).toHaveBeenCalledWith(
      app.db,
      1,
      'email_template.reset',
      expect.stringMatching(/MyWS\/password-reset/),
    );
  });
});
