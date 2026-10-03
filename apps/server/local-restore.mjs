/**
 * One-off local recovery: re-run containers for services/databases whose
 * containers were removed (rows + volumes are intact in .data).
 * Usage: node local-restore.mjs   (from apps/server, with dist built)
 */
import { createDb, services, databases } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { startDatabase } from './dist/engine/database.js';
import { writeDynamicConfig } from './dist/engine/proxy.js';
import { run } from './dist/lib/exec.js';

const { db } = createDb({ url: 'file:../../.data/ninedeploy.db' });

for (const d of await db.query.databases.findMany()) {
  if (!d.containerName) continue;
  try {
    await startDatabase(d, (l) => console.log(`  [db ${d.name}] ${l}`));
    await db.update(databases).set({ status: 'running' }).where(eq(databases.id, d.id));
    console.log(`OK database ${d.name} -> ${d.containerName}`);
  } catch (err) {
    console.error(`FAIL database ${d.name}: ${err instanceof Error ? err.message : err}`);
  }
}

for (const s of await db.query.services.findMany()) {
  if (s.type !== 'docker' || !s.image) continue;
  const name = s.runtimeId ?? `nd-svc-${s.slug}`;
  const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', '--network', 'ninedeploy'];
  if (s.volumeMount) args.push('-v', `nd-svc-${s.slug}-data:${s.volumeMount}`);
  if (s.memLimitMb > 0) args.push('--memory', `${s.memLimitMb}m`);
  args.push(s.image);
  try {
    await run('docker', args, {}, (l) => console.log(`  [svc ${s.name}] ${l}`));
    await db.update(services).set({ status: 'running' }).where(eq(services.id, s.id));
    console.log(`OK service ${s.name} -> ${name}`);
  } catch (err) {
    console.error(`FAIL service ${s.name}: ${err instanceof Error ? err.message : err}`);
  }
}

try {
  await writeDynamicConfig(db);
  console.log('OK traefik dynamic config rewritten');
} catch (err) {
  console.error(`FAIL traefik config: ${err instanceof Error ? err.message : err}`);
}
