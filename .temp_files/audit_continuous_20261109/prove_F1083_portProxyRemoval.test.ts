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
 h.containers.clear(); h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => { const fp = h.containers.get(args[1]!); if (fp === undefined) throw new Error('No such container'); return `true ${fp}`; });
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

it('control: successful removal cleans owned sidecar/config and reports removal', async () => {
 await proxy.syncPortProxy(service, ['db-1'], () => {}); const log = vi.fn(); await proxy.removePortProxy('db', log); expect(h.containers.size).toBe(0); expect(existsSync(ownedDir())).toBe(false); expect(log).toHaveBeenCalledWith('Removed port proxy nd-portproxy-db');
});
for (const viaSync of [false, true]) it(`Docker rm failure propagates and preserves live config (no-mapping sync=${viaSync})`, async () => {
 await proxy.syncPortProxy(service, ['db-1'], () => {}); const failure = new Error('injected docker removal failure'); const run = h.run.getMockImplementation()!;
 h.run.mockImplementation(async (_cmd: string, args: string[]) => { if (args[0] === 'rm') throw failure; return run(_cmd, args); });
 const log = vi.fn(); let actualError: unknown = null;
 try { if (viaSync) await proxy.syncPortProxy({ ...service, portMappings: [] }, [], log); else await proxy.removePortProxy('db', log); } catch (err) { actualError = err; }
 const actual = { sameError: actualError === failure, sidecars: h.containers.size, config: existsSync(ownedDir()), logs: log.mock.calls.length };
 console.log('EXPECTED: removal error/live sidecar/config/no success log; ACTUAL:', actual); console.log(actual.sameError && actual.config ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(actual).toEqual({ sameError: true, sidecars: 1, config: true, logs: 0 });
});
