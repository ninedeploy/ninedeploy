import { describe, expect, it, vi } from 'vitest';
import { firewallRoutes } from '../src/modules/firewall.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const firewallMock = vi.hoisted(() => ({
  getFirewallStatus: vi.fn(async () => ({
    installed: true,
    active: true,
    supported: true,
    rules: [
      { id: 1, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'SSH' },
      { id: 2, to: '80/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'HTTP' },
      { id: 3, to: '443/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'HTTPS' },
    ],
    defaultIncoming: 'deny',
    defaultOutgoing: 'allow',
  })),
  addFirewallRule: vi.fn(async () => undefined),
  deleteFirewallRule: vi.fn(async () => undefined),
  setFirewallActive: vi.fn(async () => undefined),
  applyRecommendedVpsRules: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/firewall.js', () => firewallMock);

describe('firewall routes (admin-only)', () => {
  it('returns current firewall status and rules', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(firewallRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.installed).toBe(true);
    expect(body.active).toBe(true);
    expect(body.rules).toHaveLength(3);
    await app.close();
  });

  it('toggles firewall active state', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(firewallRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/toggle',
      headers: asUser(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(firewallMock.setFirewallActive).toHaveBeenCalledWith(true);
    await app.close();
  });

  it('adds a new firewall rule', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(firewallRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/rules',
      headers: asUser(),
      payload: { port: 5432, proto: 'tcp', action: 'allow', from: '192.168.1.0/24', comment: 'PostgreSQL' },
    });
    expect(res.statusCode).toBe(200);
    expect(firewallMock.addFirewallRule).toHaveBeenCalledWith({
      port: 5432,
      proto: 'tcp',
      action: 'allow',
      from: '192.168.1.0/24',
      comment: 'PostgreSQL',
    });
    await app.close();
  });

  it('deletes a firewall rule by id', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(firewallRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/rules/2',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(firewallMock.deleteFirewallRule).toHaveBeenCalledWith('2');
    await app.close();
  });

  it('applies recommended VPS firewall profile', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(firewallRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/recommended',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(firewallMock.applyRecommendedVpsRules).toHaveBeenCalled();
    await app.close();
  });
});
