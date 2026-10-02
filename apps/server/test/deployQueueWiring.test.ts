import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * r640: a route that queues a deployment for a signed-in caller must go
 * through `lib/deployQueue.ts` (`enqueueUserDeploy`), which carries the
 * stored-definition privilege check and the per-service queued cap. The volume
 * routes once inserted their own `queued` rows and skipped both, letting a
 * member redeploy an operator-authored compose service. This guard reads the
 * source of every module and refuses a NEW direct queued insert.
 *
 * The allowlist names each legitimate direct insert with the reason it does
 * not belong in the helper. Adding to it needs the same justification.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'hooks.ts': {
    count: 2,
    reason: 'git webhook deliveries (preview + push): no session user; gated by assertWebhookMayDeploy against the service OWNER',
  },
  'templates.ts': {
    count: 1,
    reason: 'first deploy of a service this request just created from a template that already passed assertMayUseHostPrivilege',
  },
  'demo.ts': {
    count: 1,
    reason: 'operator-only (requireAdmin) demo seed of a fixed, unprivileged dockerfile service',
  },
};

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/modules');

/** Count `insert(deployments)` calls whose values carry `status: 'queued'`. */
function queuedInserts(source: string): number {
  let n = 0;
  const re = /\.insert\(\s*(?:\w+\.)?deployments\s*\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    // The values object follows the call within a few lines.
    const window = source.slice(m.index, m.index + 400);
    if (/status:\s*['"]queued['"]/.test(window)) n++;
  }
  return n;
}

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? moduleFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

describe('deployment enqueue wiring (r640)', () => {
  it('no module inserts a queued deployment outside the shared helper', () => {
    const offenders: string[] = [];
    for (const file of moduleFiles(modulesDir)) {
      const rel = path.relative(modulesDir, file).replace(/\\/g, '/');
      const found = queuedInserts(readFileSync(file, 'utf8'));
      const allowed = ALLOWED[rel]?.count ?? 0;
      if (found > allowed) offenders.push(`${rel}: ${found} direct queued insert(s), ${allowed} allowlisted`);
    }
    expect(offenders, 'route new enqueues through enqueueUserDeploy (lib/deployQueue.ts)').toEqual([]);
  });

  it('the allowlist is not stale (each entry still matches its file)', () => {
    for (const [rel, { count }] of Object.entries(ALLOWED)) {
      expect(queuedInserts(readFileSync(path.join(modulesDir, rel), 'utf8')), rel).toBe(count);
    }
  });

  it('the deploy and volume routes use the helper', () => {
    for (const rel of ['deploys.ts', 'serviceVolumes.ts']) {
      const src = readFileSync(path.join(modulesDir, rel), 'utf8');
      expect(src, rel).toMatch(/enqueueUserDeploy\(/);
      expect(queuedInserts(src), rel).toBe(0);
    }
  });

  it('the detector itself recognises a direct queued insert', () => {
    expect(queuedInserts("await app.db\n  .insert(deployments)\n  .values({ serviceId, status: 'queued' })")).toBe(1);
    expect(queuedInserts("await tx.insert(deployments).values({ status: 'running' })")).toBe(0);
  });
});
