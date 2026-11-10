import { describe, expect, it, vi } from 'vitest';
import type { VolumeImport } from '@ninedeploy/schemas';
import type { ImportReceipt } from '../src/commands/importApply.js';
import { importVolumes, renderVolumePreview, type VolumeClient, volumeCommand } from '../src/commands/importVolumes.js';
import type { ImportPlan, PlanService } from '../src/lib/importers/plan.js';

const SHA = 'c'.repeat(64);
const svc = (over: Partial<PlanService> = {}): PlanService => ({
  ref: 'blog', name: 'blog', kind: 'image', create: { name: 'blog', image: 'ghost:5', volumeMount: '/var/lib/ghost/content' } as never,
  domains: [], env: [], volumes: [{ mountPath: '/var/lib/ghost/content', source: 'volume', name: 'blog-content' }], issues: [],
  runtime: { kind: 'swarm-service', name: 'blog' }, ...over,
});
const plan = (services: PlanService[]): ImportPlan => ({ planVersion: 1, source: { kind: 'caprover', url: 'http://src', version: null, scope: '' }, generatedAt: '', services, databases: [], notes: [] });
const receipt = (items: ImportReceipt['items'] = { 'service:blog': { kind: 'service', ref: 'blog', name: 'blog', state: 'done', id: 7, at: 't', notes: [] } }): ImportReceipt =>
  ({ receiptVersion: 1, panel: 'https://p', source: { kind: 'caprover', url: 'http://src' }, items });
const row = (over: Partial<VolumeImport> = {}): VolumeImport => ({
  id: 41, serviceId: 7, volumeName: 'nd-svc-blog-data', status: 'completed', sizeBytes: 10, receivedBytes: 10, chunkSize: 8, sha256: SHA, filename: null,
  safetyBackupId: null, error: null, createdByUserId: 1, createdAt: '', updatedAt: '', startedAt: null, completedAt: null, ...over,
});

function panel(over: Partial<VolumeClient['volumeImports']> = {}) {
  const client: VolumeClient = {
    volumeImports: {
      importFile: vi.fn(async (_id, _data, opts) => { opts?.onCreated?.(row({ status: 'running' })); return row({ status: 'running' }); }) as never,
      get: vi.fn(async () => row()) as never,
      wait: vi.fn(async () => row({ safetyBackupId: 12 })) as never,
      ...over,
    },
  };
  return client;
}
const deps = (client: VolumeClient, r: ImportReceipt) => {
  const states: string[] = [];
  return {
    states,
    d: {
      client, receipt: r, save: vi.fn((x: ImportReceipt) => { states.push(x.items['volume:blog']?.state ?? '-'); }),
      hashFile: vi.fn(async () => ({ sha256: SHA, bytes: 10 })), open: () => async function* () { yield new Uint8Array([1]); }, now: () => new Date('2026-11-11T00:00:00Z'),
    },
  };
};

describe('volumeCommand', () => {
  it('mounts a named volume by its name, read-only, as a gzipped tar with numeric owners (no container needed)', () => {
    expect(volumeCommand(svc())).toEqual({
      command: 'docker run --rm -v blog-content:/v:ro alpine:3.21 tar -czf - --numeric-owner -C /v . > blog.volume.tar.gz',
      file: 'blog.volume.tar.gz', notes: [],
    });
  });

  it('reads a bind mount, or a volume without a usable name, through the source container', () => {
    const fromSwarm = volumeCommand(svc({ volumes: [{ mountPath: '/var/lib/ghost/content', source: 'bind' }] })) as { command: string; notes: string[] };
    expect(fromSwarm.command).toBe("docker run --rm --volumes-from $(docker ps -aq --filter label=com.docker.swarm.service.name=blog | head -n 1):ro alpine:3.21 tar -czf - --numeric-owner -C '/var/lib/ghost/content' . > blog.volume.tar.gz");
    expect(fromSwarm.notes).toEqual([expect.stringMatching(/stop the app without removing its container/)]);
    expect(volumeCommand(svc({ runtime: { kind: 'container', name: 'abc' }, volumes: [{ mountPath: '/var/lib/ghost/content', source: 'volume', name: 'a b' }] }))!).toMatchObject({ command: expect.stringContaining('--volumes-from abc:ro ') });
    const unknown = volumeCommand(svc({ runtime: undefined, volumes: [{ mountPath: '/var/lib/ghost/content', source: 'bind' }, { mountPath: '/logs', source: 'volume' }, { mountPath: '/etc/x.conf', source: 'file' }] })) as { command: string; notes: string[] };
    expect(unknown.command).toContain('--volumes-from <container>:ro');
    expect(unknown.notes).toEqual(['Only /var/lib/ghost/content moves; copy /logs by hand.', expect.stringMatching(/Replace <container>/), expect.stringMatching(/without removing/)]);
    expect(volumeCommand(svc({ create: { name: 'x', volumeMount: "/it's" } as never, volumes: [] }) as never)).toMatchObject({ command: expect.stringContaining("-C '/it'\\''s' .") });
    expect(volumeCommand(svc({ create: { name: 'x' } as never }))).toBeNull();
    expect(volumeCommand(svc({ volumes: [{ mountPath: '/var/lib/ghost/content', source: 'file' }] }))).toEqual({ manual: expect.stringMatching(/file mount/) });
  });

  it('previews what is waiting, ready, done or needs a person', () => {
    const p = plan([svc(), svc({ ref: 'cfg', name: 'cfg', volumes: [{ mountPath: '/var/lib/ghost/content', source: 'file' }] }), svc({ ref: 'new', name: 'new' }), svc({ ref: 'none', name: 'none', create: { name: 'none' } as never })]);
    const r = receipt({
      'service:blog': { kind: 'service', ref: 'blog', name: 'blog', state: 'done', id: 7, at: 't', notes: [] },
      'service:cfg': { kind: 'service', ref: 'cfg', name: 'cfg', state: 'done', id: 8, at: 't', notes: [] },
    });
    const lines = renderVolumePreview(p, r).join('\n');
    expect(lines).toContain('  + blog (/var/lib/ghost/content, NineDeploy service #7):');
    expect(lines).toContain('      then: --volume blog=blog.volume.tar.gz');
    expect(lines).toMatch(/– cfg: .*file mount/);
    expect(lines).toContain('  – new: not created yet (run import apply first)');
    expect(lines).not.toContain('none');
    r.items['volume:blog'] = { kind: 'volume', ref: 'blog', name: 'blog', state: 'done', importId: 41, sha256: SHA, at: 't', notes: [] };
    expect(renderVolumePreview(p, r).join('\n')).toContain(`  ✓ blog: imported (#41, sha256 ${SHA.slice(0, 12)}…)`);
    expect(renderVolumePreview(plan([]), null)).toEqual([]);
  });
});

describe('importVolumes', () => {
  it('uploads with the sha256, waits, and records the import and the snapshot', async () => {
    const client = panel();
    const r = receipt();
    const { d, states } = deps(client, r);
    await importVolumes(plan([svc()]), { blog: '/tmp/blog.volume.tar.gz' }, d);
    expect(client.volumeImports.importFile).toHaveBeenCalledWith(7, expect.any(Function), expect.objectContaining({ sizeBytes: 10, sha256: SHA, filename: 'blog.volume.tar.gz' }));
    expect(r.items['volume:blog']).toMatchObject({ kind: 'volume', state: 'done', importId: 41, sha256: SHA, bytes: 10, id: 7 });
    expect(r.items['volume:blog']!.notes).toEqual(['Imported into nd-svc-blog-data: 10 bytes, sha256 checked by the panel.', "The volume's earlier contents are in volume backup #12 (pre-import)."]);
    expect(states).toEqual(['pending', 'pending', 'done']);
    // done: never again
    await importVolumes(plan([svc()]), { blog: '/tmp/blog.volume.tar.gz' }, d);
    expect(client.volumeImports.importFile).toHaveBeenCalledTimes(1);
  });

  it('checks every archive first', async () => {
    const { d } = deps(panel(), receipt());
    await expect(importVolumes(plan([svc()]), { web: 'x' }, d)).rejects.toThrow('--volume names no service in the plan: web.');
    await expect(importVolumes(plan([svc()]), { blog: 'x' }, deps(panel(), receipt({})).d)).rejects.toThrow(/not been created yet/);
    await expect(importVolumes(plan([svc({ create: { name: 'blog' } as never })]), { blog: 'x' }, d)).rejects.toThrow(/no data volume/);
    d.hashFile.mockResolvedValueOnce({ sha256: SHA, bytes: 0 });
    await expect(importVolumes(plan([svc()]), { blog: 'x' }, d)).rejects.toThrow('x is empty.');
    const r = receipt();
    r.items['volume:blog'] = { kind: 'volume', ref: 'blog', name: 'blog', state: 'done', importId: 3, sha256: 'd'.repeat(64), at: 't', notes: [] };
    await expect(importVolumes(plan([svc()]), { blog: 'x' }, deps(panel(), r).d)).rejects.toThrow(/import #3 recorded for a different archive/);
  });

  it('resumes the same archive: a finished import is recorded, a running one awaited, a dead one replaced', async () => {
    for (const [status, expectUpload] of [['completed', false], ['running', false], ['pending', true], ['failed', true]] as const) {
      const client = panel({ get: vi.fn(async () => row({ status })) as never });
      const r = receipt();
      r.items['volume:blog'] = { kind: 'volume', ref: 'blog', name: 'blog', state: 'failed', importId: 41, sha256: SHA, at: 't', notes: [] };
      await importVolumes(plan([svc()]), { blog: 'x' }, deps(client, r).d);
      expect(r.items['volume:blog']!.state).toBe('done');
      expect((client.volumeImports.importFile as ReturnType<typeof vi.fn>).mock.calls.length > 0).toBe(expectUpload);
      if (status === 'pending') expect(client.volumeImports.importFile).toHaveBeenCalledWith(7, expect.anything(), expect.objectContaining({ resumeImportId: 41 }));
      if (status === 'failed') expect(client.volumeImports.importFile).toHaveBeenCalledWith(7, expect.anything(), expect.not.objectContaining({ resumeImportId: 41 }));
    }
  });

  it('records failures, and names an old panel', async () => {
    let r = receipt();
    await importVolumes(plan([svc()]), { blog: 'x' }, deps(panel({ importFile: vi.fn(async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); }) as never }), r).d);
    expect(r.items['volume:blog']).toMatchObject({ state: 'failed', notes: [expect.stringMatching(/no volume import: update it \(0\.18\.27 or later\)/)] });
    r = receipt();
    await importVolumes(plan([svc()]), { blog: 'x' }, deps(panel({ importFile: vi.fn(async (_i, _d, o) => { o?.onCreated?.(row({ status: 'pending' })); throw Object.assign(new Error('Stop the service first'), { status: 409 }); }) as never }), r).d);
    expect(r.items['volume:blog']).toMatchObject({ state: 'failed', importId: 41, notes: ['Stop the service first'] });
    r = receipt();
    await importVolumes(plan([svc()]), { blog: 'x' }, deps(panel({ wait: vi.fn(async () => row({ status: 'failed', error: 'tar: secret-file.txt: corrupt' })) as never }), r).d);
    expect(r.items['volume:blog']).toMatchObject({ state: 'failed', notes: ['Volume import #41 ended failed. Details: the service\'s volume imports on the panel.'] });
    expect(JSON.stringify(r)).not.toContain('secret-file');
    r = receipt();
    await importVolumes(plan([svc()]), { blog: 'x' }, deps(panel({ importFile: vi.fn(async () => { throw 'plain'; }) as never }), r).d);
    expect(r.items['volume:blog']!.notes).toEqual(['plain']);
  });
});
