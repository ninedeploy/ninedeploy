import { eq, inArray } from 'drizzle-orm';
import { labels, serviceLabels } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createLabel, labelPatch, type Label, type LabelColor } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { assertWorkspaceRole } from '../lib/resourceAccess.js';
import { badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import { iso } from '../lib/serialize.js';

const DEFAULT_COLORS: readonly LabelColor[] = [
  'indigo',
  'emerald',
  'amber',
  'rose',
  'sky',
  'slate',
  'violet',
  'lime',
];

/** Workspace-scoped color token used by the UI. */
function normalizeColor(input: string | null | undefined): string {
  if (!input) return 'indigo';
  return (DEFAULT_COLORS as readonly string[]).includes(input) ? input : 'indigo';
}

interface SerializedLabelRow {
  id: number;
  workspaceId: number | null;
  name: string;
  color: string;
  serviceCount: number;
  createdAt: Date;
  updatedAt: Date;
}

async function serializeLabel(row: SerializedLabelRow): Promise<Label> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    color: row.color,
    serviceCount: row.serviceCount,
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
  };
}

/**
 * Label CRUD. Labels are workspace-scoped free-form tags that services can
 * carry via the `service_labels` join table (see `serviceTags.ts`).
 *
 * Authorization: every route requires a logged-in user. Operators can manage
 * every label; non-operators can only manage labels in workspaces they belong
 * to. Personal (workspaceId === null) labels are operator-only — they have
 * no workspace to gate on, so we'd otherwise hand any member a free way to
 * plant labels other tenants' services could pick up.
 */
export const labelRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const query = req.query as { workspaceId?: string };
    const user = req.user!;
    // Request-resolved flag (see plugins/auth.ts) — a fresh DB read here
    // would ignore API-token scope narrowing.
    const operator = user.isOperator;

    // Restrict the result to labels the caller can see:
    //   • workspace labels → only in workspaces the user belongs to
    //   • unscoped labels   → operator-only
    // Optionally narrow by a specific workspace.
    const requestedWs = query.workspaceId ? parseInt(query.workspaceId, 10) : null;

    const rows = await app.db.query.labels.findMany();
    let visibleRows = rows;
    if (!operator) {
      const memberships = await app.db.query.workspaceMembers.findMany({
        where: (m, { eq: eqOp }) => eqOp(m.userId, user.id),
      });
      const wsIds = new Set(memberships.map((m) => m.workspaceId));
      visibleRows = rows.filter((r) => r.workspaceId != null && wsIds.has(r.workspaceId));
    }
    const narrowed = requestedWs != null && Number.isInteger(requestedWs)
      ? visibleRows.filter((r) => r.workspaceId === requestedWs)
      : visibleRows;

    // Service counts: one GROUP BY-style query.
    const countRows = await app.db
      .select({ labelId: serviceLabels.labelId })
      .from(serviceLabels);
    const counts = new Map<number, number>();
    for (const r of countRows) counts.set(r.labelId, (counts.get(r.labelId) ?? 0) + 1);

    return Promise.all(
      narrowed.map((r) =>
        serializeLabel({
          id: r.id,
          workspaceId: r.workspaceId,
          name: r.name,
          color: r.color,
          serviceCount: counts.get(r.id) ?? 0,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }),
      ),
    );
  });

  app.post('/', async (req) => {
    const input = createLabel.parse(req.body);
    const user = req.user!;
    if (input.workspaceId == null) {
      if (!user.isOperator) {
        throw forbidden('Personal labels are operator-only; pick a workspace');
      }
    } else {
      // Writing labels into a workspace is a write, not a read: the floor is
      // `member` — a viewer seat stays read-only (docs/WORKSPACES_RBAC.md).
      await assertWorkspaceRole(app.db, input.workspaceId, user, 'member');
    }
    const [row] = await app.db
      .insert(labels)
      .values({
        workspaceId: input.workspaceId ?? null,
        name: input.name.trim(),
        color: normalizeColor(input.color),
      })
      .returning();
    if (!row) throw badRequest('Could not create label');
    void audit(app.db, user.id, 'label.create', `${row.name}${row.workspaceId ? ` (ws ${row.workspaceId})` : ''}`);
    return serializeLabel({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      color: row.color,
      serviceCount: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = labelPatch.parse(req.body);
    const user = req.user!;
    const existing = await app.db.query.labels.findFirst({ where: eq(labels.id, id) });
    if (!existing) throw notFound('Label not found');
    if (existing.workspaceId == null) {
      if (!user.isOperator) throw forbidden('Personal labels are operator-only');
    } else {
      await assertWorkspaceRole(app.db, existing.workspaceId, user, 'member');
    }
    const [updated] = await app.db
      .update(labels)
      .set({
        ...(input.name != null && { name: input.name.trim() }),
        ...(input.color != null && { color: normalizeColor(input.color) }),
      })
      .where(eq(labels.id, id))
      .returning();
    if (!updated) throw notFound('Label not found');
    const countRow = await app.db
      .select({ n: serviceLabels.labelId })
      .from(serviceLabels)
      .where(eq(serviceLabels.labelId, id));
    void audit(app.db, user.id, 'label.update', updated.name);
    return serializeLabel({
      id: updated.id,
      workspaceId: updated.workspaceId,
      name: updated.name,
      color: updated.color,
      serviceCount: countRow.length,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const user = req.user!;
    const existing = await app.db.query.labels.findFirst({ where: eq(labels.id, id) });
    if (!existing) throw notFound('Label not found');
    if (existing.workspaceId == null) {
      if (!user.isOperator) throw forbidden('Personal labels are operator-only');
    } else {
      await assertWorkspaceRole(app.db, existing.workspaceId, user, 'member');
    }
    await app.db.delete(labels).where(eq(labels.id, id));
    void audit(app.db, user.id, 'label.delete', existing.name);
    return { ok: true };
  });
};

// Internal helper: bulk-validate that a set of label ids is visible to the
// caller (the label's workspace is one the user belongs to, or it's a global
// label and the user is an operator). Returns the set of OK ids; the rest are
// rejected.
export async function visibleLabelIds(
  db: import('@ninedeploy/db').DB,
  user: { id: number; isOperator: boolean },
  ids: number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  if (!user.isOperator) {
    const memberships = await db.query.workspaceMembers.findMany({
      where: (m, { eq: eqOp }) => eqOp(m.userId, user.id),
    });
    const wsIds = new Set(memberships.map((m) => m.workspaceId));
    const rows = await db.query.labels.findMany({ where: inArray(labels.id, ids) });
    return rows.filter((r) => r.workspaceId != null && wsIds.has(r.workspaceId)).map((r) => r.id);
  }
  // Operators can see every requested id (we still verify the rows exist).
  const rows = await db.query.labels.findMany({ where: inArray(labels.id, ids) });
  return rows.map((r) => r.id);
}
