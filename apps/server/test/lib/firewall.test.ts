import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFirewallRule,
  applyRecommendedVpsRules,
  deleteFirewallRule,
  getFirewallStatus,
  setFirewallActive,
} from '../../src/lib/firewall.js';

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
    expect(execMock.capture).toHaveBeenCalledWith('ufw', [
      '--comment',
      'Postgres Internal',
      'allow',
      'proto',
      'tcp',
      'from',
      '10.0.0.1/24',
      'to',
      'any',
      'port',
      '5432',
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
    expect(execMock.capture).toHaveBeenCalledWith('ufw', ['allow', 'proto', 'tcp', '3000/tcp']);
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
});
