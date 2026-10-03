import type { NineDeployClient } from '@ninedeploy/sdk';
import { table } from '../lib/format.js';

export async function demoSeed(client: NineDeployClient): Promise<void> {
  console.log('  Seeding Next.js Docker + PM2 Demo Environment…');
  const res = await client.demo.seed();
  console.log(`  ✓ Project created: ${res.projectName} (#${res.projectId})`);
  if (res.database) {
    console.log(`  ✓ Database created: ${res.database.name} (${res.database.engine})`);
  }
  table(
    res.services.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      port: s.port ? `:${s.port}` : '—',
      status: s.status,
    })),
    ['id', 'name', 'type', 'port', 'status'],
  );
  console.log('  ✓ Demo environment deployed and running successfully.');
}
