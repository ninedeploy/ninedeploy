import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { egressClear, egressClearAction, egressListAction, egressSet, egressSetAction } from '../src/commands/egress.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  headerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', () => ({
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

interface FakeEgress {
  list: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

function newClient(): { egress: FakeEgress } {
  return { egress: { list: vi.fn(), set: vi.fn(), clear: vi.fn() } };
}

let savedExitCode: number | undefined;
beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  h.errorSpy.mockReset();
  h.infoSpy.mockReset();
  h.successSpy.mockReset();
  h.headerSpy.mockReset();
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe('egress list', () => {
  it('prints a hint when no drivers are registered', async () => {
    const client = newClient();
    (client.egress.list as ReturnType<typeof vi.fn>).mockResolvedValue({ drivers: [] });
    await egressListAction(client as never);
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No egress IP drivers/));
  });

  it('prints per-driver and per-rule lines on the happy path', async () => {
    const client = newClient();
    (client.egress.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      drivers: [
        {
          name: 'iptables',
          rules: [
            { selector: { projectId: 7 }, ip: '203.0.113.7', createdAt: '2026-08-29T10:00:00.000Z' },
          ],
        },
      ],
    });
    await egressListAction(client as never);
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Driver: iptables');
    expect(printed).toContain('project 7 → 203.0.113.7');
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.egress.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    await egressListAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('denied');
    expect(process.exitCode).toBe(1);
  });
});

describe('egress set', () => {
  it('forwards (projectId, ip, driver) to the SDK', async () => {
    const client = newClient();
    (client.egress.set as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      driver: 'iptables',
      rule: { selector: { projectId: 7 }, ip: '203.0.113.7', createdAt: '2026-08-29T10:00:00.000Z' },
    });
    const result = await egressSet(client as never, 7, '203.0.113.7', 'iptables');
    expect(result.driver).toBe('iptables');
    expect(client.egress.set).toHaveBeenCalledWith({ projectId: 7, ip: '203.0.113.7', driver: 'iptables' });
  });

  it('prints a success line on the happy path', async () => {
    const client = newClient();
    (client.egress.set as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      driver: 'iptables',
      rule: { selector: { projectId: 7 }, ip: '203.0.113.7', createdAt: '2026-08-29T10:00:00.000Z' },
    });
    await egressSetAction(client as never, '7', '203.0.113.7', {});
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/attached to project 7 via iptables/));
  });

  it('refuses non-numeric projectId and sets exitCode=1', async () => {
    const client = newClient();
    await egressSetAction(client as never, 'abc', '203.0.113.7', {});
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.egress.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('iptables failed'));
    await egressSetAction(client as never, '7', '203.0.113.7', {});
    expect(h.errorSpy).toHaveBeenCalledWith('iptables failed');
    expect(process.exitCode).toBe(1);
  });
});

describe('egress clear', () => {
  it('forwards the projectId to the SDK', async () => {
    const client = newClient();
    (client.egress.clear as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, driver: 'iptables' });
    const result = await egressClear(client as never, 7);
    expect(result.driver).toBe('iptables');
    expect(client.egress.clear).toHaveBeenCalledWith(7);
  });

  it('prints a success line on the happy path', async () => {
    const client = newClient();
    (client.egress.clear as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, driver: 'iptables' });
    await egressClearAction(client as never, '7');
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/cleared for project 7 via iptables/));
  });

  it('r198: reports an { ok: false } refusal instead of crashing', async () => {
    const client = newClient();
    (client.egress.set as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'Egress IP driver "iptables" is not registered' });
    await egressSetAction(client as never, '7', '203.0.113.7', {});
    expect(h.errorSpy).toHaveBeenCalledWith('Egress IP driver "iptables" is not registered');
    expect(h.successSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    (client.egress.clear as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'No egress IP driver is registered' });
    process.exitCode = 0;
    await egressClearAction(client as never, '7');
    expect(h.errorSpy).toHaveBeenCalledWith('No egress IP driver is registered');
    expect(process.exitCode).toBe(1);
  });

  it('r199: forwards --driver on clear', async () => {
    const client = newClient();
    (client.egress.clear as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, driver: 'cloud-nat' });
    await egressClearAction(client as never, '7', { driver: 'cloud-nat' });
    expect(client.egress.clear).toHaveBeenCalledWith(7, 'cloud-nat');
  });

  it('refuses non-numeric projectId and sets exitCode=1', async () => {
    const client = newClient();
    await egressClearAction(client as never, 'abc');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });
});
