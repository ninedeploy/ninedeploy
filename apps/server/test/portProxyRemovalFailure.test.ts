import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ config: { paths: { dataDir: '' } }, capture: vi.fn(), run: vi.fn(), pull: vi.fn(), containers: new Map<string, string>() }));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/lib/exec.js', () => ({ capture: h.capture, run: h.run }));
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: h.pull }));
vi.mock('../src/lib/hostPath.js', () => ({ hostPathFor: async (p: string) => p }));
const proxy = await import('../src/lib/portProxy.js');
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
 h.containers.clear(); h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => { const fp = h.containers.get(args[1]!); if (fp === undefined) throw new Error(`\`docker ${args.join(" ")}\` exited 1: Error: No such object: ${args[1]}`); return `true ${fp}`; });
 h.run.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
  if (args[0] === 'rm') h.containers.delete(args.at(-1)!);
  if (args[0] === 'run') { const name = args[args.indexOf('--name') + 1]!; const prefix = `${proxy.PORT_PROXY_CONFIG_LABEL}=`; const label = args.find(arg => arg.startsWith(prefix))!; h.containers.set(name, label.slice(prefix.length)); }
 });
 h.pull.mockReset().mockResolvedValue(undefined); ownedDir();
});
afterEach(() => {
 if (path.resolve(h.config.paths.dataDir) !== ownedRoot || !ownedRoot.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(ownedRoot).startsWith('nd-audit-portproxy-')) throw new Error('Refusing unowned recursive disposal');
 rmSync(ownedRoot, { recursive: true, force: true }); vi.restoreAllMocks();
});


import { afterAll } from 'vitest';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
for (const kind of ['error', 'timeout', 'opaque'] as const) it(`preserves ${kind} removal failure and exact live config bytes`, async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const file = path.join(ownedDir(), 'dynamic/routes.yml'); const before = readFileSync(file, 'utf8');
 const failure = kind === 'opaque' ? 'controlled opaque failure' : Object.assign(new Error('controlled rm failure'), { name: kind === 'timeout' ? 'ExecTimeoutError' : 'Error' });
 h.run.mockRejectedValueOnce(failure); const log = vi.fn(); await expect(proxy.removePortProxy('db', log)).rejects.toBe(failure);
 expect(readFileSync(file, 'utf8')).toBe(before); expect(h.containers.size).toBe(1); expect(log).not.toHaveBeenCalled();
});
it('successful removal still removes config and reports once', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const log = vi.fn(); await proxy.removePortProxy('db', log); expect(h.containers.size).toBe(0); expect(existsSync(ownedDir())).toBe(false); expect(log).toHaveBeenCalledOnce();
});
it('existing modeled absence remains idempotent', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); h.containers.clear(); await proxy.removePortProxy('db'); await proxy.removePortProxy('db'); expect(existsSync(ownedDir())).toBe(false);
});
it('a failed gated removal releases the queued successful retry', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const entered = gate(), blocked = gate(); const failure = new Error('first remove failed'); const run = h.run.getMockImplementation()!; let used = false;
 h.run.mockImplementation(async (_cmd: string, args: string[]) => { if (!used && args[0] === 'rm') { used = true; entered.release(); await blocked.promise; throw failure; } return run(_cmd, args); });
 const first = proxy.removePortProxy('db'); const observed = first.then(() => null, err => err); let retry: Promise<void> | undefined;
 try {
  await entered.promise; retry = proxy.removePortProxy('db'); await checkpoint(); expect(existsSync(ownedDir())).toBe(true); blocked.release(); expect(await observed).toBe(failure); await retry; expect(h.containers.size).toBe(0); expect(existsSync(ownedDir())).toBe(false);
 } finally { blocked.release(); await Promise.allSettled([observed, ...(retry ? [retry] : [])]); }
});
it('a newer queued sync can keep the sidecar and replace routes after failed removal', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const entered = gate(), blocked = gate(); const failure = new Error('controlled remove failure');
 h.run.mockImplementationOnce(async () => { entered.release(); await blocked.promise; throw failure; }); const first = proxy.removePortProxy('db'); const observed = first.then(() => null, err => err); let latest: Promise<void> | undefined;
 try {
  await entered.promise; latest = proxy.syncPortProxy(service, ['new'], () => {}); blocked.release(); expect(await observed).toBe(failure); await latest; expect(h.containers.size).toBe(1); expect(readFileSync(path.join(ownedDir(), 'dynamic/routes.yml'), 'utf8')).toContain('new:5432');
 } finally { blocked.release(); await Promise.allSettled([observed, ...(latest ? [latest] : [])]); }
});
it('another slug can remove while this slug waits for a failing rm', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); ownedDir('other'); await proxy.syncPortProxy({ ...service, id: 4, slug: 'other' }, ['other'], () => {});
 const entered = gate(), blocked = gate(); const failure = new Error('db rm failed'); const run = h.run.getMockImplementation()!;
 h.run.mockImplementation(async (_cmd: string, args: string[]) => { if (args[0] === 'rm' && args.at(-1) === proxy.portProxyName('db')) { entered.release(); await blocked.promise; throw failure; } return run(_cmd, args); });
 const first = proxy.removePortProxy('db'); const observed = first.then(() => null, err => err);
 try {
  await entered.promise; await proxy.removePortProxy('other'); expect(h.containers.has(proxy.portProxyName('other'))).toBe(false); expect(existsSync(ownedDir('other'))).toBe(false); blocked.release(); expect(await observed).toBe(failure); expect(existsSync(ownedDir())).toBe(true);
 } finally { blocked.release(); await observed; }
});
it('repeated failed removes each surface the error without poisoning admission', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const failure = new Error('repeated rm failure'); h.run.mockRejectedValue(failure);
 const results = await Promise.allSettled([proxy.removePortProxy('db'), proxy.removePortProxy('db'), proxy.removePortProxy('db')]); expect(results.every(result => result.status === 'rejected' && result.reason === failure)).toBe(true); expect(h.containers.size).toBe(1); expect(existsSync(ownedDir())).toBe(true);
});

it('no-mapping sync propagates removal failure without deleting config', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const failure = new Error('no-mapping removal failed'); h.run.mockRejectedValueOnce(failure);
 await expect(proxy.syncPortProxy({ ...service, portMappings: [] }, [], () => {})).rejects.toBe(failure); expect(h.containers.size).toBe(1); expect(existsSync(ownedDir())).toBe(true);
});
