import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ config: { paths: { dataDir: '' } }, capture: vi.fn(), run: vi.fn(), pull: vi.fn(), containers: new Map<string, string>() }));
vi.mock('../../apps/server/src/config.js', () => ({ config: h.config }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: h.capture, run: h.run }));
vi.mock('../../apps/server/src/lib/dockerPull.js', () => ({ ensureDockerImage: h.pull }));
vi.mock('../../apps/server/src/lib/hostPath.js', () => ({ hostPathFor: async (p: string) => p }));
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
 h.containers.clear(); h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => { const fp = h.containers.get(args[1]!); if (fp === undefined) throw new Error("`docker " + args.join(" ") + "` exited 1: Error: No such object: " + args[1]); return `true ${fp}`; });
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
const inspectArgs = (name = 'nd-portproxy-db') => ['inspect', name, '--format', `{{.State.Running}} {{ index .Config.Labels "${proxy.PORT_PROXY_CONFIG_LABEL}" }}`];
const envelope = (diagnostic: string, code = 1) => new Error('`docker ' + inspectArgs().join(' ') + '` exited ' + code + ': ' + diagnostic);
for (const diagnostic of ['Error: No such object: nd-portproxy-db', 'Error: No such container: nd-portproxy-db', 'Error response from daemon: No such container: nd-portproxy-db']) for (const operation of ['remove', 'sync'] as const) it(`exact absence control ${operation}: ${diagnostic}`, async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); h.containers.clear(); h.capture.mockRejectedValueOnce(envelope(diagnostic)); h.run.mockClear();
 if (operation === 'remove') { await proxy.removePortProxy('db'); expect(existsSync(ownedDir())).toBe(false); expect(h.run).not.toHaveBeenCalled(); }
 else { await proxy.syncPortProxy(service, ['new'], () => {}); expect(h.containers.size).toBe(1); }
});
for (const [label, failure] of [
 ['permission', new Error('permission denied')], ['daemon', new Error('Cannot connect to the Docker daemon')], ['generic missing', new Error('No such container')],
 ['wrong target', envelope('Error: No such object: other')], ['additional diagnostic', envelope('Error: No such object: nd-portproxy-db\npermission denied')],
 ['wrong exit', envelope('Error: No such object: nd-portproxy-db', 125)], ['timeout', Object.assign(new Error('inspect timed out'), { name: 'ExecTimeoutError' })], ['opaque', { detail: 'unknown failure' }],
] as const) it(`unknown ${label} is not a removal absence receipt`, async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); h.capture.mockRejectedValueOnce(failure); h.run.mockClear(); await expect(proxy.removePortProxy('db')).rejects.toBe(failure); expect(h.run).not.toHaveBeenCalled(); expect(existsSync(ownedDir())).toBe(true); expect(h.containers.size).toBe(1);
});
for (const failure of [new Error('permission denied'), envelope('Error: No such object: other'), envelope('Error: No such object: nd-portproxy-db\nconnection failed')]) it(`sync refuses unconfirmed absence: ${failure.message}`, async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); h.capture.mockRejectedValueOnce(failure); h.run.mockClear(); h.pull.mockClear(); await expect(proxy.syncPortProxy({ ...service, portMappings: [{ ...pg, hostPort: 5433 }] }, ['new'], () => {})).rejects.toBe(failure); expect(h.run).not.toHaveBeenCalled(); expect(h.pull).not.toHaveBeenCalled(); expect(h.containers.size).toBe(1);
});
it('gated unknown inspection releases queued retry while preserving config until known removal', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); const entered = gate(), blocked = gate(); const failure = new Error('controlled inspect error');
 h.capture.mockImplementationOnce(async () => { entered.release(); await blocked.promise; throw failure; }); const first = proxy.removePortProxy('db'); const observed = first.then(() => null, err => err); let retry: Promise<void> | undefined;
 try { await entered.promise; retry = proxy.removePortProxy('db'); await checkpoint(); expect(existsSync(ownedDir())).toBe(true); blocked.release(); expect(await observed).toBe(failure); await retry; expect(h.containers.size).toBe(0); expect(existsSync(ownedDir())).toBe(false); } finally { blocked.release(); await Promise.allSettled([observed, ...(retry ? [retry] : [])]); }
});
it('actual native capture command envelope and fixed Docker label match the classifier contract', async () => {
 const actual = await vi.importActual<typeof import('../../apps/server/src/lib/exec.js')>('../../apps/server/src/lib/exec.js');
 const args = ['-e', "process.stderr.write('Error: No such object: fixture'); process.exit(1)"];
 await expect(actual.capture(process.execPath, args, { timeoutMs: 5000 })).rejects.toThrow('`' + actual.redactedLabel(process.execPath, args) + '` exited 1: Error: No such object: fixture');
 expect(actual.redactedLabel('docker', inspectArgs())).toBe(['docker', ...inspectArgs()].join(' '));
});
it('known same-fingerprint running sidecar keeps its instance', async () => {
 await proxy.syncPortProxy(service, ['old'], () => {}); h.run.mockClear(); await proxy.syncPortProxy(service, ['new'], () => {}); expect(h.run).not.toHaveBeenCalled(); expect(h.containers.size).toBe(1);
});
