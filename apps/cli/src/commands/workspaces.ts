import type { NineDeployClient } from '@ninedeploy/sdk';
import { spinner, table } from '../lib/format.js';

export async function workspacesList(client: NineDeployClient): Promise<void> {
  const list = await spinner('Fetching workspaces', () => client.workspaces.list());
  if (list.length === 0) {
    console.log('  No workspaces found.');
    return;
  }
  table(
    list.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      role: w.myRole,
      members: w.memberCount,
      projects: w.projectCount,
      created: new Date(w.createdAt).toLocaleDateString(),
    })),
    ['id', 'name', 'slug', 'role', 'members', 'projects', 'created'],
  );
}

export async function workspacesGet(client: NineDeployClient, id: string): Promise<void> {
  const wsId = Number.parseInt(id, 10);
  if (Number.isNaN(wsId)) {
    throw new Error('Workspace ID must be an integer');
  }
  const ws = await spinner('Fetching workspace', () => client.workspaces.get(wsId));
  console.log(`\n  Workspace #${ws.id}: ${ws.name} (${ws.slug})`);
  console.log(`  Role:        ${ws.myRole}`);
  if (ws.description) console.log(`  Description: ${ws.description}`);
  console.log(`  Created:     ${new Date(ws.createdAt).toLocaleString()}`);
  console.log('\n  Members:');
  table(
    ws.members.map((m) => ({
      userId: m.userId,
      nameEmail: m.name ? `${m.name} <${m.email}>` : m.email,
      role: m.role,
      joined: new Date(m.createdAt).toLocaleDateString(),
    })),
    ['userId', 'nameEmail', 'role', 'joined'],
  );
}

export async function workspacesCreate(client: NineDeployClient, name: string, opts: { description?: string }): Promise<void> {
  const ws = await spinner('Creating workspace', () =>
    client.workspaces.create({
      name,
      description: opts.description,
    }),
  );
  console.log(`  ✓ Workspace #${ws.id} created: ${ws.name} (${ws.slug})`);
}

export async function workspacesDelete(client: NineDeployClient, id: string): Promise<void> {
  const wsId = Number.parseInt(id, 10);
  if (Number.isNaN(wsId)) {
    throw new Error('Workspace ID must be an integer');
  }
  await spinner('Deleting workspace', () => client.workspaces.delete(wsId));
  console.log(`  ✓ Workspace #${wsId} deleted.`);
}
