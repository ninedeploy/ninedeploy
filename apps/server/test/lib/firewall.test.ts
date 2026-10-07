import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFirewallRule,
  applyRecommendedVpsRules,
  deleteFirewallRule,
  getFirewallStatus,
  setFirewallActive,
} from '../../src/lib/firewall.js';
import { config } from '../../src/config.js';

const execMock = vi.hoisted(() => ({
  capture: vi.fn(),
}));
vi.mock('../../src/lib/exec.js', () => execMock);

describe('firewall library (src/lib/firewall.ts)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns not installed when not on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const status = await getFirewallStatus();
    expect(status.installed).toBe(false);
    expect(status.active).toBe(false);
    expect(status.supported).toBe(false);
  });

  it('returns not installed when which ufw fails or returns empty on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    execMock.capture.mockRejectedValue(new Error('not found'));
    const status = await getFirewallStatus();
    expect(status.installed).toBe(false);
    expect(status.supported).toBe(true);
  });

  it('parses active UFW status with default policies and numbered rules with comments', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    execMock.capture
      .mockResolvedValueOnce('/usr/sbin/ufw') // which ufw
      .mockResolvedValueOnce(
        'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)'
      ) // ufw status verbose
      .mockResolvedValueOnce(
        'Status: active\n\n     To                         Action      From\n     --                         ------      ----\n[ 1] 22/tcp                     ALLOW IN    Anywhere                   # SSH\n[ 2] 80/tcp                     ALLOW IN    Anywhere                   # HTTP\n[ 3] 5432                       DENY IN     192.168.1.5'
      ); // ufw status numbered

    const status = await getFirewallStatus();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);
    expect(status.defaultIncoming).toBe('deny');
    expect(status.defaultOutgoing).toBe('allow');
    expect(status.rules).toHaveLength(3);
    expect(status.rules[0]).toEqual({
      id: 1,
      to: '22/tcp',
      action: 'ALLOW IN',
      from: 'Anywhere',
      comment: 'SSH',
    });
    expect(status.rules[2]).toEqual({
      id: 3,
      to: '5432',
      action: 'DENY IN',
      from: '192.168.1.5',
      comment: undefined,
    });
  });

  it('parses inactive UFW status with unparseable default line and fallback', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    execMock.capture
      .mockResolvedValueOnce('/usr/sbin/ufw')
      .mockResolvedValueOnce('Status: inactive')
      .mockResolvedValueOnce('Status: inactive');

    const status = await getFirewallStatus();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(false);
    expect(status.defaultIncoming).toBe('allow');
    expect(status.defaultOutgoing).toBe('allow');
    expect(status.rules).toEqual([]);
  });

  it('handles unexpected parse error gracefully', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    execMock.capture.mockResolvedValueOnce('/usr/sbin/ufw');
    execMock.capture.mockImplementationOnce(() => {
      throw new Error('unhandled error');
    });

    const status = await getFirewallStatus();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(false);
    expect(status.rules).toEqual([]);
  });

  it('falls back to sudo when direct ufw execution throws', async () => {
    execMock.capture
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce('Deleted rule');

    await deleteFirewallRule(5);
    expect(execMock.capture).toHaveBeenNthCalledWith(1, 'ufw', ['--force', 'delete', '5']);
    expect(execMock.capture).toHaveBeenNthCalledWith(2, 'sudo', ['ufw', '--force', 'delete', '5']);
  });

  it('adds firewall rules with various options', async () => {
    execMock.capture.mockResolvedValue('Rule added');

    // Rule 1: port + comment + tcp + from
    await addFirewallRule({
      port: 5432,
      proto: 'tcp',
      action: 'allow',
      from: '10.0.0.1/24',
      comment: 'Postgres "Internal"',
    });
    // F348: ufw has no `--comment` option; the comment is the trailing keyword.
    expect(execMock.capture).toHaveBeenCalledWith('ufw', [
      'allow',
      'proto',
      'tcp',
      'from',
      '10.0.0.1/24',
      'to',
      'any',
      'port',
      '5432',
      'comment',
      'Postgres Internal',
    ]);

    // Rule 2: any proto + deny + no from
    await addFirewallRule({
      port: 8080,
      proto: 'any',
      action: 'deny',
      from: 'Anywhere',
    });
    expect(execMock.capture).toHaveBeenCalledWith('ufw', ['deny', '8080']);

    // Rule 3: default action and default proto
    await addFirewallRule({
      port: 3000,
    });
    // F348: the simple form takes no `proto` keyword (`allow proto tcp 3000/tcp`
    // is refused by ufw: "Need 'to' or 'from' clause").
    expect(execMock.capture).toHaveBeenCalledWith('ufw', ['allow', '3000/tcp']);
  });

  it('enables and disables firewall active state safely', async () => {
    execMock.capture.mockResolvedValue('ok');

    await setFirewallActive(true);
    // Should have ensured SSH first then enabled
    expect(execMock.capture).toHaveBeenCalledWith('ufw', expect.arrayContaining(['--force', 'enable']));

    await setFirewallActive(false);
    expect(execMock.capture).toHaveBeenCalledWith('ufw', ['disable']);
  });

  it('applies recommended VPS rules', async () => {
    execMock.capture.mockResolvedValue('ok');

    await applyRecommendedVpsRules();
    expect(execMock.capture).toHaveBeenCalledWith('ufw', expect.arrayContaining(['--force', 'enable']));
  });

  describe('lifeline rules before enable (F348/F349/F350)', () => {
    const orig = { port: config.port, host: config.host };
    beforeEach(() => {
      (config as { port: number }).port = 3000;
      (config as { host: string }).host = '0.0.0.0';
    });
    afterEach(() => {
      (config as { port: number }).port = orig.port;
      (config as { host: string }).host = orig.host;
    });
    const ufwCalls = () =>
      execMock.capture.mock.calls.filter(([cmd]) => cmd === 'ufw').map(([, args]) => (args as string[]).join(' '));

    it('F348/F350: enable allows SSH and the panel port with valid ufw syntax, before enabling', async () => {
      execMock.capture.mockResolvedValue('ok');
      await setFirewallActive(true);
      expect(ufwCalls()).toEqual([
        'allow 22/tcp comment SSH Safety',
        'allow 3000/tcp comment NineDeploy Panel',
        '--force enable',
      ]);

      execMock.capture.mockClear();
      await applyRecommendedVpsRules();
      expect(ufwCalls()).toEqual([
        'allow 22/tcp comment SSH',
        'allow 80/tcp comment HTTP (Traefik Ingress)',
        'allow 443/tcp comment HTTPS (Traefik Ingress)',
        'allow 3000/tcp comment NineDeploy Panel',
        '--force enable',
      ]);
    });

    it('F350: a loopback-bound panel or a panel on 443 adds no extra rule', async () => {
      execMock.capture.mockResolvedValue('ok');
      (config as { host: string }).host = '127.0.0.1';
      await setFirewallActive(true);
      expect(ufwCalls()).toEqual(['allow 22/tcp comment SSH Safety', '--force enable']);

      execMock.capture.mockClear();
      (config as { host: string }).host = '0.0.0.0';
      (config as { port: number }).port = 443;
      await setFirewallActive(true);
      expect(ufwCalls()).toEqual(['allow 22/tcp comment SSH Safety', '--force enable']);
    });

    it('F349: a failed SSH allow aborts the enable instead of locking the operator out', async () => {
      execMock.capture.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('22/tcp')) throw new Error('ERROR: problem running ufw-init');
        return 'ok';
      });
      await expect(setFirewallActive(true)).rejects.toThrow('problem running ufw-init');
      await expect(applyRecommendedVpsRules()).rejects.toThrow('problem running ufw-init');
      const enables = execMock.capture.mock.calls.filter(([, args]) => (args as string[]).includes('enable'));
      expect(enables).toEqual([]);
    });
  });
});
