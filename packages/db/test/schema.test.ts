import { fileURLToPath } from 'node:url';
import { eq, is } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/index.js';

const migrationsFolder = fileURLToPath(new URL('../src/migrations', import.meta.url));

describe('schema', () => {
  const tables = [
    'users',
    'apiTokens',
    'webauthnCredentials',
    'sessions',
    'workspaces',
    'workspaceMembers',
    'workspaceInvitations',
    'oidcProviders',
    'projects',
    'labels',
    'serviceProjects',
    'serviceWorkspaces',
    'serviceLabels',
    'services',
    'buildConfigs',
    'repoInsights',
    'deployments',
    'envVars',
    'sources',
    'domains',
    'webhooks',
    'backups',
    'metrics',
    'auditLog',
    'settings',
    'databases',
    'databaseAttachments',
    'serviceVolumeAttachments',
    'backupDestinations',
    'servers',
    'tunnels',
    'notificationChannels',
    'notificationLog',
    'configEntries',
    'installedPlugins',
    'logDrains',
  ] as const;

  it('exposes every expected table', () => {
    for (const table of tables) {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the whole point of this test is verifying each export exists by name.
      expect(schema[table], `missing table ${table}`).toBeDefined();
    }
  });

  it('exposes the expected enum arrays', () => {
    for (const name of [
      'workspaceRole',
      'serviceType',
      'serviceStatus',
      'buildPack',
      'deploymentStatus',
      'deploymentTrigger',
      'domainStatus',
      'sourceType',
      'backupScope',
      'backupStatus',
      'dbEngine',
      'dbStatus',
      'tunnelStatus',
      'channelType',
      'alertMetric',
      'alertOperator',
      'alertStateStatus',
    ] as const) {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the whole point of this test is verifying each enum export exists by name.
      expect(schema[name], `missing enum ${name}`).toBeDefined();
    }
  });

  it('exposes the expected relations', () => {
    for (const name of [
      'usersRelations',
      'workspacesRelations',
      'workspaceMembersRelations',
      'apiTokensRelations',
      'projectsRelations',
      'servicesRelations',
      'buildConfigsRelations',
      'deploymentsRelations',
      'envVarsRelations',
      'domainsRelations',
      'webhooksRelations',
      'metricsRelations',
      'databasesRelations',
      'databaseAttachmentsRelations',
      'notificationLogRelations',
      'alertRulesRelations',
      'alertStateRelations',
      'passwordResetTokensRelations',
    ] as const) {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the whole point of this test is resolving each relation export by name.
      expect(schema[name], `missing relation ${name}`).toBeDefined();
    }
  });

  it('resolves every foreign key reference in the schema', () => {
    // Derived from the live exports rather than a hand-maintained list, so a
    // newly added table can never silently skip its lazy `references(() => ...)`
    // callbacks (which is exactly how `service_volume_attachments` and the
    // label/project/workspace join tables slipped past this check before).
    const tables = Object.entries(schema as unknown as Record<string, unknown>).filter(
      (entry): entry is [string, SQLiteTable] => is(entry[1], SQLiteTable),
    );
    expect(tables.length).toBeGreaterThan(0);

    for (const [name, table] of tables) {
      const config = getTableConfig(table);
      for (const fk of config.foreignKeys) {
        // getName() resolves the lazy `references(() => ...)` callbacks.
        expect(fk.getName(), `unresolved foreign key on ${name}`).toContain('_fk');
      }
      // Touching the composite primary key + index config forces the table's
      // `(t) => ({ ... })` extra-config callback to run for join tables too.
      for (const index of config.indexes) expect(index.config.name).toBeTruthy();
      for (const pk of config.primaryKeys) expect(pk.getName()).toBeTruthy();
    }
  });

  it('runs a real insert + select + update roundtrip through the in-memory db', async () => {
    const { db } = schema.createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder });

    const inserted = await db
      .insert(schema.users)
      .values({ email: 'ada@example.com', passwordHash: 'hash', name: 'Ada' })
      .returning();
    expect(inserted[0]?.email).toBe('ada@example.com');

    const rows = await db.select().from(schema.users).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Ada');

    await db.update(schema.users).set({ name: 'Ada Lovelace' }).where(eq(schema.users.email, 'ada@example.com')).run();
    const updated = await db.select().from(schema.users).all();
    expect(updated[0]?.name).toBe('Ada Lovelace');
  });

  it('allows two deployments of the same service within the same second (non-unique index)', async () => {
    const { db } = schema.createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder });

    const [svc] = await db.insert(schema.services).values({ name: 'web', slug: 'web' }).returning();
    expect(svc?.id).toBeDefined();

    // `created_at` is stored as unix epoch SECONDS (integer timestamp mode):
    // two instants 500 ms apart within the same second map to the SAME stored
    // value, which the old UNIQUE (service_id, created_at) index rejected with
    // a constraint violation on the second insert (deploy trigger 500s).
    const t0 = new Date(1700000000000);
    const t1 = new Date(1700000000500);
    await db.insert(schema.deployments).values({ serviceId: svc!.id, createdAt: t0 });
    await db.insert(schema.deployments).values({ serviceId: svc!.id, createdAt: t1 });

    const rows = await db.select().from(schema.deployments).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.serviceId === svc!.id)).toBe(true);
  });

  it('roundtrips a workspace invitation row (table + indexes)', async () => {
    const { db } = schema.createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder });

    const [inviter] = await db
      .insert(schema.users)
      .values({ email: 'inviter@example.com', passwordHash: 'h' })
      .returning();
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ name: 'Acme', slug: 'acme', ownerId: inviter!.id })
      .returning();

    const [inv] = await db
      .insert(schema.workspaceInvitations)
      .values({
        workspaceId: ws!.id,
        email: 'invitee@example.com',
        role: 'member',
        token: 'a'.repeat(64),
        invitedByUserId: inviter!.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning();
    expect(inv?.id).toBeDefined();

    // Unique (workspaceId, email) prevents a second live invite for the same pair.
    await expect(
      db
        .insert(schema.workspaceInvitations)
        .values({
          workspaceId: ws!.id,
          email: 'invitee@example.com',
          role: 'admin',
          token: 'b'.repeat(64),
          invitedByUserId: inviter!.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }),
    ).rejects.toThrow();

    // Listing via the workspace index returns the row.
    const rows = await db
      .select()
      .from(schema.workspaceInvitations)
      .where(eq(schema.workspaceInvitations.workspaceId, ws!.id))
      .all();
    expect(rows).toHaveLength(1);
  });
});
