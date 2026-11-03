import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export interface PersistentPortBinding {
  hostIp: string;
  hostPort: number;
  hostPortEnd?: number | null;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  allowFrom?: readonly string[] | null;
}

export interface PersistentPortNftSpec {
  serviceId: number;
  owner: string;
  revision: number;
  mark: number;
  target: { id: string; ipv4: string };
  bindings: readonly PersistentPortBinding[];
}

function unicast4(value: string): boolean {
  return isIP(value) === 4 && Number(value.split('.')[0]) > 0 && Number(value.split('.')[0]) < 224;
}

function port(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Structural checks only; the caller must verify Docker identities and acquire publication authority. */
export function persistentPortRules(spec: PersistentPortNftSpec) {
  if (!Number.isSafeInteger(spec.serviceId) || spec.serviceId < 1 || !Number.isSafeInteger(spec.revision) || spec.revision < 1 ||
    !/^[a-f0-9]{32}$/.test(spec.owner) || !Number.isInteger(spec.mark) || spec.mark < 1 || spec.mark > 0xffffffff ||
    !/^[a-f0-9]{64}$/.test(spec.target.id) || !unicast4(spec.target.ipv4)) throw new Error('Invalid persistent ingress identity');
  if (!spec.bindings.length || spec.bindings.length > 20) throw new Error('Persistent ingress requires 1 to 20 port mappings');
  const seen = new Set<string>();
  const rules: Array<{ ip: string; protocol: 'tcp' | 'udp'; hostPort: number; containerPort: number }> = [];
  for (const binding of spec.bindings) {
    const end = binding.hostPortEnd ?? binding.hostPort;
    if (!unicast4(binding.hostIp) || binding.hostIp === spec.target.ipv4 || !port(binding.hostPort) || !port(end) ||
      end < binding.hostPort || !port(binding.containerPort) || !port(binding.containerPort + end - binding.hostPort) ||
      !['tcp', 'udp'].includes(binding.protocol) || binding.allowFrom?.length) {
      throw new Error('Persistent ingress requires valid explicit IPv4 mappings without an allow list');
    }
    if (rules.length + end - binding.hostPort + 1 > 1000) throw new Error('Persistent ingress supports at most 1000 ports');
    for (let hostPort = binding.hostPort; hostPort <= end; hostPort++) {
      const key = `${binding.hostIp}/${binding.protocol}/${hostPort}`;
      if (seen.has(key)) throw new Error('Persistent ingress port mappings overlap');
      seen.add(key);
      rules.push({ ip: binding.hostIp, protocol: binding.protocol, hostPort, containerPort: binding.containerPort + hostPort - binding.hostPort });
    }
  }
  return rules.sort((a, b) => a.ip.localeCompare(b.ip) || a.protocol.localeCompare(b.protocol) || a.hostPort - b.hostPort);
}

export function persistentPortTable(spec: PersistentPortNftSpec): string {
  persistentPortRules(spec);
  return `ndpi_s${spec.serviceId}`;
}

export function persistentPortFingerprint(spec: PersistentPortNftSpec): string {
  const rules = persistentPortRules(spec);
  return createHash('sha256').update(JSON.stringify({ serviceId: spec.serviceId, owner: spec.owner, revision: spec.revision, mark: spec.mark, target: { id: spec.target.id, ipv4: spec.target.ipv4 }, rules })).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Verify actual kernel rules, not just an ownership comment left on a table.
 * Unknown flags/objects fail closed. Kernel-assigned handles are immaterial. */
export function assertPersistentPortNftState(spec: PersistentPortNftSpec, snapshot: unknown): void {
  const rules = persistentPortRules(spec), name = persistentPortTable(spec);
  const data = snapshot as { nftables?: unknown[] } | null;
  if (!data || !Array.isArray(data.nftables)) throw new Error('Invalid persistent ingress kernel snapshot');
  const actual: unknown[] = [];
  for (const entry of data.nftables) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid persistent ingress kernel object');
    for (const [kind, value] of Object.entries(entry)) {
      if (!value || typeof value !== 'object') continue;
      const object = value as Record<string, unknown>;
      if (object.family !== 'ip' || (object.table !== name && !(kind === 'table' && object.name === name))) continue;
      const { handle: _handle, ...meaning } = object;
      actual.push({ [kind]: meaning });
    }
  }
  const expected: unknown[] = [{ table: { family: 'ip', name, comment: `ninedeploy:${spec.owner}:${spec.revision}:${persistentPortFingerprint(spec)}` } }];
  for (const [chain, hook] of [['incoming', 'prerouting'], ['local', 'output']]) {
    expected.push({ chain: { family: 'ip', table: name, name: chain, type: 'nat', hook, prio: -101, policy: 'accept' } });
    for (const rule of rules) expected.push({ rule: { family: 'ip', table: name, chain, expr: [
      { match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: rule.ip } },
      { match: { op: '==', left: { payload: { protocol: rule.protocol, field: 'dport' } }, right: rule.hostPort } },
      { mangle: { key: { ct: { key: 'mark' } }, value: spec.mark } },
      { dnat: { addr: spec.target.ipv4, port: rule.containerPort } },
    ] } });
  }
  if (JSON.stringify(actual.map(canonical).sort()) !== JSON.stringify(expected.map(canonical).sort())) {
    throw new Error('Installed persistent ingress differs from the expected publication');
  }
}

/** One scoped nft transaction. Existing conntrack bindings retain their original backend. */
export function renderPersistentPortNft(spec: PersistentPortNftSpec, replaceOwnedTable = false): string {
  const rules = persistentPortRules(spec), table = persistentPortTable(spec);
  const marker = `ninedeploy:${spec.owner}:${spec.revision}:${persistentPortFingerprint(spec)}`;
  const mark = `0x${spec.mark.toString(16)}`;
  const routes = rules.map(rule => `    ip daddr ${rule.ip} ${rule.protocol} dport ${rule.hostPort} ct mark set ${mark} dnat to ${spec.target.ipv4}:${rule.containerPort}`).join('\n');
  const chain = (name: string, hook: string) => `  chain ${name} {\n    type nat hook ${hook} priority -101; policy accept;\n${routes}\n  }`;
  return `${replaceOwnedTable ? `delete table ip ${table}\n` : ''}table ip ${table} {\n  comment "${marker}"\n${chain('incoming', 'prerouting')}\n${chain('local', 'output')}\n}\n`;
}

/** Narrow forwarding grants, reached after Docker's DOCKER-USER policy. */
export function persistentPortForwardRules(spec: PersistentPortNftSpec, targets: readonly { id: string; ipv4: string }[]): string[][] {
  const rules = persistentPortRules(spec);
  if (!targets.length || targets.length > 3 || targets.some(t => !/^[a-f0-9]{64}$/.test(t.id) || !unicast4(t.ipv4))) throw new Error('Invalid retained ingress targets');
  return targets.flatMap(target => rules.map(rule => [
    '-p', rule.protocol, '-d', target.ipv4, '--dport', String(rule.containerPort),
    '-m', 'connmark', '--mark', `0x${spec.mark.toString(16)}`,
    '-m', 'conntrack', '--ctorigdst', rule.ip, '--ctorigdstport', String(rule.hostPort), '-j', 'ACCEPT',
  ]));
}
