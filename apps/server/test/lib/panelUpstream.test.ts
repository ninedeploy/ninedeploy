import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.11: how Traefik reaches the panel itself (its wake endpoint, and since
 * the panel domain followed suit, the router of that domain). The probe runs
 * inside the Traefik container; the panel container joins the network when
 * something needs the alias: a panel domain at boot, or the wake endpoint
 * when the host address does not work. No real docker: exec and the container
 * check are faked.
 */

const h = vi.hoisted(() => ({
  capture: vi.fn(async (..._a: unknown[]): Promise<string> => ''),
  inContainer: { value: true },
}));
vi.mock('../../src/lib/exec.js', () => ({ capture: h.capture }));
vi.mock('../../src/config.js', () => ({ config: { port: 3000 } }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: (p: string) => (p === '/.dockerenv' ? h.inContainer.value : false),
}));
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, default: { ...os, hostname: () => 'abc123' } };
});

const P = await import('../../src/lib/panelUpstream.js');

const argsOf = () => h.capture.mock.calls.map((c) => (c[1] as string[]).join(' '));

beforeEach(() => {
  h.capture.mockReset();
  h.capture.mockResolvedValue('');
  h.inContainer.value = true;
  P.resetPanelUpstream();
});

describe('wakeUnreachableReason', () => {
  it('is null when Traefik reaches the host address, and caches the answer', async () => {
    expect(await P.wakeUnreachableReason(0)).toBeNull();
    expect(argsOf()).toEqual(['exec ninedeploy-traefik wget -q -O /dev/null -T 3 http://host.docker.internal:3000/health']);
    expect(await P.wakeUnreachableReason(60_000)).toBeNull();
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(P.traefikPanelUpstream()).toBe('http://host.docker.internal:3000');
  });

  it('joins the panel container to the network when the host address fails, then uses its alias', async () => {
    h.capture.mockImplementation(async (_cmd: unknown, args: unknown) => {
      if ((args as string[]).includes('http://host.docker.internal:3000/health')) throw new Error('wget: can\'t connect');
      return '';
    });
    expect(await P.wakeUnreachableReason(0)).toBeNull();
    expect(argsOf()).toEqual([
      'exec ninedeploy-traefik wget -q -O /dev/null -T 3 http://host.docker.internal:3000/health',
      'network connect --alias ninedeploy-panel ninedeploy abc123',
      'exec ninedeploy-traefik wget -q -O /dev/null -T 3 http://ninedeploy-panel:3000/health',
    ]);
    expect(P.traefikPanelUpstream()).toBe('http://ninedeploy-panel:3000');
  });

  it('a join that fails because it is attached already reads the attachment back', async () => {
    h.capture.mockImplementation(async (_cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (a.includes('http://host.docker.internal:3000/health')) throw new Error('no route');
      if (a[0] === 'network') throw new Error('endpoint with name abc123 already exists in network ninedeploy');
      if (a[0] === 'inspect') return '{"Aliases":["ninedeploy-panel","abc123"]}';
      return '';
    });
    expect(await P.wakeUnreachableReason(0)).toBeNull();
    expect(P.traefikPanelUpstream()).toBe('http://ninedeploy-panel:3000');
  });

  it('names the problem when nothing reaches the panel, and retries after a minute', async () => {
    h.capture.mockRejectedValue(new Error('down'));
    const reason = await P.wakeUnreachableReason(0);
    expect(reason).toMatch(/^Traefik cannot reach the panel at http:\/\/host\.docker\.internal:3000, so a sleeping service could not wake\./);
    const calls = h.capture.mock.calls.length;
    expect(await P.wakeUnreachableReason(30_000)).toBe(reason);
    expect(h.capture.mock.calls.length).toBe(calls);
    await P.wakeUnreachableReason(61_000);
    expect(h.capture.mock.calls.length).toBeGreaterThan(calls);
  });

  it('outside a container it never tries to join', async () => {
    h.inContainer.value = false;
    h.capture.mockRejectedValue(new Error('down'));
    expect(await P.wakeUnreachableReason(0)).not.toBeNull();
    expect(argsOf()).toEqual(['exec ninedeploy-traefik wget -q -O /dev/null -T 3 http://host.docker.internal:3000/health']);
  });
});

describe('joinPanelNetwork', () => {
  it('joins under the alias once, and the panel is then reached by it', async () => {
    expect(P.panelOnNetwork()).toBe(false);
    expect(await P.joinPanelNetwork()).toBe(true);
    expect(await P.joinPanelNetwork()).toBe(true);
    expect(argsOf()).toEqual(['network connect --alias ninedeploy-panel ninedeploy abc123']);
    expect(P.panelOnNetwork()).toBe(true);
    expect(P.traefikPanelUpstream()).toBe('http://ninedeploy-panel:3000');
  });

  it('a join Docker refuses is read back: attached already, or not at all', async () => {
    h.capture.mockImplementation(async (_cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (a[0] === 'network') throw new Error('endpoint with name abc123 already exists in network ninedeploy');
      if (a[0] === 'inspect') return '{"Aliases":["ninedeploy-panel"]}';
      return '';
    });
    expect(await P.joinPanelNetwork()).toBe(true);
    P.resetPanelUpstream();
    h.capture.mockImplementation(async (_cmd: unknown, args: unknown) => {
      if ((args as string[])[0] === 'network') throw new Error('network ninedeploy not found');
      if ((args as string[])[0] === 'inspect') return 'null';
      return '';
    });
    expect(await P.joinPanelNetwork()).toBe(false);
    expect(P.traefikPanelUpstream()).toBe('http://host.docker.internal:3000');
    expect(argsOf().slice(-2)).toEqual(['network connect --alias ninedeploy-panel ninedeploy abc123', 'inspect abc123 --format {{json (index .NetworkSettings.Networks "ninedeploy")}}']);
  });

  it('outside a container it does nothing', async () => {
    h.inContainer.value = false;
    expect(await P.joinPanelNetwork()).toBe(false);
    expect(h.capture).not.toHaveBeenCalled();
    expect(P.panelRunsInContainer()).toBe(false);
  });
});

describe('detectPanelOnNetwork', () => {
  it('reads the alias on the network, only inside a container', async () => {
    h.capture.mockResolvedValue('{"Aliases":["ninedeploy-panel"]}');
    expect(await P.detectPanelOnNetwork()).toBe(true);
    expect(argsOf()[0]).toBe('inspect abc123 --format {{json (index .NetworkSettings.Networks "ninedeploy")}}');
    h.capture.mockResolvedValue('null');
    expect(await P.detectPanelOnNetwork()).toBe(false);
    h.capture.mockRejectedValue(new Error('no such container'));
    expect(await P.detectPanelOnNetwork()).toBe(false);
    h.inContainer.value = false;
    h.capture.mockClear();
    expect(await P.detectPanelOnNetwork()).toBe(false);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('resetPanelUpstream can start from the joined state', () => {
    P.resetPanelUpstream({ onNetwork: true });
    expect(P.traefikPanelUpstream()).toBe('http://ninedeploy-panel:3000');
  });
});
