import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistentPortFingerprint, type PersistentPortNftSpec } from '../../src/lib/persistentPortNft.js';
import { PersistentPortPublicationPending } from '../../src/lib/persistentPortPublication.js';
import { confirmPersistentPortWebPublication, runPersistentPortHostWorker, type PersistentPortWebChallenge, type PersistentPortWebConfirmer, type PersistentPortWorkerRuntime } from '../../src/lib/persistentPortHostWorker.js';
const first: PersistentPortNftSpec = { serviceId: 1, owner: 'a'.repeat(32), revision: 1, mark: 0x4e440001, target: { id: 'b'.repeat(64), ipv4: '172.29.0.2' }, bindings: [{ hostIp: '10.6.6.9', hostPort: 5060, protocol: 'udp', containerPort: 5060 }] };
const next = { ...first, revision: 2, target: { id: 'c'.repeat(64), ipv4: '172.29.0.3' } };
const acknowledge = async (challenge: PersistentPortWebChallenge) => ({ ...challenge, loaded: true });
describe('persistent port web acknowledgement', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('accepts only the exact loaded publication and releases its timeout', async () => {
    vi.useFakeTimers(); await expect(confirmPersistentPortWebPublication(first, acknowledge)).resolves.toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['token', 'serviceId', 'owner', 'revision', 'targetId', 'fingerprint', 'version', 'loaded'])('refuses a mismatched %s acknowledgement', async key => {
    await expect(confirmPersistentPortWebPublication(first, async challenge => ({ ...challenge, loaded: true, [key]: 'wrong' }))).rejects.toThrow('does not match');
  });
  it('refuses an acknowledgement replay even for the same target and revision', async () => {
    let previous: unknown; await confirmPersistentPortWebPublication(first, async challenge => { previous = { ...challenge, loaded: true }; return previous; });
    await expect(confirmPersistentPortWebPublication(first, async () => previous)).rejects.toThrow('does not match');
  });
  it('refuses additional fields and inherited acknowledgements', async () => {
    await expect(confirmPersistentPortWebPublication(first, async challenge => ({ ...challenge, loaded: true, extra: true }))).rejects.toThrow('does not match');
    await expect(confirmPersistentPortWebPublication(first, async challenge => Object.assign(Object.create({ loaded: true }), challenge, { extra: true }))).rejects.toThrow('does not match');
  });
  it('captures the publication before awaiting the coordinator', async () => {
    const input = structuredClone(first); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = confirmPersistentPortWebPublication(input, async challenge => { await gate; expect(challenge.fingerprint).toBe(persistentPortFingerprint(first)); expect(challenge.targetId).toBe(first.target.id); return acknowledge(challenge); });
    input.target.id = next.target.id; input.revision = 99; release(); await pending;
  });
  it('aborts a hung coordinator on timeout and ignores its late response', async () => {
    vi.useFakeTimers(); let received!: AbortSignal, late!: (value: unknown) => void, captured!: PersistentPortWebChallenge;
    const pending = confirmPersistentPortWebPublication(first, (challenge, signal) => { received = signal; captured = challenge; return new Promise(resolve => { late = resolve; }); }, { timeoutMs: 50 });
    const rejected = expect(pending).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(50); await rejected;
    expect(received.aborted).toBe(true); late({ ...captured, loaded: true }); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a disconnected controller without forwarding its abort reason', async () => {
    const controller = new AbortController(); let received!: AbortSignal;
    const pending = confirmPersistentPortWebPublication(first, async (_challenge, signal) => { received = signal; return new Promise(() => {}); }, { signal: controller.signal });
    await Promise.resolve(); const rejected = expect(pending).rejects.toThrow('control channel closed'); controller.abort('sensitive-fixture-reason'); await rejected; expect(received.aborted).toBe(true);
  });
  it('does not invoke the coordinator for an already canceled request or invalid deadline', async () => {
    const confirm = vi.fn(acknowledge), controller = new AbortController(); controller.abort();
    await expect(confirmPersistentPortWebPublication(first, confirm, { signal: controller.signal })).rejects.toThrow('control channel closed');
    await expect(confirmPersistentPortWebPublication(first, confirm, { timeoutMs: 0 })).rejects.toThrow('deadline'); expect(confirm).not.toHaveBeenCalled();
  });
});
// External nft JSON is the mocked OS boundary; publisher and journal store are real.
const snapshot = (spec: PersistentPortNftSpec) => ({ nftables: [
  { table: { family: 'ip', name: 'ndpi_s1', comment: `ninedeploy:${spec.owner}:${spec.revision}:${persistentPortFingerprint(spec)}` } },
  ...['incoming', 'local'].flatMap(chain => [
    { chain: { family: 'ip', table: 'ndpi_s1', name: chain, type: 'nat', hook: chain === 'incoming' ? 'prerouting' : 'output', prio: -101, policy: 'accept' } },
    { rule: { family: 'ip', table: 'ndpi_s1', chain, expr: [
      { match: { left: { payload: { field: 'daddr', protocol: 'ip' } }, op: '==', right: '10.6.6.9' } },
      { match: { left: { payload: { field: 'dport', protocol: 'udp' } }, op: '==', right: 5060 } },
      { mangle: { key: { ct: { key: 'mark' } }, value: 0x4e440001 } }, { dnat: { addr: spec.target.ipv4, port: 5060 } },
    ] } },
  ]),
] });
describe('target-host publication worker', () => {
  if (process.platform !== 'linux') {
    it('refuses unsupported hosts before accessing a journal or invoking runtime callbacks', async () => {
      await expect(runPersistentPortHostWorker({ directory: 'must-not-create', request: { version: 1, kind: 'inspect', spec: first }, runtime: {} as PersistentPortWorkerRuntime, confirmWeb: acknowledge })).rejects.toThrow('requires Linux');
    });
  } else {
    const directories: string[] = [];
    afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(`${resolve(tmpdir())}/nd-port-worker-`)) throw new Error('Unsafe worker fixture cleanup'); rmSync(path, { recursive: true, force: true }); } });
    const host = () => {
      const directory = mkdtempSync(join(tmpdir(), 'nd-port-worker-')); directories.push(directory); let kernel: unknown | null = null; const events: string[] = [];
      const journal = () => JSON.parse(readFileSync(join(directory, 'service-1.json'), 'utf8'));
      const runtime: PersistentPortWorkerRuntime = {
        installed: async () => kernel, ready: async () => { events.push('ready'); }, prepare: async () => { events.push('prepare'); },
        publish: async (context, spec) => { expect(journal().pending.revision).toBe(spec.revision); expect(() => context.run('flock', ['--nonblock', join(directory, 'authority.lock'), 'true'])).toThrow('did not complete'); events.push('kernel'); kernel = snapshot(spec); },
        drained: async () => false, retire: async () => { throw new Error('Must not retire an active target'); },
      };
      const run = (kind: 'promote' | 'recover' | 'rollback' | 'inspect', spec = first, confirmWeb: PersistentPortWebConfirmer = acknowledge, signal?: AbortSignal) => runPersistentPortHostWorker({ directory, request: { version: 1, kind, spec }, runtime, confirmWeb, signal });
      return { directory, runtime, run, journal, events };
    };
    it('holds real OS authority across durable intent, kernel operation and exact web acknowledgement', async () => {
      const h = host(); const result = await h.run('promote', first, async challenge => { expect(h.journal().pending.revision).toBe(1); h.events.push('web'); return acknowledge(challenge); });
      expect(h.events).toEqual(['ready', 'ready', 'prepare', 'kernel', 'web']); expect(result.journal?.committed).toEqual(first); expect(h.journal().pending).toBeNull();
    });
    it('retains both generations after a stale web ACK and reconstructs through a fresh worker', async () => {
      const h = host(); await h.run('promote');
      await expect(h.run('promote', next, async challenge => ({ ...challenge, loaded: true, revision: 1 }))).rejects.toBeInstanceOf(PersistentPortPublicationPending);
      expect(h.journal().pending.revision).toBe(2); expect(h.journal().retained).toHaveLength(2); expect(h.journal().committed.target).toEqual(first.target);
      expect((await h.run('recover', next)).journal?.committed).toEqual(next);
    });
    it('retains durable intent on channel loss after kernel publication', async () => {
      const h = host(); await h.run('promote'); const controller = new AbortController();
      await expect(h.run('promote', next, async () => { controller.abort(); return {}; }, controller.signal)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
      expect(h.journal().pending.revision).toBe(2); expect(h.journal().retained).toHaveLength(2); expect(h.journal().committed.target.id).toBe(first.target.id);
      expect((await h.run('inspect')).journal?.pending).toEqual(next);
    });
    it('does not mutate kernel state when cancellation arrives during readiness', async () => {
      const h = host(), controller = new AbortController(); h.runtime.ready = async () => { controller.abort(); };
      await expect(h.run('promote', first, acknowledge, controller.signal)).rejects.toThrow('control channel closed'); expect(h.events).toEqual([]); expect((await h.run('inspect')).journal).toBeNull();
    });
    it('refuses malformed action/target requests before creating authority state', async () => {
      const h = host(); await expect(runPersistentPortHostWorker({ directory: h.directory, request: { version: 1, kind: 'retire', spec: first, targetId: 'unsafe' }, runtime: h.runtime, confirmWeb: acknowledge })).rejects.toThrow('Invalid'); expect(h.events).toEqual([]);
    });
  }
});
