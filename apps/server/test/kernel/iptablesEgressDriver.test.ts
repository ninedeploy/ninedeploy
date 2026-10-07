import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IptablesEgressDriver } from '../../src/kernel/drivers/iptablesEgressDriver.js';

let runMock: ReturnType<typeof vi.fn>;
let captureMock: ReturnType<typeof vi.fn>;

vi.mock('../../src/lib/exec.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  capture: (...args: unknown[]) => captureMock(...args),
  buildEnv: (extra?: Record<string, string>) => ({ ...(extra ?? {}) }),
}));

let tmpRoot: string;
let driver: IptablesEgressDriver;

beforeEach(() => {
  runMock = vi.fn().mockResolvedValue(undefined);
  captureMock = vi.fn().mockResolvedValue('172.20.0.0/16\n');
  tmpRoot = mkdtempSync(join(tmpdir(), 'nd-egress-'));
  driver = new IptablesEgressDriver({ rootDir: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('IptablesEgressDriver', () => {
  it('exposes the stable "iptables" name', () => {
    expect(driver.name).toBe('iptables');
  });

  it('runs iptables -t nat -I POSTROUTING with the SNAT rule (F228: inserted, not appended)', async () => {
    await driver.attach({ projectId: 7 }, '203.0.113.7');
    const call = runMock.mock.calls.find(
      (c) => c[0] === 'iptables' && c[1]?.[0] === '-t' && c[1]?.[1] === 'nat',
    );
    expect(call).toBeDefined();
    const argv = call?.[1] as string[];
    expect(argv).toContain('-I');
    expect(argv).not.toContain('-A');
    expect(argv).toContain('POSTROUTING');
    expect(argv).toContain('--to-source');
    expect(argv).toContain('203.0.113.7');
    // The comment tag is what makes the rule discoverable for detach.
    expect(argv).toContain('ninedeploy-egress-7');
  });

  it('rejects a non-IPv4 address before touching iptables', async () => {
    await expect(driver.attach({ projectId: 7 }, 'not-an-ip')).rejects.toThrow(/not a valid IPv4/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('persists the rule to a JSON file under the configured root', async () => {
    await driver.attach({ projectId: 7 }, '203.0.113.7');
    const fs = await import('node:fs');
    const text = fs.readFileSync(join(tmpRoot, '7.rules'), 'utf8');
    const parsed = JSON.parse(text) as { ip: string };
    expect(parsed.ip).toBe('203.0.113.7');
  });

  it('rehydrates from on-disk state on construction', async () => {
    writeFileSync(
      join(tmpRoot, '11.rules'),
      JSON.stringify({
        selector: { projectId: 11 },
        ip: '198.51.100.11',
        createdAt: '2026-08-29T00:00:00.000Z',
      }),
    );
    const fresh = new IptablesEgressDriver({ rootDir: tmpRoot });
    const list = await fresh.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.ip).toBe('198.51.100.11');
  });

  it('is idempotent on the same (projectId, ip)', async () => {
    await driver.attach({ projectId: 7 }, '203.0.113.7');
    runMock.mockClear();
    await driver.attach({ projectId: 7 }, '203.0.113.7');
    // No new iptables call — re-apply is a no-op.
    expect(runMock).not.toHaveBeenCalled();
  });

  it('drops the old rule before applying a different ip for the same project', async () => {
    await driver.attach({ projectId: 7 }, '203.0.113.7');
    await driver.attach({ projectId: 7 }, '198.51.100.7');
    const argvList = runMock.mock.calls.map((c) => c[1] as string[]);
    // First call: -I (attach 203.0.113.7)
    // Second call: -D (detach 203.0.113.7)
    // Third call: -I (attach 198.51.100.7)
    const flags = argvList.map((argv) => argv[2]);
    expect(flags).toEqual(['-I', '-D', '-I']);
  });

  it('detach on an unknown project is a no-op', async () => {
    await driver.detach({ projectId: 999 });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('detach on a known project runs iptables -D and scrubs the rule file', async () => {
    await driver.attach({ projectId: 7 }, '203.0.113.7');
    runMock.mockClear();
    await driver.detach({ projectId: 7 });
    const argv = (runMock.mock.calls[0]?.[1] as string[]) ?? [];
    expect(argv).toContain('-D');
    expect(argv).toContain('--to-source');
    expect(argv).toContain('203.0.113.7');
    const list = await driver.list();
    expect(list).toHaveLength(0);
  });

  it('list returns rules sorted by projectId', async () => {
    await driver.attach({ projectId: 30 }, '198.51.100.30');
    await driver.attach({ projectId: 10 }, '198.51.100.10');
    await driver.attach({ projectId: 20 }, '198.51.100.20');
    const list = await driver.list();
    expect(list.map((r) => r.selector.projectId)).toEqual([10, 20, 30]);
  });

  it('detach scrubs the on-disk rules file, not just the in-memory state (r025 regression)', async () => {
    await driver.attach({ projectId: 7 }, '203.0.113.7');
    expect(existsSync(join(tmpRoot, '7.rules'))).toBe(true);
    await driver.detach({ projectId: 7 });
    expect(existsSync(join(tmpRoot, '7.rules'))).toBe(false);
  });

  it('rehydrate skips a corrupt rules file and ignores non-numeric names (r025 regression)', async () => {
    // Half-written file (kernel died mid-write): skipped, valid siblings still load.
    writeFileSync(join(tmpRoot, '21.rules'), '{ not json');
    // Non-numeric file name: not a project rule, ignored.
    writeFileSync(
      join(tmpRoot, 'bogus.rules'),
      JSON.stringify({
        selector: { projectId: 1 },
        ip: '198.51.100.1',
        createdAt: '2026-09-03T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(tmpRoot, '22.rules'),
      JSON.stringify({
        selector: { projectId: 22 },
        ip: '198.51.100.22',
        createdAt: '2026-09-03T00:00:00.000Z',
      }),
    );
    const fresh = new IptablesEgressDriver({ rootDir: tmpRoot });
    const list = await fresh.list();
    expect(list.map((r) => r.selector.projectId)).toEqual([22]);
  });
});

describe('ESM purity (r025 regression)', () => {
  // apps/server is a pure-ESM package ("type": "module", runs as `node dist/server.js`).
  // A lazy `require('node:fs')` inside a driver method throws "ReferenceError: require is
  // not defined" in production, while vitest's module runner shims `require` and keeps
  // this suite green (same class as r007 pgbouncer and r018 oidc). The runtime crash is
  // not observable under vitest, so guard the SOURCE instead.
  it('uses no CJS require() — static node: imports only', () => {
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/kernel/drivers/iptablesEgressDriver.ts',
    );
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

describe('r240: real source networks and reboot re-apply', () => {
  const addCidrs = () =>
    runMock.mock.calls.filter((c) => (c[1] as string[])[2] === '-I').map((c) => (c[1] as string[])[5]);

  it('applies one SNAT rule per resolved service bridge', async () => {
    const d = new IptablesEgressDriver({ rootDir: tmpRoot, resolveCidrs: async () => ['172.21.0.0/16', '172.22.0.0/16'] });
    const rule = await d.attach({ projectId: 3 }, '203.0.113.3');
    expect(addCidrs()).toEqual(['172.21.0.0/16', '172.22.0.0/16']);
    expect(rule.sourceCidrs).toEqual(['172.21.0.0/16', '172.22.0.0/16']);
    // The resolver replaces the dead `ninedeploy_proj_<id>` lookup.
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('detach removes exactly what attach added, even after the networks changed', async () => {
    let cidrs = ['172.21.0.0/16'];
    const d = new IptablesEgressDriver({ rootDir: tmpRoot, resolveCidrs: async () => cidrs });
    await d.attach({ projectId: 3 }, '203.0.113.3');
    cidrs = ['172.30.0.0/16'];
    await d.detach({ projectId: 3 });
    const del = runMock.mock.calls.filter((c) => (c[1] as string[])[2] === '-D').map((c) => (c[1] as string[])[5]);
    expect(del).toEqual(['172.21.0.0/16']);
  });

  it('re-attaches when the project gained a bridge (same IP)', async () => {
    let cidrs = ['172.21.0.0/16'];
    const d = new IptablesEgressDriver({ rootDir: tmpRoot, resolveCidrs: async () => cidrs });
    await d.attach({ projectId: 3 }, '203.0.113.3');
    cidrs = ['172.21.0.0/16', '172.22.0.0/16'];
    await d.attach({ projectId: 3 }, '203.0.113.3');
    expect(addCidrs()).toEqual(['172.21.0.0/16', '172.21.0.0/16', '172.22.0.0/16']);
  });

  it('rolls back the rules already added when a later one is rejected', async () => {
    runMock.mockImplementation(async (_t: string, argv: string[]) => {
      if (argv[2] === '-I' && argv[5] === '172.22.0.0/16') throw new Error('Permission denied');
    });
    const d = new IptablesEgressDriver({ rootDir: tmpRoot, resolveCidrs: async () => ['172.21.0.0/16', '172.22.0.0/16'] });
    await expect(d.attach({ projectId: 3 }, '203.0.113.3')).rejects.toThrow(/Permission denied/);
    const del = runMock.mock.calls.filter((c) => (c[1] as string[])[2] === '-D').map((c) => (c[1] as string[])[5]);
    expect(del).toEqual(['172.21.0.0/16']);
    expect(await d.list()).toEqual([]);
  });

  it('reapply() re-adds persisted rules the kernel lost, and skips present ones', async () => {
    writeFileSync(
      join(tmpRoot, '5.rules'),
      JSON.stringify({ selector: { projectId: 5 }, ip: '198.51.100.5', createdAt: 'x', sourceCidrs: ['172.21.0.0/16', '172.22.0.0/16'] }),
    );
    runMock.mockImplementation(async (_t: string, argv: string[]) => {
      // The first network's rule survived; the second did not.
      if (argv[2] === '-C' && argv[5] === '172.22.0.0/16') throw new Error('Bad rule');
    });
    const d = new IptablesEgressDriver({ rootDir: tmpRoot });
    expect(await d.reapply()).toEqual({ restored: 1, failed: 0 });
    expect(addCidrs()).toEqual(['172.22.0.0/16']);
  });
});

// The fakes below model nat/POSTROUTING as an ordered list of rule specs:
// `-A` appends, `-I` inserts at the top, `-D` removes the first match, `-C`
// checks. No real iptables runs.
describe('F228/F229/F230 regressions', () => {
  const chain: string[] = [];
  const spec = (argv: string[]) => argv.slice(4).join(' ');
  const fakeIptables = (opts: { gate?: Array<() => void>; failDelete?: () => boolean } = {}) =>
    runMock.mockImplementation(async (_t: string, argv: string[]) => {
      const op = argv[2];
      if (op === '-A' || op === '-I') {
        if (opts.gate) await new Promise<void>((r) => opts.gate?.push(r));
        if (op === '-A') chain.push(spec(argv));
        else chain.unshift(spec(argv));
        return;
      }
      if (op === '-D' && opts.failDelete?.()) throw new Error('`iptables` exited with code 4');
      const i = chain.indexOf(spec(argv));
      if (i < 0) throw new Error('`iptables` exited with code 1');
      if (op === '-D') chain.splice(i, 1);
    });
  const flush = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };

  beforeEach(() => {
    chain.length = 0;
  });

  it('F228: the SNAT rule lands ahead of the MASQUERADE rule Docker inserted for the bridge', async () => {
    fakeIptables();
    const masq = '-s 172.21.0.0/16 ! -o br-nd-svc-web -j MASQUERADE';
    chain.push(masq); // `docker network create` already ran
    const d = new IptablesEgressDriver({ rootDir: tmpRoot, resolveCidrs: async () => ['172.21.0.0/16'] });
    await d.attach({ projectId: 1 }, '203.0.113.1');
    // nat/POSTROUTING is first-match and MASQUERADE is terminating.
    expect(chain[0]).toContain('--to-source 203.0.113.1');
    expect(chain[1]).toBe(masq);
    // Same after a reboot: dockerd re-creates its rule before reapply() runs.
    chain.splice(0, chain.length, masq);
    const fresh = new IptablesEgressDriver({ rootDir: tmpRoot });
    expect(await fresh.reapply()).toEqual({ restored: 1, failed: 0 });
    expect(chain[0]).toContain('--to-source 203.0.113.1');
  });

  it('F229: overlapping attach() calls for one project leave one kernel rule, which detach() removes', async () => {
    const gate: Array<() => void> = [];
    fakeIptables({ gate });
    const d = new IptablesEgressDriver({ rootDir: tmpRoot, resolveCidrs: async () => ['172.21.0.0/16'] });
    const a = d.attach({ projectId: 4 }, '203.0.113.4');
    const b = d.attach({ projectId: 4 }, '198.51.100.4');
    await flush();
    expect(gate).toHaveLength(1); // the second call is queued behind the first
    while (gate.length > 0) {
      gate.shift()?.();
      await flush();
    }
    await Promise.all([a, b]);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toContain('--to-source 198.51.100.4');
    expect((await d.list()).map((r) => r.ip)).toEqual(['198.51.100.4']);
    await d.detach({ projectId: 4 });
    expect(chain).toEqual([]);
  });

  it('F230: a delete that fails while the rule is still live keeps it tracked; a gone rule is scrubbed', async () => {
    let lockHeld = false;
    fakeIptables({ failDelete: () => lockHeld });
    const d = new IptablesEgressDriver({ rootDir: tmpRoot, resolveCidrs: async () => ['172.21.0.0/16'] });
    await d.attach({ projectId: 6 }, '203.0.113.6');
    lockHeld = true;
    await expect(d.detach({ projectId: 6 })).rejects.toThrow(/-D POSTROUTING failed for project 6/);
    expect(chain).toHaveLength(1);
    expect(await d.list()).toHaveLength(1);
    expect(existsSync(join(tmpRoot, '6.rules'))).toBe(true);
    // Rule flushed out from under us: scrubbing is right.
    lockHeld = false;
    chain.length = 0;
    await d.detach({ projectId: 6 });
    expect(await d.list()).toEqual([]);
    expect(existsSync(join(tmpRoot, '6.rules'))).toBe(false);
  });
});
