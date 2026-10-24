import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { domains, services } from '@ninedeploy/db';
import { load } from 'js-yaml';
import { ProxyRoutingUnconfirmed } from '../src/lib/proxyRoutingAck.js';
import { observabilityDb } from './fixtures/observability.js';

const io = vi.hoisted(() => ({ capture: vi.fn(async (..._args: unknown[]) => ''), sleep: vi.fn(async (_ms: number) => {}), config: { paths: { dataDir: '' }, acmeEmail: null } }));
vi.mock('../src/lib/exec.js', () => ({ capture: io.capture, sleep: io.sleep, run: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: io.config }));
const { writeDynamicConfig } = await import('../src/engine/proxy.js');
const fixtures: Awaited<ReturnType<typeof observabilityDb>>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers(); vi.resetAllMocks();
});
async function fixture() {
  const f = await observabilityDb(); fixtures.push(f);
  const dir = mkdtempSync(path.join(tmpdir(), 'nd-route-ack-')); dirs.push(dir); io.config.paths.dataDir = dir;
  await f.db.update(services).set({ port: 3000 });
  await f.db.insert(domains).values({ serviceId: 1, hostname: 'web.example.test', status: 'active', ssl: false });
  return { ...f, dir };
}
function observed(dir: string): Record<string, unknown> {
  const routes = load(readFileSync(path.join(dir, 'traefik/dynamic/ninedeploy.yml'), 'utf8')) as { http: Record<string, Record<string, unknown>> };
  return Object.fromEntries(['routers', 'services', 'middlewares'].map(kind => [kind, Object.fromEntries(
    Object.entries(routes.http[kind] ?? {}).map(([name, cfg]) => [`${name}@file`, { ...(cfg as object), status: 'enabled' }]),
  )]));
}
function response(dir: string, body = observed(dir)): string {
  const cfg = load(readFileSync(path.join(dir, 'traefik/dynamic/ninedeploy.yml'), 'utf8')) as { http: { middlewares: { nd_routing_generation: { headers: { customResponseHeaders: Record<string, string> } } } } };
  return `HTTP/1.1 200 OK\nX-NineDeploy-Generation: ${cfg.http.middlewares.nd_routing_generation.headers.customResponseHeaders['X-NineDeploy-Generation']}\n\n${JSON.stringify(body)}`;
}
describe('proxy routing acknowledgement', () => {
  it('reads the loaded router state before accepting a requested routing transition', async () => {
    const f = await fixture();
    io.capture.mockImplementation(async () => response(f.dir));
    await writeDynamicConfig(f.db, { confirmServiceId: 1 } as never);
    expect(io.capture).toHaveBeenCalledWith('docker', expect.arrayContaining(['exec', 'ninedeploy-traefik']), expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(io.capture).toHaveBeenCalledTimes(2);
  });

  it.each(['handler generation', 'disabled router', 'old replica', 'TLS handler generation'] as const)('waits for the %s to converge', async problem => {
    const f = await fixture(); let calls = 0;
    io.capture.mockImplementation(async () => {
      calls++;
      const stale = problem === 'TLS handler generation' ? calls === 2 : calls === 1;
      const body = observed(f.dir);
      if (stale && problem === 'disabled router') (body.routers as Record<string, { status: string }>)['web_1@file']!.status = 'disabled';
      if (stale && problem === 'old replica') {
        const sv = Object.values(body.services as Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>)[0]!;
        sv.loadBalancer.servers.push({ url: 'http://old-r2:3000' });
      }
      let raw = response(f.dir, body);
      if (stale && problem.includes('generation')) raw = raw.replace(/(X-NineDeploy-Generation: )[a-f0-9]{64}/, `$1${'0'.repeat(64)}`);
      return raw;
    });
    await writeDynamicConfig(f.db, { confirmServiceId: 1 });
    expect(calls).toBe(problem === 'TLS handler generation' ? 4 : 3);
    expect(io.sleep).toHaveBeenCalledTimes(1);
  });

  it('bounds an unavailable API without exposing its private response', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    io.sleep.mockImplementation(async ms => { vi.setSystemTime(Date.now() + ms); });
    io.capture.mockRejectedValue(new Error('private fixture credential'));
    const error = await writeDynamicConfig(f.db, { confirmServiceId: 1 }).catch(e => e);
    expect(error).toBeInstanceOf(ProxyRoutingUnconfirmed);
    expect(error.message).not.toContain('private fixture credential');
    expect(io.capture.mock.calls.length).toBeLessThanOrEqual(60);
  });

  it('does not require Docker for an unrouted worker or an ordinary config edit', async () => {
    const f = await fixture();
    await f.db.update(services).set({ port: null });
    await writeDynamicConfig(f.db, { confirmServiceId: 1 });
    await writeDynamicConfig(f.db);
    expect(io.capture).not.toHaveBeenCalled();
    expect(readFileSync(path.join(f.dir, 'traefik/dynamic/ninedeploy.yml'), 'utf8')).not.toContain('nd_routing_ack');
  });

  it('does not write a queued transition whose controller has already stopped', async () => {
    const f = await fixture(), signal = AbortSignal.abort();
    await expect(writeDynamicConfig(f.db, { confirmServiceId: 1, signal })).rejects.toBeInstanceOf(ProxyRoutingUnconfirmed);
    expect(existsSync(path.join(f.dir, 'traefik/dynamic/ninedeploy.yml'))).toBe(false);
    expect(io.capture).not.toHaveBeenCalled();
  });
});
