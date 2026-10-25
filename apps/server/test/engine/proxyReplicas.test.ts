import { describe, expect, it, vi } from 'vitest';
import { domains, serviceTargets, services } from '@ninedeploy/db';
import { renderDynamicConfig } from '../../src/engine/proxy.js';

/**
 * The proxy must render the replica count the last deploy ACHIEVED
 * (services.runtimeReplicas), never the desired one (services.replicas): a
 * replica that failed to start — or the window between saving a higher count
 * and the next deploy — must not become an unresolvable round-robin backend
 * answering 502s for its share of requests.
 */
vi.mock('../../src/config.js', () => ({
  config: { paths: { dataDir: '' }, acmeEmail: null, dnsProvider: '', dnsToken: null },
}));

const makeDb = (domainRows: unknown[], serviceRows: unknown[], targetRows: unknown[] = []) => ({
  select: vi.fn(() => ({
    from: vi.fn((t: unknown) => {
      const resolve = async () => {
        if (t === domains) return domainRows;
        if (t === services) return serviceRows;
        if (t === serviceTargets) return targetRows;
        return [];
      };
      const pending = Promise.resolve().then(resolve);
      return Object.assign(pending, { where: async () => resolve() });
    }),
  })),
});

const domainRow = { id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: false, status: 'active' };

describe('renderDynamicConfig replica backends', () => {
  it('renders only what runs: a desired-but-not-yet-achieved count stays one backend', async () => {
    // The user saved replicas=3 in the Scaling card ("applied on next
    // deploy") — or a replica failed to start. Either way only the primary
    // exists; listing web-1-r2/-r3 would blackhole 2/3 of the traffic.
    const db = makeDb(
      [domainRow],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1', type: 'docker', replicas: 3, runtimeReplicas: 1 }],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(yaml).toContain('url: "http://web-1:3000"');
    expect(yaml).not.toContain('-r2');
    expect(yaml).not.toContain('healthCheck:');
  });

  it('renders every achieved replica plus the health check once the deploy recorded them', async () => {
    const db = makeDb(
      [domainRow],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1', type: 'docker', replicas: 3, runtimeReplicas: 3 }],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(yaml).toContain('url: "http://web-1:3000"');
    expect(yaml).toContain('url: "http://web-1-r2:3000"');
    expect(yaml).toContain('url: "http://web-1-r3:3000"');
    expect(yaml).toContain('healthCheck:');
  });

  it('a partial achievement renders exactly the live replicas', async () => {
    // The deploy wanted 3, one replica failed to start and the builder
    // reported 2 — the config must not list the dead third.
    const db = makeDb(
      [domainRow],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1', type: 'docker', replicas: 3, runtimeReplicas: 2 }],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(yaml).toContain('url: "http://web-1-r2:3000"');
    expect(yaml).not.toContain('web-1-r3');
  });
});


describe('fan-out replica placement', () => {
  it.each([2, 10, null])('routes only the one container created on a target when primary runtimeReplicas=%s', async runtimeReplicas => {
    const db = makeDb([domainRow], [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', replicas: 3, runtimeReplicas }],
      [{ id: 42, serviceId: 1, serverId: 5, runtimeId: 'web-t5-7', status: 'running' }]);
    const yaml = await renderDynamicConfig(db as never, { serverId: 5 });
    expect(yaml).toContain('url: "http://web-t5-7:3000"');
    expect(yaml).not.toContain('web-t5-7-r2');
    expect(yaml.match(/- url:/g)).toHaveLength(1);
    expect(yaml).not.toContain('web-9');
  });

  it('keeps every achieved primary-node replica when the service also has other placements', async () => {
    const db = makeDb([domainRow], [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', replicas: 3, runtimeReplicas: 2 }]);
    const yaml = await renderDynamicConfig(db as never, { serverId: 4 });
    expect(yaml).toContain('url: "http://web-9:3000"');
    expect(yaml).toContain('url: "http://web-9-r2:3000"');
    expect(yaml).not.toContain('web-9-r3');
  });
});
