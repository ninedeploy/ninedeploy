/** The panel's own domain does not depend on the address its port is published on. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
const net = vi.hoisted(() => ({ inContainer: true, onNetwork: false, join: vi.fn<() => Promise<boolean>>() }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/panelUpstream.js', async (original) => ({
  ...(await original<typeof import('../src/lib/panelUpstream.js')>()),
  panelRunsInContainer: () => net.inContainer,
  detectPanelOnNetwork: async () => net.onNetwork,
  joinPanelNetwork: net.join,
}));
vi.mock('../src/lib/traefikCustomConfig.js', () => ({ materialiseCustomConfig: async () => undefined }));
vi.mock('../src/engine/proxy.js', async (original) => ({
  ...(await original<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined), ensureNetwork: async () => undefined, ensureTraefik: async () => false,
  traefikInputs: async () => ({}), materialiseCertificatesFile: async () => undefined,
}));
const { writeDynamicConfig } = await import('../src/engine/proxy.js');
const { setSettingString } = await import('../src/lib/settings.js');
const { default: traefikPlugin } = await import('../src/plugins/traefik.js');
const { buildTestApp } = await import('./helpers.js');
const { migratedDb, closeMigratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  net.inContainer = true; net.onNetwork = false;
  net.join.mockReset().mockResolvedValue(true);
  vi.mocked(writeDynamicConfig).mockClear();
  delete process.env['NINEDEPLOY_DOMAIN'];
});
afterEach(() => { delete process.env['NINEDEPLOY_DOMAIN']; closeMigratedDb(db); });

const boot = async () => { const a = await buildTestApp({ db }); await a.register(traefikPlugin); await a.ready(); return a; };

describe('the proxy plugin and the panel domain', () => {
  it('joins the proxy network at boot before the routes are written, once a panel domain is set', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    const a = await boot();
    try {
      expect(net.join).toHaveBeenCalledTimes(1);
      expect(net.join.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(writeDynamicConfig).mock.invocationCallOrder[0]!);
    } finally { await a.close(); }
  });

  it('also for a domain saved under Settings, and not at all without one', async () => {
    const a = await boot();
    try { expect(net.join).not.toHaveBeenCalled(); } finally { await a.close(); }
    await setSettingString(db, 'panel_domain', 'panel.example.com');
    const b = await boot();
    try { expect(net.join).toHaveBeenCalledTimes(1); } finally { await b.close(); }
  });

  it('never outside a container, and never when the panel is on the network already', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    net.inContainer = false;
    const a = await boot();
    try { expect(net.join).not.toHaveBeenCalled(); } finally { await a.close(); }
    net.inContainer = true; net.onNetwork = true;
    const b = await boot();
    try { expect(net.join).not.toHaveBeenCalled(); } finally { await b.close(); }
  });

  it('a boot that could not join retries from the watchdog and writes the routes again', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    net.join.mockResolvedValue(false);
    vi.useFakeTimers();
    try {
      const a = await boot();
      try {
        expect(net.join).toHaveBeenCalledTimes(1);
        expect(writeDynamicConfig).toHaveBeenCalledTimes(1);
        net.join.mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(net.join).toHaveBeenCalledTimes(2);
        expect(writeDynamicConfig).toHaveBeenCalledTimes(2);
      } finally { await a.close(); }
    } finally { vi.useRealTimers(); }
  });
});
