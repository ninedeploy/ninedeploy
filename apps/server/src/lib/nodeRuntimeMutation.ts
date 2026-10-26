import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { containerInventoryRequest, containerInventoryReply, containerStopSetRequest, containerStopSetReply, type ContainerInventoryReply, type ContainerStopSetReply, containerLifecycleRequest, containerPrepareReply, containerPrepareRequest, containerRetireSetReply, containerRetireSetRequest,
  runtimeFenceReply, runtimeFenceRequest, containerNetworkSetRequest, containerNetworkSetReply, type ContainerNetworkSetReply, type ContainerPrepareReply, type ContainerRetireSetReply, type RuntimeFenceReply } from '@ninedeploy/schemas';
import { parseRunSpec, runSpecArgv, type RunSpec } from '../agentOps/runSpec.js';
import { assertFileMountsWritten } from '../agentOps/fileMounts.js';
import { withNodeServiceJournal, type NodeServiceJournal } from './nodeLifecycle.js';
import { spawnValidated } from './spawnValidated.js';

const MODE_SCHEMA = 'CREATE TABLE IF NOT EXISTS runtime_protocol (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)';
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}},"nonce":{{json (index .Config.Labels "ninedeploy.mutation")}},"specHash":{{json (index .Config.Labels "ninedeploy.spec")}},"status":{{json .State.Status}},"running":{{json .State.Running}},"networks":{{json .NetworkSettings.Networks}}}';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const labelOrder = ([a]: [string, string], [b]: [string, string]) => a < b ? -1 : a > b ? 1 : 0;

type Header = { requestId: string; serviceId: number; revision: number };
type DockerRow = { id: string; name: string; managed: string | null; serviceId: string | null; deploymentId: string | null;
  nonce: string | null; specHash: string | null; status: string; running: boolean; networks: Record<string, unknown> };

function head(journal: NodeServiceJournal) {
  const row = journal.database.prepare('SELECT revision,request_hash,intent,receipt FROM lifecycle_head WHERE id=1').get();
  if (row && (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || typeof row.request_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.request_hash))) throw new Error('Invalid runtime journal; retained for review');
  return row;
}
async function claim(journal: NodeServiceJournal, input: Header, intent: object, legacyFence = false) {
  const payload = JSON.stringify(intent), hash = digest(payload);
  let compatible = false;
  await journal.write(async () => {
    journal.database.exec(MODE_SCHEMA);
    const mode = journal.database.prepare('SELECT version FROM runtime_protocol WHERE id=1').get();
    if (mode && mode.version !== 1) throw new Error('Unsupported runtime journal protocol; retained for review');
    const previous = head(journal);
    if (previous && Number(previous.revision) > input.revision) throw new Error('Runtime request is stale; superseded by a newer command');
    if (previous && Number(previous.revision) === input.revision && previous.request_hash !== hash) {
      const parsed = legacyFence ? containerLifecycleRequest.safeParse({ ...JSON.parse(String(previous.intent)), timeoutMs: 1 }) : null;
      compatible = !!parsed?.success && parsed.data.serviceId === input.serviceId && parsed.data.requestId === input.requestId &&
        parsed.data.revision === input.revision && parsed.data.action === 'stop' && parsed.data.targets.length === 0;
      if (!compatible) throw new Error('Runtime revision conflicts with a different intent');
    }
    if (!previous || Number(previous.revision) < input.revision) journal.database.prepare(
      'INSERT INTO lifecycle_head(id,revision,request_hash,intent,receipt) VALUES(1,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,request_hash=excluded.request_hash,intent=excluded.intent,receipt=NULL',
    ).run(input.revision, hash, payload);
    journal.database.prepare('INSERT INTO runtime_protocol(id,version) VALUES(1,1) ON CONFLICT(id) DO NOTHING').run();
  });
  return { hash, compatible };
}
async function effect<Reply extends Header & { complete: true }>(journal: NodeServiceJournal, input: Header, hash: string, parse: (value: unknown) => Reply, run: () => Promise<Reply>): Promise<Reply> {
  return journal.write(async () => {
    const current = head(journal);
    if (!current || Number(current.revision) !== input.revision || current.request_hash !== hash) throw new Error('Runtime request is stale; superseded by a newer command');
    const bound = (value: unknown) => {
      const receipt = parse(value);
      if (receipt.requestId !== input.requestId || receipt.serviceId !== input.serviceId || receipt.revision !== input.revision) throw new Error('Runtime receipt ownership changed; retained for review');
      return receipt;
    };
    if (current.receipt !== null) return bound(JSON.parse(String(current.receipt)));
    const receipt = bound(await run());
    journal.database.prepare('UPDATE lifecycle_head SET receipt=? WHERE id=1 AND revision=? AND request_hash=?').run(JSON.stringify(receipt), input.revision, hash);
    return receipt;
  });
}
function dockerIO(journal: NodeServiceJournal, onLine: (line: string) => void) {
  const call = async (args: string[], sink = onLine) => { journal.current(); const code = await spawnValidated('docker', args, sink, { timeoutMs: journal.remaining() }); journal.current(); return code; };
  const inspect = async (reference: string): Promise<DockerRow | null> => {
    const lines: string[] = []; let bytes = 0;
    const code = await call(['inspect', '--type', 'container', '--format', INSPECT, reference], line => { bytes += Buffer.byteLength(line); if (bytes <= 65_536) lines.push(line); });
    if (bytes > 65_536) throw new Error('Runtime identity inspection exceeded its limit');
    if (code !== 0) {
      if (lines.length > 0 && lines.every(line => /No such (object|container)/i.test(line))) return null;
      throw new Error('Runtime identity inspection unavailable');
    }
    if (lines.length !== 1) throw new Error('Runtime identity inspection unavailable');
    const row = JSON.parse(lines[0]!) as DockerRow;
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) ||
      typeof row.name !== 'string' || typeof row.running !== 'boolean' || !['created', 'running', 'exited', 'dead', 'paused', 'restarting'].includes(row.status) ||
      !row.networks || typeof row.networks !== 'object' || Array.isArray(row.networks)) throw new Error('Runtime identity or state is unconfirmed');
    row.name = row.name.replace(/^\//, '');
    if (/^[a-f0-9]{64}$/.test(reference) ? row.id !== reference : row.name !== reference) throw new Error('Runtime identity changed');
    return row;
  };
  return { call, inspect };
}
function owned(row: DockerRow, serviceId: number, target: { id?: string; name: string; deploymentId: number }) {
  if (target.id !== undefined && row.id !== target.id || row.name !== target.name || row.managed !== 'service' ||
    row.serviceId !== String(serviceId) || row.deploymentId !== String(target.deploymentId)) throw new Error('Runtime ownership or generation changed');
}
function envDigest(spec: RunSpec) {
  if (spec.envFile === null) return null;
  const file = resolve(spec.envFile);
  if (lstatSync(resolve('.agent-env')).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new Error('Invalid managed environment path');
  if (lstatSync(file).size > 1_048_576 || !lstatSync(file).isFile()) throw new Error('Invalid managed environment file');
  return digest(readFileSync(file));
}

export function createNodeRuntimeMutation(root: string) {
  const directory = resolve(root);
  return {
    async fence(params: unknown): Promise<RuntimeFenceReply> {
      const input = runtimeFenceRequest.parse(params);
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, async journal => {
        const { timeoutMs: _timeout, ...identity } = input;
        const admitted = await claim(journal, input, { kind: 'fence', ...identity }, true);
        if (admitted.compatible) return runtimeFenceReply.parse({ ...identity, complete: true });
        return effect(journal, input, admitted.hash, value => runtimeFenceReply.parse(value), async () => ({ ...identity, complete: true }));
      });
    },
    async inventory(params: unknown): Promise<ContainerInventoryReply> {
      const input = containerInventoryRequest.parse(params);
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, journal => journal.write(async () => {
        const recorded = head(journal);
        if (!recorded || Number(recorded.revision) !== input.revision || digest(String(recorded.intent)) !== recorded.request_hash) throw new Error('Runtime inventory fence is stale or unconfirmed');
        const intent = JSON.parse(String(recorded.intent)) as Record<string, unknown>;
        const { kind, ...stored } = intent;
        const modern = kind === 'fence' && runtimeFenceRequest.safeParse({ ...stored, timeoutMs: 1 }).success;
        const legacy = containerLifecycleRequest.safeParse({ ...intent, timeoutMs: 1 });
        if ((!modern && !(legacy.success && legacy.data.action === 'stop' && legacy.data.targets.length === 0)) ||
          intent.requestId !== input.requestId || intent.serviceId !== input.serviceId || intent.revision !== input.revision) throw new Error("Runtime inventory requires this command's completed fence");
        const adopted = journal.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_protocol'").get();
        const mode = adopted ? journal.database.prepare("SELECT version FROM runtime_protocol WHERE id=1").get() : undefined;
        if (mode?.version !== 1) throw new Error('Runtime inventory protocol is unconfirmed');
        const io = dockerIO(journal, () => {}), listed: string[] = []; let bytes = 0;
        const code = await io.call(['ps', '--all', '--no-trunc', '--filter', 'label=ninedeploy.managed=service', '--filter', 'label=ninedeploy.service=' + input.serviceId, '--format', '{{.ID}}'], line => {
          bytes += Buffer.byteLength(line); if (bytes <= 65_536) listed.push(...line.split(/\s+/).filter(Boolean));
        });
        if (code !== 0 || bytes > 65_536 || listed.length > 30 || new Set(listed).size !== listed.length || listed.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Managed runtime inventory is incomplete');
        const items: ContainerInventoryReply['items'] = [];
        const capture = (row: DockerRow) => {
          const deploymentId = Number(row.deploymentId);
          if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) throw new Error('Managed inventory generation is unconfirmed');
          owned(row, input.serviceId, { name: row.name, deploymentId });
          if (!items.some(item => item.id === row.id)) items.push({ id: row.id, name: row.name, deploymentId, running: row.running });
        };
        for (const id of listed) { const row = await io.inspect(id); if (row) capture(row); }
        for (const name of input.expectedNames ?? []) { const row = await io.inspect(name); if (row) capture(row); }
        return containerInventoryReply.parse({ requestId: input.requestId, serviceId: input.serviceId, revision: input.revision, complete: true,
          items: items.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
      }));
    },
    async stop(params: unknown, onLine: (line: string) => void = () => {}): Promise<ContainerStopSetReply> {
      const input = containerStopSetRequest.parse(params), { timeoutMs: _timeout, ...intent } = input;
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, async journal => {
        const admitted = await claim(journal, input, { kind: 'stop', ...intent });
        return effect(journal, input, admitted.hash, value => containerStopSetReply.parse(value), async () => {
          const io = dockerIO(journal, onLine), running: string[] = [];
          for (const target of input.targets) { const row = await io.inspect(target.id); if (row) { owned(row, input.serviceId, target); if (row.running || row.status === 'restarting') running.push(row.id); } }
          if (running.length && await io.call(['stop', '-t', String(input.graceSeconds), ...running]) !== 0) throw new Error('Managed Stop unconfirmed');
          for (const target of input.targets) { const row = await io.inspect(target.id); if (row) { owned(row, input.serviceId, target); if (row.running || !['created', 'exited', 'dead'].includes(row.status)) throw new Error('Managed Stop state is unconfirmed'); } }
          return containerStopSetReply.parse({ requestId: input.requestId, serviceId: input.serviceId, revision: input.revision, complete: true,
            items: input.targets.map(target => ({ ...target, running: false })) });
        });
      });
    },
    async prepare(params: unknown, onLine: (line: string) => void = () => {}): Promise<ContainerPrepareReply> {
      const input = containerPrepareRequest.parse(params);
      // Validate every spec and fingerprint secrets before touching the journal or Docker.
      const specs = input.specs.map(raw => parseRunSpec(raw));
      for (const spec of specs) assertFileMountsWritten(spec.fileMounts);
      const envHashes = specs.map(envDigest);
      const fingerprints = specs.map((spec, index) => ({ name: spec.name, specHash: digest(JSON.stringify(canonical({
        spec: { ...spec, labels: [...spec.labels].sort(labelOrder), userLabels: [...spec.userLabels].sort(labelOrder) }, envHash: envHashes[index],
      }))) }));
      const serving = new Set(input.startNames ?? specs.map(spec => spec.name));
      const intent = { kind: 'prepare', requestId: input.requestId, serviceId: input.serviceId, deploymentId: input.deploymentId, revision: input.revision,
        targets: fingerprints.map(item => ({ ...item, running: serving.has(item.name) })) };
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, async journal => {
        const admitted = await claim(journal, input, intent);
        return effect(journal, input, admitted.hash, value => containerPrepareReply.parse(value), async () => {
          const io = dockerIO(journal, onLine), previous: Array<DockerRow | null> = [];
          const attest = (row: DockerRow, index: number) => {
            owned(row, input.serviceId, { name: specs[index]!.name, deploymentId: input.deploymentId });
            if (row.nonce !== input.requestId || row.specHash !== fingerprints[index]!.specHash) throw new Error('Managed creation name is occupied by another intent; retained');
          };
          for (const [index, spec] of specs.entries()) {
            const row = await io.inspect(spec.name);
            if (row) {
              attest(row, index);
              if (!['created', 'running', 'exited'].includes(row.status) || (row.status === 'running') !== row.running) throw new Error('Managed creation state cannot be started');
              if (!serving.has(spec.name) && row.running) throw new Error('Spare capacity is unexpectedly running; retained for review');
            }
            previous.push(row);
          }
          const items: ContainerPrepareReply['items'] = [];
          for (const [index, spec] of specs.entries()) {
            assertFileMountsWritten(spec.fileMounts);
            if (envDigest(spec) !== envHashes[index]) throw new Error('Managed environment changed during preparation');
            let row = previous[index];
            if (!row) {
              let id: string | undefined, duplicate = false;
              const labelled = { ...spec, labels: [...spec.labels, ['ninedeploy.mutation', input.requestId] as [string, string], ['ninedeploy.spec', fingerprints[index]!.specHash] as [string, string]] };
              const code = await io.call(runSpecArgv(labelled, 'create'), line => { onLine(line); if (/^[a-f0-9]{64}$/.test(line.trim())) { if (id) duplicate = true; id = line.trim(); } });
              if (code !== 0 || !id || duplicate) throw new Error('Managed creation receipt unavailable; ownership retained for recovery');
              row = await io.inspect(id); if (!row) throw new Error('Managed creation identity disappeared'); attest(row, index);
            }
            if (!['created', 'running', 'exited'].includes(row.status)) throw new Error('Managed creation state cannot be started');
            for (const network of spec.extraNetworks) {
              if (!Object.hasOwn(row.networks, network)) {
                await io.call(['network', 'connect', network, row.id]);
                const connected = await io.inspect(row.id); if (!connected) throw new Error('Managed network identity disappeared'); attest(connected, index);
                if (!Object.hasOwn(connected.networks, network)) throw new Error('Managed network attachment unconfirmed'); row = connected;
              }
            }
            if (serving.has(spec.name)) {
              if (!row.running || row.status !== 'running') { if (await io.call(['start', row.id]) !== 0) throw new Error('Managed Start unconfirmed'); }
            } else if (row.running) throw new Error('Spare capacity is unexpectedly running; retained for review');
            const after = await io.inspect(row.id); if (!after) throw new Error('Managed Start identity disappeared'); attest(after, index);
            if ((serving.has(spec.name) ? !after.running || after.status !== 'running' : after.running || !['created', 'exited'].includes(after.status)) ||
              ![spec.network, ...spec.extraNetworks].every(network => Object.hasOwn(after.networks, network))) throw new Error('Managed serving state or networks unconfirmed');
            items.push({ id: after.id, name: after.name, deploymentId: input.deploymentId, running: after.running });
          }
          return containerPrepareReply.parse({ requestId: input.requestId, serviceId: input.serviceId, deploymentId: input.deploymentId, revision: input.revision, complete: true, items });
        });
      });
    },
    async networks(params: unknown, onLine: (line: string) => void = () => {}): Promise<ContainerNetworkSetReply> {
      const input = containerNetworkSetRequest.parse(params), { timeoutMs: _timeout, ...intent } = input;
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, async journal => {
        const admitted = await claim(journal, input, { kind: 'network', ...intent });
        return effect(journal, input, admitted.hash, value => containerNetworkSetReply.parse(value), async () => {
          const io = dockerIO(journal, onLine), rows: DockerRow[] = [], connected = input.action === 'connect';
          for (const target of input.targets) {
            const row = await io.inspect(target.id); if (!row) throw new Error('Managed network target disappeared');
            owned(row, input.serviceId, target); rows.push(row);
          }
          for (const [index, target] of input.targets.entries()) {
            let row = rows[index]!;
            for (const network of input.networks) {
              if (Object.hasOwn(row.networks, network) !== connected) {
                await io.call(['network', input.action, network, target.id]);
                const observed = await io.inspect(target.id); if (!observed) throw new Error('Managed network target disappeared');
                owned(observed, input.serviceId, target); row = observed;
                if (Object.hasOwn(row.networks, network) !== connected) throw new Error('Managed network membership unconfirmed');
              }
            }
          }
          return containerNetworkSetReply.parse({ requestId: input.requestId, serviceId: input.serviceId, revision: input.revision,
            action: input.action, networks: input.networks, complete: true, items: input.targets.map(target => ({ ...target, connected })) });
        });
      });
    },
    async retire(params: unknown, onLine: (line: string) => void = () => {}): Promise<ContainerRetireSetReply> {
      const input = containerRetireSetRequest.parse(params), { timeoutMs: _timeout, ...intent } = input;
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, async journal => {
        const admitted = await claim(journal, input, { kind: 'retire', ...intent });
        return effect(journal, input, admitted.hash, value => containerRetireSetReply.parse(value), async () => {
          const io = dockerIO(journal, onLine), existing: DockerRow[] = [];
          for (const target of input.targets) { const row = await io.inspect(target.id); if (row) { owned(row, input.serviceId, target); existing.push(row); } }
          const running = existing.filter(row => row.running || row.status === 'restarting').map(row => row.id);
          if (running.length && await io.call(['stop', '-t', String(input.graceSeconds), ...running]) !== 0) throw new Error('Managed retirement Stop unconfirmed');
          if (existing.length) await io.call(['rm', '-f', ...existing.map(row => row.id)]);
          for (const target of input.targets) if (await io.inspect(target.id)) throw new Error('Managed retirement absence unconfirmed');
          return containerRetireSetReply.parse({ requestId: input.requestId, serviceId: input.serviceId, revision: input.revision, complete: true,
            items: input.targets.map(target => ({ ...target, removed: true })) });
        });
      });
    },
  };
}
