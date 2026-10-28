/**
 * G4.2 OS security updates: the status parser against output captured from
 * real Ubuntu 24.04, Rocky 9 and Fedora 41 containers, the fixed scripts, the
 * host helper's argv, the agent op and the panel/node routes. Docker and the
 * agent are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  capture: vi.fn<(cmd: string, args: string[], opts?: unknown) => Promise<string>>(),
  agentOp: vi.fn(),
  assertNodeCapability: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  serverRow: { id: 3 } as { id: number } | undefined,
}));

vi.mock('../../src/lib/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/exec.js')>();
  return { ...actual, capture: h.capture };
});
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agentOp }));
vi.mock('../../src/lib/agentCapabilities.js', () => ({ assertNodeCapability: h.assertNodeCapability }));
vi.mock('../../src/lib/audit.js', () => ({ audit: h.audit }));

const { hostScriptArgs, osUpdateScript, parseOsStatus, runOsUpdateAction } = await import('../../src/lib/osUpdates.js');
const { osUpdateOps } = await import('../../src/agentOps/osUpdates.js');
const { AGENT_OPS, capabilityKillSwitch } = await import('../../src/agentOps/index.js');
const { nodeOsUpdateRoutes, osUpdateRoutes } = await import('../../src/modules/osUpdates.js');
const { buildTestApp, asUser } = await import('../helpers.js');

const NOW = new Date('2026-10-28T09:00:00Z');

const UBUNTU = [
  'os=ubuntu',
  'version=24.04',
  'name=Ubuntu 24.04.5 LTS',
  'pm=apt',
  'pkg=liblzma5|5.6.1+really5.4.5-1ubuntu0.4|5.6.1+really5.4.5-1ubuntu0.3|noble-updates,noble-security',
  'pkg=libsystemd0|255.4-1ubuntu8.18|255.4-1ubuntu8.17|noble-updates,noble-security',
  'pkg=tzdata|2026b-0ubuntu0.24.04|2026a-0ubuntu0.24.04|noble-updates',
  'autoInstalled=1',
  'autoEnabled=1',
  'reboot=1',
  'rebootPkg=linux-image-6.8.0-90-generic',
  'warn=apt-get update failed',
].join('\n');

const ROCKY = [
  'os=rocky',
  'version=9.8',
  'name=Rocky Linux 9.8 (Blue Onyx)',
  'pm=dnf',
  'pkg=attr.x86_64|2.6.0-1.el9_8||baseos',
  'pkg=coreutils.x86_64|8.32-41.el9_8.1||baseos',
  'pkg=ca-certificates.noarch|2026.2.92_v9.0.319-90.3.el9_8||baseos',
  'sec=attr-2.6.0-1.el9_8.x86_64',
  'sec=coreutils-single-8.32-41.el9_8.1.x86_64',
  'sec=ca-certificates-2026.2.92_v9.0.319-90.3.el9_8.noarch',
  'autoInstalled=0',
  'autoEnabled=1',
  'reboot=unknown',
].join('\n');

describe('parseOsStatus', () => {
  it('reads apt output: security from the -security suite, the reboot and its packages', () => {
    const s = parseOsStatus(UBUNTU, NOW);
    expect(s.os).toEqual({ id: 'ubuntu', version: '24.04', name: 'Ubuntu 24.04.5 LTS' });
    expect(s.packageManager).toBe('apt');
    expect(s.updates).toHaveLength(3);
    expect(s.updates[0]).toEqual({ name: 'liblzma5', version: '5.6.1+really5.4.5-1ubuntu0.4', from: '5.6.1+really5.4.5-1ubuntu0.3', security: true });
    expect(s.updates.find((u) => u.name === 'tzdata')?.security).toBe(false);
    expect(s.securityCount).toBe(2);
    expect(s.autoUpdates).toEqual({ installed: true, enabled: true });
    expect(s.rebootRequired).toBe(true);
    expect(s.rebootPackages).toEqual(['linux-image-6.8.0-90-generic']);
    expect(s.warnings).toEqual(['apt-get update failed']);
    expect(s.checkedAt).toBe(NOW.toISOString());
  });

  it('reads dnf output: security by advisory NEVRA, not by a name prefix', () => {
    const s = parseOsStatus(ROCKY, NOW);
    expect(s.packageManager).toBe('dnf');
    const sec = Object.fromEntries(s.updates.map((u) => [u.name, u.security]));
    // coreutils-single's advisory must not mark coreutils.
    expect(sec).toEqual({ 'attr.x86_64': true, 'coreutils.x86_64': false, 'ca-certificates.noarch': true });
    expect(s.updates[0]!.from).toBeNull();
    // Enabled without the package installed is not enabled.
    expect(s.autoUpdates).toEqual({ installed: false, enabled: false });
    expect(s.rebootRequired).toBeNull();
  });

  it('reports an unsupported host without a reboot verdict, and caps the list', () => {
    expect(parseOsStatus('os=alpine\npm=unsupported\nreboot=0', NOW)).toMatchObject({ packageManager: 'unsupported', rebootRequired: null, updates: [] });
    const many = ['pm=apt', ...Array.from({ length: 1005 }, (_, i) => `pkg=p${i}|2|1|x-security`)].join('\n');
    const s = parseOsStatus(many, NOW);
    expect(s.updates).toHaveLength(1000);
    expect(s.updatesTruncated).toBe(true);
  });
});

describe('scripts and the host helper', () => {
  it('picks a fixed script per action; only enable installs, and it turns automatic reboots off', () => {
    expect(osUpdateScript('status').startsWith('R=0\n')).toBe(true);
    expect(osUpdateScript('refresh').startsWith('R=1\n')).toBe(true);
    expect(osUpdateScript('enable')).toContain('Unattended-Upgrade::Automatic-Reboot "false";');
    expect(osUpdateScript('enable')).toContain('upgrade_type = security');
    for (const a of ['status', 'refresh', 'disable'] as const) expect(osUpdateScript(a)).not.toMatch(/apt-get install|dnf -y/);
    // No action ever reboots or powers off the host.
    for (const a of ['status', 'refresh', 'enable', 'disable'] as const) {
      // As a command: at a line start or after ; & | (the scripts' own comments may say the word).
      expect(osUpdateScript(a)).not.toMatch(/(^\s*|[;&|]\s*)(reboot|shutdown|poweroff|systemctl\s+(reboot|poweroff|kexec))\b/m);
    }
  });

  it('enters PID 1 through nsenter with the script as one argument', () => {
    const args = hostScriptArgs('traefik:3', 'echo hi');
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toEqual(expect.arrayContaining(['--privileged', '--pid=host', '--entrypoint', 'nsenter', 'traefik:3']));
    expect(args.slice(-11, -2)).toEqual(['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', '/bin/sh']);
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('runs the change, then reads the status back', async () => {
    h.capture.mockReset();
    h.capture.mockResolvedValueOnce('').mockResolvedValueOnce(UBUNTU);
    const s = await runOsUpdateAction('img', 'enable', NOW);
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.capture.mock.calls[0]![1].at(-1)).toBe(osUpdateScript('enable'));
    expect(h.capture.mock.calls[1]![1].at(-1)).toBe(osUpdateScript('status'));
    expect(s.autoUpdates.enabled).toBe(true);
  });
});

describe('agent op host.packages', () => {
  beforeEach(() => h.capture.mockReset());

  it('is registered, sealed only, and can be switched off by the node owner', () => {
    expect(AGENT_OPS.get('host.packages')?.sealedOnly).toBe(true);
    expect(capabilityKillSwitch('host.packages', { NINEDEPLOY_AGENT_HOST_PACKAGES: 'off' })).toBe('NINEDEPLOY_AGENT_HOST_PACKAGES');
    expect(capabilityKillSwitch('host.packages', {})).toBeNull();
  });

  it('refuses an unknown action before touching the host, and answers one JSON line', async () => {
    const op = osUpdateOps.ops['host.packages']!;
    await expect(op.run({ action: 'upgrade-everything' }, () => {}, { sealed: true })).rejects.toThrow('unknown action');
    expect(h.capture).not.toHaveBeenCalled();
    h.capture.mockResolvedValue(UBUNTU);
    const lines: string[] = [];
    expect(await op.run({ action: 'refresh' }, (l) => lines.push(l), { sealed: true })).toBe(0);
    expect(h.capture.mock.calls[0]![1].at(-1)).toBe(osUpdateScript('refresh'));
    expect(JSON.parse(lines[0]!).packageManager).toBe('apt');
  });
});

describe('routes', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    h.capture.mockReset();
    h.agentOp.mockReset();
    h.audit.mockClear();
    h.assertNodeCapability.mockClear();
    // Only the node lookup touches the database.
    const db = { query: { servers: { findFirst: async () => h.serverRow } } };
    app = await buildTestApp({ db: db as never });
    await app.register(osUpdateRoutes, { prefix: '/os-updates' });
    await app.register(nodeOsUpdateRoutes, { prefix: '/servers/:serverId/os-updates' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads the panel host, refreshing on request; members are refused', async () => {
    h.capture.mockResolvedValue(UBUNTU);
    const res = await app.inject({ method: 'GET', url: '/os-updates?refresh=1', headers: asUser(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json().securityCount).toBe(2);
    expect(h.capture.mock.calls[0]![1].at(-1)).toBe(osUpdateScript('refresh'));
    expect((await app.inject({ method: 'GET', url: '/os-updates?refresh=yes', headers: asUser(1) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/os-updates', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);
  });

  it('switches automatic updates on the panel host and audits it', async () => {
    h.capture.mockResolvedValueOnce('').mockResolvedValueOnce(UBUNTU);
    const res = await app.inject({ method: 'POST', url: '/os-updates/auto', headers: asUser(1), payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(h.capture.mock.calls[0]![1].at(-1)).toBe(osUpdateScript('enable'));
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), 1, 'os_updates.auto_enable', 'panel host', expect.objectContaining({ packageManager: 'apt' }));
  });

  it('answers 502 with the reason when the host helper fails', async () => {
    h.capture.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    const res = await app.inject({ method: 'GET', url: '/os-updates', headers: asUser(1) });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('Cannot connect to the Docker daemon');
  });

  it('refuses a second action on the same host while one runs', async () => {
    let release!: (v: string) => void;
    h.capture.mockImplementationOnce(() => new Promise<string>((r) => { release = r; }));
    const first = app.inject({ method: 'GET', url: '/os-updates', headers: asUser(1) });
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(1));
    const second = await app.inject({ method: 'GET', url: '/os-updates', headers: asUser(1) });
    expect(second.statusCode).toBe(409);
    release(UBUNTU);
    expect((await first).statusCode).toBe(200);
  });

  it('asks a node through the sealed agent op after checking its capability', async () => {
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: [JSON.stringify(parseOsStatus(ROCKY, NOW))] });
    const res = await app.inject({ method: 'POST', url: '/servers/3/os-updates/auto', headers: asUser(1), payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(h.assertNodeCapability).toHaveBeenCalledWith(expect.anything(), 3, expect.objectContaining({ cap: 'host.packages', sealedRequired: true }));
    expect(h.agentOp).toHaveBeenCalledWith(expect.anything(), 3, 'host.packages', { action: 'disable' }, expect.any(Function));
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), 1, 'os_updates.auto_disable', 'node #3', expect.objectContaining({ serverId: 3 }));
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('refuses an unreadable node answer and an unknown node', async () => {
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: ['not json'] });
    expect((await app.inject({ method: 'GET', url: '/servers/3/os-updates', headers: asUser(1) })).statusCode).toBe(502);
    h.serverRow = undefined;
    expect((await app.inject({ method: 'GET', url: '/servers/9/os-updates', headers: asUser(1) })).statusCode).toBe(404);
    h.serverRow = { id: 3 };
  });
});
