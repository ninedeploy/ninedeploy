import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipsForgetAction, ipsListAction, ipsPatch, ipsSetAction } from '../src/commands/hostIps.js';

/** 0.16.1 `ninedeploy ips`: list, set (label / primary / dedicate / share), forget. */

const h = vi.hoisted(() => ({ errorSpy: vi.fn(), infoSpy: vi.fn(), successSpy: vi.fn(), headerSpy: vi.fn() }));
vi.mock('../src/lib/format.js', () => ({
  c: { green: (s: string) => s },
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

const client = () => ({ hostIps: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } });
const entry = {
  ip: '203.0.113.7', family: 4, iface: 'eth0', detected: true, label: 'game', primary: true, dedicatedTo: { id: 5, name: 'voice' },
};

let savedExitCode: number | undefined;
beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe('ips list', () => {
  it('prints each address with its interface, primary mark, label and dedication', async () => {
    const cl = client();
    cl.hostIps.list.mockResolvedValue({ detected: true, addresses: [entry, { ...entry, ip: '10.0.0.5', iface: null, detected: false, primary: false, label: null, dedicatedTo: null }] });
    await ipsListAction(cl as never);
    const lines = h.infoSpy.mock.calls.map((c) => c[0] as string);
    expect(lines[0]).toMatch(/203\.0\.113\.7 +eth0 +primary {2}"game" {2}dedicated to voice \(#5\)/);
    expect(lines[1]).toMatch(/10\.0\.0\.5 +not detected +shared/);
  });

  it('says when the host could not be read or has no address, and reports errors', async () => {
    const cl = client();
    cl.hostIps.list.mockResolvedValue({ detected: false, addresses: [] });
    await ipsListAction(cl as never);
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/could not be read/));
    expect(h.infoSpy).toHaveBeenCalledWith('No public or LAN address found.');
    cl.hostIps.list.mockRejectedValue('denied');
    await ipsListAction(cl as never);
    expect(h.errorSpy).toHaveBeenCalledWith('denied');
    expect(process.exitCode).toBe(1);
  });
});

describe('ips set', () => {
  it('builds the patch from the flags', () => {
    expect(ipsPatch({ label: ' edge ', primary: true, service: '5' })).toEqual({ label: 'edge', primary: true, serviceId: 5 });
    expect(ipsPatch({ label: '' })).toEqual({ label: null });
    expect(ipsPatch({ shared: true })).toEqual({ serviceId: null });
    expect(() => ipsPatch({})).toThrow(/Nothing to change/);
    expect(() => ipsPatch({ service: '5', shared: true })).toThrow(/not both/);
    expect(() => ipsPatch({ service: 'voice' })).toThrow(/service id/);
  });

  it('sends it and prints the saved address; an error sets exitCode', async () => {
    const cl = client();
    cl.hostIps.set.mockResolvedValue(entry);
    await ipsSetAction(cl as never, '203.0.113.7', { primary: true });
    expect(cl.hostIps.set).toHaveBeenCalledWith('203.0.113.7', { primary: true });
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/203\.0\.113\.7/));
    cl.hostIps.set.mockResolvedValue(null);
    await ipsSetAction(cl as never, '203.0.113.8', { label: 'x' });
    expect(h.successSpy).toHaveBeenCalledWith('203.0.113.8 saved');
    await ipsSetAction(cl as never, '203.0.113.8');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Nothing to change/));
    expect(process.exitCode).toBe(1);
  });
});

describe('ips forget', () => {
  it('removes the saved settings, or reports why not', async () => {
    const cl = client();
    cl.hostIps.remove.mockResolvedValue({ ok: true });
    await ipsForgetAction(cl as never, '10.0.0.5');
    expect(h.successSpy).toHaveBeenCalledWith('10.0.0.5 forgotten');
    cl.hostIps.remove.mockRejectedValue(new Error('No saved settings for that address'));
    await ipsForgetAction(cl as never, '10.0.0.6');
    expect(h.errorSpy).toHaveBeenCalledWith('No saved settings for that address');
    expect(process.exitCode).toBe(1);
  });
});
