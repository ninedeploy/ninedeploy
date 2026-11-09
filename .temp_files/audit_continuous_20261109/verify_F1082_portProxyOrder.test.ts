import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ config: { paths: { dataDir: '' } }, capture: vi.fn(), run: vi.fn(), pull: vi.fn(), host: vi.fn(), containers: new Map<string, string>() }));
vi.mock('../../apps/server/src/config.js', () => ({ config: h.config }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: h.capture, run: h.run }));
vi.mock('../../apps/server/src/lib/dockerPull.js', () => ({ ensureDockerImage: h.pull }));
vi.mock('../../apps/server/src/lib/hostPath.js', () => ({ hostPathFor: h.host }));
const proxy = await import('../../apps/server/src/lib/portProxy.js');
const pg = { hostIp: null, hostPort: 5432, hostPortEnd: null, containerPort: 5432, protocol: 'tcp' as const, allowFrom: ['10.0.0.0/8'] };
const service = { id: 3, slug: 'db', portMappings: [pg] };
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
let ownedRoot = '';
function ownedDir(slug = 'db') {
 const dir = path.resolve(proxy.portProxyDir(slug));
 if (!dir.startsWith(path.resolve(ownedRoot) + path.sep)) throw new Error('Unowned config directory');
 return dir;
}
beforeEach(() => {
 ownedRoot = path.resolve(mkdtempSync(path.join(tmpdir(), 'nd-audit-portproxy-'))); h.config.paths.dataDir = ownedRoot;
 if (!ownedRoot.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(ownedRoot).startsWith('nd-audit-portproxy-')) throw new Error('Unowned temp root');
 h.containers.clear(); h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => { const fp = h.containers.get(args[1]!); if (fp === undefined) throw new Error('No such container'); return `true ${fp}`; });
 h.run.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
  if (args[0] === 'rm') h.containers.delete(args.at(-1)!);
  if (args[0] === 'run') { const name = args[args.indexOf('--name') + 1]!; const prefix = `${proxy.PORT_PROXY_CONFIG_LABEL}=`; const label = args.find(arg => arg.startsWith(prefix))!; h.containers.set(name, label.slice(prefix.length)); }
 });
 h.pull.mockReset().mockResolvedValue(undefined); h.host.mockReset().mockImplementation(async (p: string) => p); ownedDir();
});
afterEach(() => {
 if (path.resolve(h.config.paths.dataDir) !== ownedRoot || !ownedRoot.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(ownedRoot).startsWith('nd-audit-portproxy-')) throw new Error('Refusing unowned recursive disposal');
 rmSync(ownedRoot, { recursive: true, force: true }); vi.restoreAllMocks();
});

import { afterAll } from 'vitest';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
for (const where of ['inspect', 'pull', 'host', 'start'] as const) it(`same-slug remove waits through gated ${where} and leaves no sidecar`, async () => {
 const entered = gate(), blocked = gate();
 if (where === 'inspect') h.capture.mockImplementationOnce(async () => { entered.release(); await blocked.promise; throw new Error('No such container'); });
 if (where === 'pull') h.pull.mockImplementationOnce(async () => { entered.release(); await blocked.promise; });
 if (where === 'host') h.host.mockImplementationOnce(async (p: string) => { entered.release(); await blocked.promise; return p; });
 if (where === 'start') { const run = h.run.getMockImplementation()!; let used = false; h.run.mockImplementation(async (_cmd: string, args: string[]) => { if (!used && args[0] === 'run') { used = true; entered.release(); await blocked.promise; } return run(_cmd, args); }); }
 const first = proxy.syncPortProxy(service, ['db-1'], () => {}); let second: Promise<void> | undefined;
 try {
  await entered.promise; let removed = false; second = proxy.removePortProxy('db').then(() => { removed = true; }); await checkpoint(); expect(removed).toBe(false);
  blocked.release(); await Promise.all([first, second]); expect(h.containers.size).toBe(0); expect(existsSync(ownedDir())).toBe(false);
 } finally { blocked.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
});
it('sync/remove/new-sync preserves the newest requested configuration', async () => {
 const entered = gate(), blocked = gate(); h.pull.mockImplementationOnce(async () => { entered.release(); await blocked.promise; });
 const first = proxy.syncPortProxy(service, ['old'], () => {}); let remove: Promise<void> | undefined, latest: Promise<void> | undefined;
 try {
  await entered.promise; remove = proxy.removePortProxy('db'); const next = { ...service, portMappings: [{ ...pg, hostPort: 5433 }] }; latest = proxy.syncPortProxy(next, ['new'], () => {});
  blocked.release(); await Promise.all([first, remove, latest]); expect(h.containers.get(proxy.portProxyName('db'))).toBe(proxy.portProxyFingerprint(next.portMappings)); expect(readFileSync(path.join(ownedDir(), 'dynamic/routes.yml'), 'utf8')).toContain('new:5432');
 } finally { blocked.release(); await Promise.allSettled([first, ...(remove ? [remove] : []), ...(latest ? [latest] : [])]); }
});
it('different slug sync completes while another slug is held', async () => {
 const entered = gate(), blocked = gate(); h.pull.mockImplementationOnce(async () => { entered.release(); await blocked.promise; });
 const first = proxy.syncPortProxy(service, ['old'], () => {});
 try { await entered.promise; ownedDir('other'); await proxy.syncPortProxy({ ...service, id: 4, slug: 'other' }, ['other'], () => {}); expect(h.containers.has(proxy.portProxyName('other'))).toBe(true); expect(h.containers.has(proxy.portProxyName('db'))).toBe(false); } finally { blocked.release(); await first; }
});
it('removing through a no-restricted-mapping sync does not recursively deadlock', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); await proxy.syncPortProxy({ ...service, portMappings: [] }, [], () => {}); expect(h.containers.size).toBe(0); expect(existsSync(ownedDir())).toBe(false);
});
it('image failure releases the queue for remove and a later successful sync', async () => {
 h.pull.mockRejectedValueOnce(new Error('injected image failure')); const first = proxy.syncPortProxy(service, ['old'], () => {}); const observed = first.then(() => null, err => err);
 const remove = proxy.removePortProxy('db'); expect(await observed).toMatchObject({ message: 'injected image failure' }); await remove; expect(existsSync(ownedDir())).toBe(false);
 await proxy.syncPortProxy(service, ['new'], () => {}); expect(h.containers.size).toBe(1); expect(readFileSync(path.join(ownedDir(), 'dynamic/routes.yml'), 'utf8')).toContain('new:5432');
});
it('a later sync waits for an earlier gated removal then creates its fresh files', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const entered = gate(), blocked = gate(); const fp = h.containers.get(proxy.portProxyName('db'))!;
 h.capture.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return `true ${fp}`; });
 const remove = proxy.removePortProxy('db'); let latest: Promise<void> | undefined;
 try {
  await entered.promise; latest = proxy.syncPortProxy(service, ['new'], () => {}); await checkpoint(); expect(readFileSync(path.join(ownedDir(), 'dynamic/routes.yml'), 'utf8')).toContain('old:5432');
  blocked.release(); await Promise.all([remove, latest]); expect(h.containers.size).toBe(1); expect(readFileSync(path.join(ownedDir(), 'dynamic/routes.yml'), 'utf8')).toContain('new:5432');
 } finally { blocked.release(); await Promise.allSettled([remove, ...(latest ? [latest] : [])]); }
});
it('two same-fingerprint syncs keep newest routes without duplicate starts', async () => {
 const entered = gate(), blocked = gate(); h.pull.mockImplementationOnce(async () => { entered.release(); await blocked.promise; });
 const first = proxy.syncPortProxy(service, ['old'], () => {}); let latest: Promise<void> | undefined;
 try {
  await entered.promise; latest = proxy.syncPortProxy(service, ['new'], () => {}); blocked.release(); await Promise.all([first, latest]); expect(h.run.mock.calls.filter(call => call[1][0] === 'run')).toHaveLength(1); expect(readFileSync(path.join(ownedDir(), 'dynamic/routes.yml'), 'utf8')).toContain('new:5432');
 } finally { blocked.release(); await Promise.allSettled([first, ...(latest ? [latest] : [])]); }
});
it('repeated removes retain absent state', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); await Promise.all([proxy.removePortProxy('db'), proxy.removePortProxy('db'), proxy.removePortProxy('db')]); expect(h.containers.size).toBe(0); expect(existsSync(ownedDir())).toBe(false);
});
it('native config-write failure releases admission before cleanup and retry', async () => {
 const dir = ownedDir(); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'dynamic'), 'owned blocker');
 await expect(proxy.syncPortProxy(service, ['old'], () => {})).rejects.toThrow(); await proxy.removePortProxy('db'); await proxy.syncPortProxy(service, ['new'], () => {}); expect(h.containers.size).toBe(1); expect(readFileSync(path.join(dir, 'dynamic/routes.yml'), 'utf8')).toContain('new:5432');
});
