import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  firewallStatus,
  firewallToggle,
  firewallAddRule,
  firewallDeleteRule,
  firewallApplyRecommended,
} from '../src/commands/firewall.js';

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cli firewall commands', () => {
  it('displays status with active rules and comments', async () => {
    const client = {
      firewall: {
        status: vi.fn().mockResolvedValue({
          installed: true,
          active: true,
          defaultIncoming: 'deny',
          defaultOutgoing: 'allow',
          rules: [
            { id: 1, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'SSH' },
            { id: 2, to: '80/tcp', action: 'DENY IN', from: 'Anywhere' },
          ],
        }),
      },
    };
    await firewallStatus(client as never);
    expect(client.firewall.status).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Active (Protecting)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('22/tcp'));
  });

  it('displays status with inactive state and not installed', async () => {
    const client = {
      firewall: {
        status: vi.fn().mockResolvedValue({
          installed: false,
          active: false,
          defaultIncoming: 'deny',
          defaultOutgoing: 'allow',
          rules: [],
        }),
      },
    };
    await firewallStatus(client as never);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Inactive'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No active port rules configured'));
  });

  it('handles error in firewall status with Error and non-Error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const clientErr = { firewall: { status: vi.fn().mockRejectedValue(new Error('err obj')) } };
    await firewallStatus(clientErr as never);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('err obj'));

    const clientStr = { firewall: { status: vi.fn().mockRejectedValue('err str') } };
    await firewallStatus(clientStr as never);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('err str'));
    expect(exitSpy).toHaveBeenCalled();
  });

  it('toggles firewall state', async () => {
    const client = {
      firewall: {
        toggle: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    await firewallToggle(client as never, true);
    expect(client.firewall.toggle).toHaveBeenCalledWith(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('enabled'));

    await firewallToggle(client as never, false);
    expect(client.firewall.toggle).toHaveBeenCalledWith(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('handles error in toggle with Error and non-Error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const clientErr = { firewall: { toggle: vi.fn().mockRejectedValue(new Error('toggle err obj')) } };
    await firewallToggle(clientErr as never, true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('toggle err obj'));

    const clientStr = { firewall: { toggle: vi.fn().mockRejectedValue('toggle err str') } };
    await firewallToggle(clientStr as never, false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('toggle err str'));
    expect(exitSpy).toHaveBeenCalled();
  });

  it('adds a firewall rule with custom options', async () => {
    const client = {
      firewall: {
        addRule: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    await firewallAddRule(client as never, '5432', { proto: 'tcp', action: 'allow', from: '192.168.1.1', comment: 'DB' });
    expect(client.firewall.addRule).toHaveBeenCalledWith({
      port: '5432',
      proto: 'tcp',
      action: 'allow',
      from: '192.168.1.1',
      comment: 'DB',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rule added'));
  });

  it('adds a firewall rule with default options', async () => {
    const client = {
      firewall: {
        addRule: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    await firewallAddRule(client as never, '8080', {});
    expect(client.firewall.addRule).toHaveBeenCalledWith({
      port: '8080',
      proto: 'tcp',
      action: 'allow',
      from: undefined,
      comment: undefined,
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rule added'));
  });

  it('handles error in addRule with Error and non-Error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const clientErr = { firewall: { addRule: vi.fn().mockRejectedValue(new Error('add err obj')) } };
    await firewallAddRule(clientErr as never, '99999', {});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('add err obj'));

    const clientStr = { firewall: { addRule: vi.fn().mockRejectedValue('add err str') } };
    await firewallAddRule(clientStr as never, '99999', {});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('add err str'));
    expect(exitSpy).toHaveBeenCalled();
  });

  it('deletes a firewall rule', async () => {
    const client = {
      firewall: {
        deleteRule: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    await firewallDeleteRule(client as never, '2');
    expect(client.firewall.deleteRule).toHaveBeenCalledWith('2');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rule 2 deleted'));
  });

  it('handles error in deleteRule with Error and non-Error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const clientErr = { firewall: { deleteRule: vi.fn().mockRejectedValue(new Error('del err obj')) } };
    await firewallDeleteRule(clientErr as never, '99');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('del err obj'));

    const clientStr = { firewall: { deleteRule: vi.fn().mockRejectedValue('del err str') } };
    await firewallDeleteRule(clientStr as never, '99');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('del err str'));
    expect(exitSpy).toHaveBeenCalled();
  });

  it('applies recommended VPS firewall profile', async () => {
    const client = {
      firewall: {
        applyRecommended: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    await firewallApplyRecommended(client as never);
    expect(client.firewall.applyRecommended).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Recommended VPS firewall profile applied'));
  });

  it('handles error in applyRecommended with Error and non-Error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const clientErr = { firewall: { applyRecommended: vi.fn().mockRejectedValue(new Error('rec err obj')) } };
    await firewallApplyRecommended(clientErr as never);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rec err obj'));

    const clientStr = { firewall: { applyRecommended: vi.fn().mockRejectedValue('rec err str') } };
    await firewallApplyRecommended(clientStr as never);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rec err str'));
    expect(exitSpy).toHaveBeenCalled();
  });
});
