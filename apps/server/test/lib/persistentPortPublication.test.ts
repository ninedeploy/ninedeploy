import { describe, expect, it } from 'vitest';
import { assertPersistentPortNftState, persistentPortFingerprint, type PersistentPortNftSpec } from '../../src/lib/persistentPortNft.js';
import { PersistentPortPublisher, PersistentPortPublicationPending, type PersistentPortAuthority, type PersistentPortJournal } from '../../src/lib/persistentPortPublication.js';

const first: PersistentPortNftSpec = { serviceId: 1, owner: 'a'.repeat(32), revision: 1, mark: 0x4e440001,
  target: { id: 'b'.repeat(64), ipv4: '172.29.0.2' }, bindings: [{ hostIp: '10.6.6.9', hostPort: 5060, protocol: 'udp', containerPort: 5060 }] };
const next: PersistentPortNftSpec = { ...first, revision: 2, target: { id: 'c'.repeat(64), ipv4: '172.29.0.3' } };
const marker = (spec: PersistentPortNftSpec) => `ninedeploy:${spec.owner}:${spec.revision}:${persistentPortFingerprint(spec)}`;

// Shape captured from real `nft -j list table`, with kernel handles omitted.
function snapshot(spec: PersistentPortNftSpec) {
  return { nftables: [
    { table: { family: 'ip', name: 'ndpi_s1', comment: marker(spec) } },
    ...['incoming', 'local'].flatMap(chain => [
      { chain: { family: 'ip', table: 'ndpi_s1', name: chain, type: 'nat', hook: chain === 'incoming' ? 'prerouting' : 'output', prio: -101, policy: 'accept' } },
      { rule: { family: 'ip', table: 'ndpi_s1', chain, expr: [
        { match: { left: { payload: { field: 'daddr', protocol: 'ip' } }, op: '==', right: '10.6.6.9' } },
        { match: { left: { payload: { field: 'dport', protocol: 'udp' } }, op: '==', right: 5060 } },
        { mangle: { key: { ct: { key: 'mark' } }, value: 0x4e440001 } },
        { dnat: { addr: spec.target.ipv4, port: 5060 } },
      ] } },
    ]),
  ] };
}

function host() {
  let journal: PersistentPortJournal | null = null, kernel: unknown | null = null, failWeb = false, ready = true, drained = false, lostKernelAck = false;
  const events: string[] = [];
  let queue = Promise.resolve();
  const authority: PersistentPortAuthority = {
    exclusive: async operation => {
      const previous = queue; let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous; try { return await operation(); } finally { release(); }
    },
    readJournal: async () => structuredClone(journal),
    saveJournal: async state => { journal = structuredClone(state); events.push(state.pending ? 'intent' : 'commit'); },
    installed: async () => kernel,
    ready: async () => { if (!ready) throw new Error('unready'); },
    prepare: async () => { events.push('forward'); },
    publish: async spec => { kernel = snapshot(spec); events.push('kernel'); if (lostKernelAck) throw new Error('lost kernel ACK'); },
    confirmWeb: async () => { events.push('web'); if (failWeb) throw new Error('lost Traefik ACK'); },
    drained: async () => drained,
    retire: async target => { events.push('retire:' + target.id); },
  };
  return { authority, events, state: () => structuredClone(journal), foreign: () => { kernel = 'foreign'; }, unready: () => { ready = false; }, failWeb: () => { failWeb = true; }, allowWeb: () => { failWeb = false; }, drain: () => { drained = true; }, loseKernelAck: () => { lostKernelAck = true; } };
}

describe('persistent port publication authority', () => {
  it.each([
    ['destination', '172.29.0.2', '172.29.0.9'],
    ['port', '"right":5060', '"right":5061'],
    ['hook priority', '"prio":-101', '"prio":0'],
    ['connection mark', '"value":1313079297', '"value":1'],
    ['disabled table', '"name":"ndpi_s1"', '"name":"ndpi_s1","flags":["dormant"]'],
  ])('rejects a changed %s even when the ownership marker is unchanged', (_name, from, to) => {
    const actual = JSON.parse(JSON.stringify(snapshot(first)).replace(from, to));
    expect(() => assertPersistentPortNftState(first, actual)).toThrow('differs');
  });
  it('captures publication inputs before awaiting external readiness', async () => {
    const h = host(); const desired = structuredClone(first);
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    h.authority.ready = async () => { entered(); await gate; };
    const pending = new PersistentPortPublisher(h.authority).promote(desired);
    await waiting;
    desired.target.id = 'd'.repeat(64); desired.target.ipv4 = '172.29.0.9';
    resume(); await pending;
    expect(h.state()?.committed?.target).toEqual(first.target);
  });
  it('journals intent before either routing plane and commits only after both acknowledgements', async () => {
    const h = host(); await new PersistentPortPublisher(h.authority).promote(first);
    expect(h.events).toEqual(['intent', 'forward', 'kernel', 'web', 'commit']);
    expect(h.state()).toMatchObject({ committed: first, pending: null, retained: [first.target] });
  });
  it('rejects an unready candidate before creating intent or changing networking', async () => {
    const h = host(); h.unready();
    await expect(new PersistentPortPublisher(h.authority).promote(first)).rejects.toThrow('unready');
    expect(h.events).toEqual([]);
  });
  it('never takes over a foreign kernel table', async () => {
    const h = host(); h.foreign();
    await expect(new PersistentPortPublisher(h.authority).promote(first)).rejects.toThrow('ownership');
    expect(h.events).toEqual([]);
  });
  it('retains both generations after lost web acknowledgement and recovers after publisher restart', async () => {
    const h = host(); const publisher = new PersistentPortPublisher(h.authority); await publisher.promote(first); h.failWeb();
    await expect(publisher.promote(next)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
    expect(h.state()).toMatchObject({ committed: first, pending: next, retained: [first.target, next.target] });
    await expect(publisher.retireDrained(next, first.target.id)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
    expect(h.events.filter(x => x.startsWith('retire:'))).toEqual([]);
    h.allowWeb(); const recovered = await new PersistentPortPublisher(h.authority).recover(next);
    expect(recovered).toMatchObject({ committed: next, pending: null });
    expect(h.events.filter(x => x === 'kernel')).toHaveLength(2);
  });
  it('recognizes a kernel commit with a lost acknowledgement without replaying it', async () => {
    const h = host(); h.loseKernelAck(); const p = new PersistentPortPublisher(h.authority);
    await expect(p.promote(first)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
    await new PersistentPortPublisher(h.authority).recover(first);
    expect(h.events.filter(x => x === 'kernel')).toHaveLength(1);
  });
  it('recovers durable intent when its acknowledgement failed before kernel publication', async () => {
    const h = host(); const save = h.authority.saveJournal;
    h.authority.saveJournal = async state => { await save(state); if (state.pending) throw new Error('lost intent ACK'); };
    await expect(new PersistentPortPublisher(h.authority).promote(first)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
    expect(h.events).toEqual(['intent']);
    h.authority.saveJournal = save;
    expect((await new PersistentPortPublisher(h.authority).recover(first)).committed).toEqual(first);
  });
  it('does not overwrite unknown kernel state while recovering an unresolved handoff', async () => {
    const h = host(); const p = new PersistentPortPublisher(h.authority); await p.promote(first); h.failWeb();
    await expect(p.promote(next)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
    h.foreign(); h.allowWeb(); const before = [...h.events];
    await expect(new PersistentPortPublisher(h.authority).recover(next)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
    expect(h.events).toEqual(before); expect(h.state()?.retained).toEqual([first.target, next.target]);
  });
  it('refuses a fourth retained generation instead of forcing active runtimes to stop', async () => {
    const h = host(); const p = new PersistentPortPublisher(h.authority); await p.promote(first); await p.promote(next);
    await p.promote({ ...first, revision: 3, target: { id: 'd'.repeat(64), ipv4: '172.29.0.4' } });
    const before = [...h.events];
    await expect(p.promote({ ...first, revision: 4, target: { id: 'e'.repeat(64), ipv4: '172.29.0.5' } })).rejects.toThrow('must drain');
    expect(h.events).toEqual(before); expect(h.state()?.retained).toHaveLength(3);
  });
  it('recovers an already committed journal after its acknowledgement was lost', async () => {
    const h = host(); const p = new PersistentPortPublisher(h.authority); await p.promote(first);
    const save = h.authority.saveJournal;
    h.authority.saveJournal = async state => { await save(state); if (!state.pending) throw new Error('lost journal ACK'); };
    await expect(p.promote(next)).rejects.toBeInstanceOf(PersistentPortPublicationPending);
    expect(h.state()?.pending).toBe(null);
    const result = await new PersistentPortPublisher(h.authority).recover(next);
    expect(result.committed).toEqual(next);
  });
  it('rechecks routing after asynchronous drain observation before retiring a runtime', async () => {
    const h = host(); const p = new PersistentPortPublisher(h.authority); await p.promote(first); await p.promote(next);
    h.authority.drained = async () => { h.foreign(); return true; };
    await expect(p.retireDrained(next, first.target.id)).rejects.toThrow('ownership');
    expect(h.events.filter(x => x.startsWith('retire:'))).toEqual([]);
  });
  it('rejects stale publishers and a changed binding claim without side effects', async () => {
    const h = host(); const p = new PersistentPortPublisher(h.authority); await p.promote(first); const before = [...h.events];
    await expect(p.promote(first)).rejects.toThrow('Stale');
    await expect(p.promote({ ...next, bindings: [{ ...first.bindings[0]!, hostPort: 5061 }] })).rejects.toThrow('claim changed');
    expect(h.events).toEqual(before);
  });
  it('serializes competing publishers so only one can claim a revision', async () => {
    const h = host(); const p = new PersistentPortPublisher(h.authority);
    const results = await Promise.allSettled([p.promote(first), p.promote(first)]);
    expect(results.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(h.events.filter(x => x === 'kernel')).toHaveLength(1);
  });
  it('holds an active old flow and never retires the current target', async () => {
    const h = host(); const p = new PersistentPortPublisher(h.authority); await p.promote(first); await p.promote(next);
    expect(await p.retireDrained(next, first.target.id)).toBe(false);
    h.drain(); expect(await p.retireDrained(next, first.target.id)).toBe(true);
    expect(h.state()?.retained).toEqual([next.target]);
    await expect(p.retireDrained(next, next.target.id)).rejects.toThrow('serving runtime');
  });
});
