import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, databasePublicAccess, databases, type DB, runMigrations, servers, services, users } from '@ninedeploy/db';
import { formatPortMapping, isBindableIp, parsePortMapping, portMappingsProblem, updateService } from '@ninedeploy/schemas';

/**
 * 0.16.1 port mappings: extra host ports of a docker service, TCP or UDP,
 * single or ranges, on every address or one dedicated IP. The schema checks
 * ranges, overlaps and the port budget; the route applies the published-port
 * privilege rules and refuses a port another owner holds; the docker run line
 * and its compose twin carry the same `-p` operands; Swarm and nodes refuse.
 *
 * Real migrated SQLite for the routes; Docker and Traefik are fakes.
 */

vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] })),
}));
vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
  getStickyEnabledForService: vi.fn(async () => false),
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const hostIps = vi.hoisted(() => ({ listHostAddresses: vi.fn(async (): Promise<Array<{ ip: string; family: 4 | 6; iface: string }> | null> => null) }));
vi.mock('../src/lib/hostAddresses.js', () => hostIps);

const { portMappingArgs, renderRuntimeCompose } = await import('../src/engine/builders/docker.js');
const { normalizePortMapping, servicesRoutes } = await import('../src/modules/services.js');
const { hostPortConflict } = await import('../src/lib/hostPort.js');
const { swarmServiceRefusal } = await import('../src/engine/swarmDeploy.js');
const { assertPublicPortAvailable } = await import('../src/lib/publicDatabaseAccess.js');
const { hostAddressRoutes } = await import('../src/modules/hostAddresses.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const udpRange = { hostPort: 27015, hostPortEnd: 27030, containerPort: 27015, protocol: 'udp' as const };

describe('port mapping text, format and checks', () => {
  it('parses the forms the panel and the CLI accept', () => {
    expect(parsePortMapping('27015-27030:27015/udp')).toEqual({ hostIp: null, ...udpRange });
    expect(parsePortMapping('8080:80')).toEqual({ hostIp: null, hostPort: 8080, hostPortEnd: null, containerPort: 80, protocol: 'tcp' });
    expect(parsePortMapping(' 53/UDP ')).toEqual({ hostIp: null, hostPort: 53, hostPortEnd: null, containerPort: 53, protocol: 'udp' });
    expect(parsePortMapping('203.0.113.7:53/udp')).toMatchObject({ hostIp: '203.0.113.7', hostPort: 53, containerPort: 53 });
    expect(parsePortMapping('[2001:db8::7]:8080:80')).toMatchObject({ hostIp: '2001:db8::7', hostPort: 8080, containerPort: 80 });
    expect(parsePortMapping('10-20:30-40')).toMatchObject({ hostPort: 10, hostPortEnd: 20, containerPort: 30 });
    expect(parsePortMapping('5000-5000:6000')).toMatchObject({ hostPortEnd: null });
  });

  it.each([
    ['abc', /not a port mapping/],
    ['1.2.3.453', /not a port mapping/],
    ['70000:80', /1 to 65535/],
    ['30-20:30', /ends before it starts/],
    ['10-20:30-35', /as long as the host range/],
    ['0.0.0.0:80', /not an address a port can be bound to/],
    ['[::]:80', /not an address a port can be bound to/],
  ])('refuses %s', (text, message) => {
    expect(parsePortMapping(text)).toMatch(message);
  });

  it('accepts literal host addresses only, never the unspecified ones', () => {
    for (const ip of ['203.0.113.7', '::1', '2001:db8::7', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1']) expect(isBindableIp(ip), ip).toBe(true);
    for (const ip of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '01.2.3.4', '256.1.1.1', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '1::2::3', '10.0.0.0/8', 'host'])
      expect(isBindableIp(ip), ip).toBe(false);
  });

  it('formats the docker -p operand, bracketing IPv6', () => {
    expect(formatPortMapping(udpRange)).toBe('27015-27030:27015-27030/udp');
    expect(formatPortMapping({ hostPort: 8080, containerPort: 80 })).toBe('8080:80/tcp');
    expect(formatPortMapping({ hostIp: '203.0.113.7', hostPort: 53, containerPort: 5353, protocol: 'udp' })).toBe('203.0.113.7:53:5353/udp');
    expect(formatPortMapping({ hostIp: '2001:db8::7', hostPort: 53, containerPort: 53, protocol: 'udp' })).toBe('[2001:db8::7]:53:53/udp');
  });

  it('refuses overlaps per address and protocol, container ranges past 65535 and more than 1000 ports', () => {
    expect(portMappingsProblem([udpRange, { ...udpRange, protocol: 'tcp' }])).toBeNull();
    expect(portMappingsProblem([{ ...udpRange, hostIp: '203.0.113.7' }, { ...udpRange, hostIp: '203.0.113.8' }])).toBeNull();
    expect(portMappingsProblem([{ ...udpRange, hostIp: '203.0.113.7' }, { hostPort: 27020, containerPort: 1, protocol: 'udp' }])).toMatch(/overlaps/);
    expect(portMappingsProblem([{ hostPort: 65000, hostPortEnd: 65010, containerPort: 65530, protocol: 'tcp' }])).toMatch(/past 65535/);
    expect(portMappingsProblem([{ hostPort: 10, hostPortEnd: 5, containerPort: 10, protocol: 'tcp' }])).toMatch(/ends before/);
    expect(portMappingsProblem([{ hostPort: 10000, hostPortEnd: 11000, containerPort: 10000, protocol: 'udp' }])).toMatch(/at most 1000/);
    expect(portMappingsProblem([{ hostPort: 10000, hostPortEnd: 10999, containerPort: 10000, protocol: 'udp' }])).toBeNull();
  });

  it('the PATCH schema runs the same checks and bounds the rule count', () => {
    expect(updateService.safeParse({ portMappings: [udpRange] }).success).toBe(true);
    expect(updateService.safeParse({ portMappings: null }).success).toBe(true);
    expect(updateService.safeParse({ portMappings: [udpRange, udpRange] }).success).toBe(false);
    expect(updateService.safeParse({ portMappings: [{ ...udpRange, hostIp: '0.0.0.0' }] }).success).toBe(false);
    expect(updateService.safeParse({ portMappings: [{ ...udpRange, extra: 1 }] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ hostPort: 20000 + i, containerPort: 80, protocol: 'tcp' as const }));
    expect(updateService.safeParse({ portMappings: many }).success).toBe(false);
  });

  it('stores every key, collapses a one-port range and lower-cases the IP', () => {
    expect(normalizePortMapping({ hostIp: '2001:DB8::7', hostPort: 53, hostPortEnd: 53, containerPort: 53, protocol: 'udp' })).toEqual({
      hostIp: '2001:db8::7', hostPort: 53, hostPortEnd: null, containerPort: 53, protocol: 'udp',
    });
  });
});

describe('docker run flags and the compose twin', () => {
  const mappings = [udpRange, { hostIp: '203.0.113.7', hostPort: 8443, hostPortEnd: null, containerPort: 443, protocol: 'tcp' as const }];

  it('one -p per mapping', () => {
    expect(portMappingArgs(mappings)).toEqual(['-p', '27015-27030:27015-27030/udp', '-p', '203.0.113.7:8443:443/tcp']);
    expect(portMappingArgs(null)).toEqual([]);
  });

  const base = {
    name: 'game-1', image: 'img', restart: 'unless-stopped', bridge: 'nd-svc-game', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0,
    dataVolume: null, dataMount: null, attachments: [], publishedPort: null, containerPort: null, dockerSocket: false, cmd: null, envFile: null,
  };

  it('renders the same operands as compose ports, after the direct port', () => {
    const yaml = renderRuntimeCompose({ ...base, publishedPort: 8080, containerPort: 3000, portMappings: mappings });
    expect(yaml).toContain('    ports:\n      - "8080:3000"\n      - "27015-27030:27015-27030/udp"\n      - "203.0.113.7:8443:443/tcp"\n');
    expect(renderRuntimeCompose({ ...base, portMappings: mappings })).toContain('    ports:\n      - "27015-27030:27015-27030/udp"\n');
  });

  it('control: without mappings the compose file is byte-identical to before', () => {
    expect(renderRuntimeCompose({ ...base, portMappings: null })).toBe(renderRuntimeCompose(base));
    expect(renderRuntimeCompose({ ...base, portMappings: [] })).not.toContain('ports:');
  });
});

describe('PATCH /services/:id portMappings', () => {
  let db: DB;
  const OWNER = 7;

  beforeEach(async () => {
    hostIps.listHostAddresses.mockResolvedValue(null);
    ({ db } = createDb({ url: ':memory:' }));
    await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    await db.insert(users).values([
      { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
      { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
    ]);
  });

  async function setup(values: Record<string, unknown> = {}) {
    const [svc] = await db
      .insert(services)
      .values({ name: 'game', slug: 'game', type: 'docker', image: 'game/server', branch: 'main', ownerUserId: OWNER, ...values } as never)
      .returning();
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    await app.register(hostAddressRoutes, { prefix: '/services' });
    const row = async () => (await db.query.services.findFirst({ where: eq(services.id, svc!.id) }))!;
    const patch = (payload: object, headers = asUser()) => app.inject({ method: 'PATCH', url: `/services/${svc!.id}`, headers, payload });
    return { app, id: svc!.id, row, patch };
  }
  const member = asUser({ id: OWNER, isOperator: false });

  it('a pre-0.16.1 service lists no mappings', async () => {
    const { app, id } = await setup();
    const body = (await app.inject({ method: 'GET', url: `/services/${id}`, headers: asUser() })).json() as Record<string, unknown>;
    expect(body['portMappings']).toEqual([]);
    await app.close();
  });

  it('a member publishes a UDP range on a dedicated IP, reads it back, and clears it with [] or null', async () => {
    const { app, id, row, patch } = await setup();
    const res = await patch({ portMappings: [{ ...udpRange, hostIp: '203.0.113.7' }, { hostPort: 9000, containerPort: 9000 }] }, member);
    expect(res.statusCode, res.body).toBe(200);
    expect((await row()).portMappings).toEqual([
      { hostIp: '203.0.113.7', ...udpRange },
      { hostIp: null, hostPort: 9000, hostPortEnd: null, containerPort: 9000, protocol: 'tcp' },
    ]);
    const body = (await app.inject({ method: 'GET', url: `/services/${id}`, headers: member })).json() as { portMappings: unknown[] };
    expect(body.portMappings).toHaveLength(2);

    expect((await patch({ portMappings: [] }, member)).statusCode).toBe(200);
    expect((await row()).portMappings).toBeNull();
    await patch({ portMappings: [udpRange] }, member);
    expect((await patch({ portMappings: null }, member)).statusCode).toBe(200);
    expect((await row()).portMappings).toBeNull();
    await app.close();
  });

  it('privileged ports need an operator; a member may still edit a service an operator gave one', async () => {
    const { app, row, patch } = await setup();
    const denied = await patch({ portMappings: [{ hostPort: 53, containerPort: 53, protocol: 'udp' }] }, member);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatch(/below 1024 are privileged \(53:53\/udp\)/);
    expect((await patch({ portMappings: [{ hostPort: 53, containerPort: 53, protocol: 'udp' }] })).statusCode).toBe(200);
    const same = await patch({ portMappings: [{ hostPort: 53, containerPort: 53, protocol: 'udp' }], healthTimeoutSeconds: 600 }, member);
    expect(same.statusCode, same.body).toBe(200);
    expect((await row()).healthTimeoutSeconds).toBe(600);
    await app.close();
  });

  it('refuses a range that covers a NineDeploy port, for every role and protocol', async () => {
    const { app, row, patch } = await setup();
    const res = await patch({ portMappings: [{ hostPort: 400, hostPortEnd: 500, containerPort: 400, protocol: 'udp' }] });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/Host port 443 .* is reserved by NineDeploy/);
    expect((await row()).portMappings).toBeNull();
    await app.close();
  });

  it('refuses mappings on a compose service', async () => {
    const { app, patch } = await setup({ type: 'compose', image: null });
    expect((await patch({ portMappings: [udpRange] })).statusCode).toBe(400);
    await app.close();
  });

  it("a node service publishes mappings on its node; the node agent's port is reserved, and a move re-checks the target host", async () => {
    const [node] = await db.insert(servers).values({ name: 'n1', host: '198.51.100.20', port: 4600, tokenEncrypted: 'v1:x' }).returning();
    await db.insert(services).values({ name: 'edge', slug: 'edge', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER, serverId: node!.id, portMappings: [{ hostPort: 9000, containerPort: 9000, protocol: 'udp' }] } as never);
    const onNode = await setup({ serverId: node!.id });
    const ok = await onNode.patch({ portMappings: [{ ...udpRange, hostIp: '198.51.100.20' }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(hostIps.listHostAddresses).not.toHaveBeenCalled();
    const agentPort = await onNode.patch({ portMappings: [{ hostPort: 4600, containerPort: 4600, protocol: 'tcp' }] });
    expect(agentPort.statusCode).toBe(403);
    expect(agentPort.body).toMatch(/Host port 4600 .* is reserved/);
    expect((await onNode.patch({ portMappings: [{ hostPort: 9000, containerPort: 9000, protocol: 'udp' }] })).statusCode).toBe(409);
    await onNode.app.close();

    const local = await setup({ name: 'game2', slug: 'game2', portMappings: [{ hostPort: 9000, hostPortEnd: null, containerPort: 9000, protocol: 'udp' }] });
    const move = await local.patch({ serverId: node!.id });
    expect(move.statusCode).toBe(409);
    expect(move.body).toMatch(/9000\/udp is already published by service \\"edge\\"/);
    expect((await local.row()).serverId).toBeNull();
    await local.app.close();
  });

  it('refuses a port another panel-host service or the service itself already publishes; another IP or a node does not count', async () => {
    const [node] = await db.insert(servers).values({ name: 'n1', host: '198.51.100.20', tokenEncrypted: 'v1:x' }).returning();
    await db.insert(services).values([
      { name: 'voice', slug: 'voice', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER, portMappings: [{ hostIp: '203.0.113.7', ...udpRange }] },
      { name: 'remote', slug: 'remote', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER, serverId: node!.id, publishedPort: 9000 },
    ] as never);
    const { app, patch } = await setup({ publishedPort: 8080 });

    const taken = await patch({ portMappings: [{ hostPort: 27020, containerPort: 27020, protocol: 'udp' }] });
    expect(taken.statusCode).toBe(409);
    expect(taken.body).toMatch(/27020\/udp is already published by service \\"voice\\"/);
    expect((await patch({ portMappings: [{ hostIp: '203.0.113.8', ...udpRange }] })).statusCode).toBe(200);
    expect((await patch({ portMappings: [{ ...udpRange, protocol: 'tcp' }, { hostPort: 9000, containerPort: 9000 }] })).statusCode).toBe(200);

    const own = await patch({ portMappings: [{ hostPort: 8080, containerPort: 80 }] });
    expect(own.statusCode).toBe(409);
    expect(own.body).toMatch(/already this service's direct host port/);
    await app.close();
  });

  it('the direct host port: refused when another service on the same host has it, on create and PATCH', async () => {
    const [node] = await db.insert(servers).values({ name: 'n1', host: '198.51.100.20', tokenEncrypted: 'v1:x' }).returning();
    await db.insert(services).values([
      { name: 'web', slug: 'web', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER, publishedPort: 8080 },
      { name: 'edge', slug: 'edge', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER, serverId: node!.id, publishedPort: 9090 },
    ] as never);
    const { app, row, patch } = await setup();

    const dup = await patch({ publishedPort: 8080 });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toMatch(/8080\/tcp is already published by service \\"web\\"/);
    expect((await row()).publishedPort).toBeNull();
    // 9090 is bound on the node, not here.
    expect((await patch({ publishedPort: 9090 })).statusCode).toBe(200);

    const create = (body: object) => app.inject({ method: 'POST', url: '/services', headers: asUser(), payload: { name: 'second', type: 'docker', image: 'nginx', ...body } });
    const refused = await create({ publishedPort: 8080 });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await hostPortConflict(db, 0, node!.id, 9090, null)).toMatch(/service "edge"/);
    expect(await hostPortConflict(db, 0, node!.id, 8080, null)).toBeNull();
    await app.close();
  });

  it('a public database port and service mappings exclude each other', async () => {
    const [pg] = await db.insert(databases).values({ name: 'pg', slug: 'pg', engine: 'postgres', status: 'running', passwordEncrypted: 'v1:x' }).returning();
    await db.insert(databasePublicAccess).values({ databaseId: pg!.id, publicPort: 15432, ipAllowlist: [] });
    expect(await hostPortConflict(db, 999, null, null, [{ hostPort: 15430, hostPortEnd: 15440, containerPort: 1, protocol: 'tcp' }])).toMatch(/database's public access/);
    expect(await hostPortConflict(db, 999, null, null, [{ hostPort: 15430, hostPortEnd: 15440, containerPort: 1, protocol: 'udp' }])).toBeNull();

    await db.insert(services).values({ name: 'svc', slug: 'svc', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER, portMappings: [{ hostPort: 16000, hostPortEnd: 16010, containerPort: 16000, protocol: 'tcp' }] } as never);
    await expect(assertPublicPortAvailable(db, 16005, pg!.id)).rejects.toThrow(/port mapping/);
    await expect(assertPublicPortAvailable(db, 16011, pg!.id)).resolves.toBeUndefined();
  });

  it('a dedicated IP must be an address of the panel host, when the host can be asked', async () => {
    hostIps.listHostAddresses.mockResolvedValue([{ ip: '203.0.113.7', family: 4, iface: 'eth0' }, { ip: '2001:db8::7', family: 6, iface: 'eth0' }]);
    const { app, id, row, patch } = await setup();
    const res = await patch({ portMappings: [{ ...udpRange, hostIp: '198.51.100.9' }] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/198\.51\.100\.9 is not an address of the panel host \(it has 203\.0\.113\.7, 2001:db8::7\)/);
    expect((await row()).portMappings).toBeNull();
    expect((await patch({ portMappings: [{ ...udpRange, hostIp: '2001:DB8::7' }] })).statusCode).toBe(200);
    expect((await row()).portMappings?.[0]?.hostIp).toBe('2001:db8::7');

    const list = await app.inject({ method: 'GET', url: `/services/${id}/host-addresses`, headers: member });
    expect(list.json()).toEqual({
      detected: true,
      addresses: [
        { ip: '203.0.113.7', family: 4, iface: 'eth0', label: null, primary: false, dedicated: null },
        { ip: '2001:db8::7', family: 6, iface: 'eth0', label: null, primary: false, dedicated: null },
      ],
    });
    hostIps.listHostAddresses.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: `/services/${id}/host-addresses`, headers: member })).json()).toEqual({ detected: false, addresses: [] });
    // Unknown host: any address is taken, Docker checks it when the container starts.
    expect((await patch({ portMappings: [{ ...udpRange, hostIp: '198.51.100.9' }] })).statusCode).toBe(200);
    await app.close();
  });

  it('a node service lists no host addresses', async () => {
    const [node] = await db.insert(servers).values({ name: 'n1', host: '198.51.100.20', tokenEncrypted: 'v1:x' }).returning();
    const { app, id } = await setup({ serverId: node!.id });
    expect((await app.inject({ method: 'GET', url: `/services/${id}/host-addresses`, headers: asUser() })).json()).toEqual({ detected: false, addresses: [] });
    expect(hostIps.listHostAddresses).not.toHaveBeenCalled();
    await app.close();
  });

  it("healthCheck: 'running' for a docker service is stored, 'http' clears it, compose is refused", async () => {
    const { app, id, row, patch } = await setup();
    const read = async () => ((await app.inject({ method: 'GET', url: `/services/${id}`, headers: member })).json() as { healthCheck: string }).healthCheck;
    expect(await read()).toBe('http');
    expect((await patch({ healthCheck: 'running' }, member)).statusCode).toBe(200);
    expect((await row()).healthCheck).toBe('running');
    expect(await read()).toBe('running');
    expect((await patch({ healthCheck: 'http' }, member)).statusCode).toBe(200);
    expect((await row()).healthCheck).toBeNull();
    expect((await patch({ healthCheck: 'tcp' })).statusCode).toBe(400);
    await app.close();

    const compose = await setup({ name: 'stack', slug: 'stack', type: 'compose', image: null });
    expect((await compose.patch({ healthCheck: 'running' })).statusCode).toBe(400);
    expect((await compose.patch({ healthCheck: null })).statusCode).toBe(200);
    await compose.app.close();
  });

  it('0.16.3 custom Docker labels: stored and read back; {} clears; reserved keys, nodes and compose are refused', async () => {
    const { app, id, row, patch } = await setup();
    const read = async () => ((await app.inject({ method: 'GET', url: `/services/${id}`, headers: member })).json() as { dockerLabels: Record<string, string> }).dockerLabels;
    expect(await read()).toEqual({});
    expect((await patch({ dockerLabels: { 'com.example.team': 'payments' } }, member)).statusCode).toBe(200);
    expect((await row()).dockerLabels).toEqual({ 'com.example.team': 'payments' });
    expect(await read()).toEqual({ 'com.example.team': 'payments' });
    expect((await patch({ dockerLabels: { 'traefik.http.routers.x.rule': 'Host(`evil`)' } })).statusCode).toBe(400);
    expect((await patch({ dockerLabels: {} })).statusCode).toBe(200);
    expect((await row()).dockerLabels).toBeNull();
    await app.close();

    const [node] = await db.insert(servers).values({ name: 'n3', host: '198.51.100.22', tokenEncrypted: 'v1:x' }).returning();
    const onNode = await setup({ name: 'remote2', slug: 'remote2', serverId: node!.id });
    expect((await onNode.patch({ dockerLabels: { a: 'b' } })).statusCode).toBe(400);
    expect((await onNode.patch({ dockerLabels: {} })).statusCode).toBe(200);
    await onNode.app.close();
    const compose = await setup({ name: 'stack3', slug: 'stack3', type: 'compose', image: null });
    expect((await compose.patch({ dockerLabels: { a: 'b' } })).statusCode).toBe(400);
    await compose.app.close();
  });

  it("0.16.3 healthCheck: 'command' needs a command, a docker service and the panel host; the command is stored and read back", async () => {
    const { app, id, row, patch } = await setup();
    const read = async () => (await app.inject({ method: 'GET', url: `/services/${id}`, headers: member })).json() as { healthCheck: string; healthCommand: string | null };
    expect(await read()).toMatchObject({ healthCheck: 'http', healthCommand: null });
    expect((await patch({ healthCheck: 'command' }, member)).statusCode).toBe(400);
    expect((await patch({ healthCheck: 'command', healthCommand: ' pg_isready ' }, member)).statusCode).toBe(200);
    expect(await row()).toMatchObject({ healthCheck: 'command', healthCommand: 'pg_isready' });
    expect(await read()).toMatchObject({ healthCheck: 'command', healthCommand: 'pg_isready' });
    // Clearing the command while the mode needs it is refused; changing the mode back is fine.
    expect((await patch({ healthCommand: null }, member)).statusCode).toBe(400);
    expect((await patch({ healthCheck: 'http' }, member)).statusCode).toBe(200);
    expect((await row()).healthCheck).toBeNull();
    await app.close();

    const [node] = await db.insert(servers).values({ name: 'n2', host: '198.51.100.21', tokenEncrypted: 'v1:x' }).returning();
    const onNode = await setup({ name: 'remote', slug: 'remote', serverId: node!.id });
    expect((await onNode.patch({ healthCheck: 'command', healthCommand: 'true' })).statusCode).toBe(400);
    await onNode.app.close();
    const compose = await setup({ name: 'stack2', slug: 'stack2', type: 'compose', image: null });
    expect((await compose.patch({ healthCheck: 'command', healthCommand: 'true' })).statusCode).toBe(400);
    await compose.app.close();
  });

  it('an allow list on a TCP port is normalised and stored; UDP, ranges, /0 and node services are refused', async () => {
    const { app, row, patch } = await setup();
    const ok = await patch({ portMappings: [{ hostPort: 5432, containerPort: 5432, allowFrom: [' 10.1.2.3/8 ', '203.0.113.4', '10.0.0.0/8'] }] }, member);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await row()).portMappings).toEqual([
      { hostIp: null, hostPort: 5432, hostPortEnd: null, containerPort: 5432, protocol: 'tcp', allowFrom: ['10.0.0.0/8', '203.0.113.4/32'] },
    ]);
    // Re-sending the same list is not a change.
    expect((await patch({ portMappings: [{ hostPort: 5432, containerPort: 5432, allowFrom: ['10.0.0.0/8', '203.0.113.4/32'] }], healthTimeoutSeconds: 600 }, member)).statusCode).toBe(200);

    const udp = await patch({ portMappings: [{ hostPort: 53, containerPort: 53, protocol: 'udp', allowFrom: ['10.0.0.0/8'] }] });
    expect(udp.statusCode).toBe(400);
    expect(udp.body).toMatch(/allow list works on one TCP port/);
    expect((await patch({ portMappings: [{ hostPort: 6000, hostPortEnd: 6001, containerPort: 6000, allowFrom: ['10.0.0.0/8'] }] })).statusCode).toBe(400);
    const everyone = await patch({ portMappings: [{ hostPort: 5432, containerPort: 5432, allowFrom: ['0.0.0.0/0'] }] });
    expect(everyone.statusCode).toBe(400);
    expect(everyone.body).toMatch(/\/0 is refused/);
    expect((await patch({ portMappings: [{ hostPort: 5432, containerPort: 5432, allowFrom: ['not-an-ip'] }] })).statusCode).toBe(400);
    await app.close();

    const [node] = await db.insert(servers).values({ name: 'n1', host: '198.51.100.20', tokenEncrypted: 'v1:x' }).returning();
    const onNode = await setup({ name: 'edge', slug: 'edge', serverId: node!.id });
    const refused = await onNode.patch({ portMappings: [{ hostPort: 5432, containerPort: 5432, allowFrom: ['10.0.0.0/8'] }] });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/allow list on a port mapping works on the panel host only/);
    await onNode.app.close();
  });

  it('parses and formats an allow list in the text form', () => {
    expect(parsePortMapping('5432@10.0.0.0/8, 203.0.113.4')).toMatchObject({ hostPort: 5432, protocol: 'tcp', allowFrom: ['10.0.0.0/8', '203.0.113.4'] });
    expect(parsePortMapping('5432@')).toMatch(/list the addresses after @/);
    expect(parsePortMapping('5432@a@b')).toMatch(/more than one @/);
    // The docker -p operand never carries it.
    expect(formatPortMapping({ hostPort: 5432, containerPort: 5432, allowFrom: ['10.0.0.0/8'] })).toBe('5432:5432/tcp');
  });

  it('Swarm refuses a service with mappings', async () => {
    const reason = await swarmServiceRefusal(db, { id: 1, type: 'docker', image: 'x', portMappings: [udpRange] });
    expect(reason).toMatch(/Port mappings are refused on Swarm/);
  });
});
