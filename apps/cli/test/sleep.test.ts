import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleepMinutes, sleepNow, sleepOff, sleepSet, sleepSetting, sleepShow, sleepWake } from '../src/commands/sleep.js';

/** 0.16.11: `sleep show|set|off|now|wake`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn(), get: vi.fn(), update: vi.fn(), sleep: vi.fn(), wake: vi.fn() },
  };
}
type Client = ReturnType<typeof makeClient>;
const asClient = (c: Client) => c as never;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.exitCode = 0;
});

const service = (over: Record<string, unknown> = {}) => ({
  id: 4,
  name: `web${ESC}[2J`,
  slug: 'web',
  type: 'docker',
  sleepAfterMinutes: 30,
  asleepAt: null,
  ...over,
});

describe('helpers', () => {
  it('accepts whole minutes from 5 to 1440', () => {
    expect(sleepMinutes('5')).toBe(5);
    expect(sleepMinutes(' 1440 ')).toBe(1440);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('refuses anything else, naming the range', () => {
    for (const bad of ['4', '1441', '0', '-5', '7.5', 'ten', '', '1e2']) {
      expect(sleepMinutes(bad)).toBeNull();
    }
    expect(err()).toContain('<minutes> must be a whole number from 5 to 1440 (got "4")');
    expect(err()).toContain('(got "1e2")');
    expect(process.exitCode).toBe(1);
  });

  it('puts the setting in words', () => {
    expect(sleepSetting(30)).toBe('sleeps after 30 minutes without a request');
    expect(sleepSetting(null)).toBe('never sleeps');
    expect(sleepSetting(undefined)).toBe('never sleeps');
  });
});

describe('sleep show', () => {
  it('shows an awake service with the setting', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    await sleepShow(asClient(client), '4');
    expect(client.services.list).not.toHaveBeenCalled();
    expect(client.services.get).toHaveBeenCalledWith(4);
    const text = out();
    expect(text).toContain('Scale to zero: web');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toContain('sleeps after 30 minutes without a request');
    expect(text).toContain('awake');
    expect(text).not.toContain('Went to sleep');
  });

  it('shows a sleeping service by slug, with how long ago it went to sleep', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    client.services.get.mockResolvedValue(service({ asleepAt: '2026-10-20T09:35:00.000Z' }));
    await sleepShow(asClient(client), 'web');
    expect(client.services.get).toHaveBeenCalledWith(4);
    const text = out();
    expect(text).toContain('asleep');
    expect(text).toContain('Went to sleep');
    expect(text).toContain('25m ago');
    expect(text).toContain('The next request through one of its domains wakes it, or `ninedeploy sleep wake`.');
  });

  it('shows a service that never sleeps, also when an older panel leaves the fields out', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ sleepAfterMinutes: null }));
    await sleepShow(asClient(client), '4');
    expect(out()).toContain('never sleeps');

    logSpy.mockClear();
    client.services.get.mockResolvedValue({ id: 4, name: 'web', slug: 'web' });
    await sleepShow(asClient(client), '4');
    expect(out()).toContain('never sleeps');
    expect(out()).toContain('awake');
  });

  it('prints JSON', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ asleepAt: '2026-10-20T09:35:00.000Z' }));
    await sleepShow(asClient(client), '4', { json: true });
    expect(JSON.parse(out())).toEqual({ sleepAfterMinutes: 30, asleepAt: '2026-10-20T09:35:00.000Z' });

    logSpy.mockClear();
    client.services.get.mockResolvedValue({ id: 4, name: 'web', slug: 'web' });
    await sleepShow(asClient(client), '4', { json: true });
    expect(JSON.parse(out())).toEqual({ sleepAfterMinutes: null, asleepAt: null });
  });

  it('reports an unknown service and an API failure', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await sleepShow(asClient(client), 'nope');
    expect(err()).toContain('No service named "nope"');
    expect(client.services.get).not.toHaveBeenCalled();

    client.services.get.mockRejectedValue(new Error(`boom${ESC}[2J`));
    await sleepShow(asClient(client), '4');
    expect(err()).toContain('boom');
    expect(err()).not.toContain(`${ESC}[2J`);

    client.services.get.mockRejectedValue('plain failure');
    await sleepShow(asClient(client), '4');
    expect(err()).toContain('plain failure');
    expect(process.exitCode).toBe(1);
  });
});

describe('sleep set', () => {
  it('sends sleepAfterMinutes and names what it needs', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue(service({ sleepAfterMinutes: 45 }));
    await sleepSet(asClient(client), '4', '45');
    expect(client.services.update).toHaveBeenCalledWith(4, { sleepAfterMinutes: 45 });
    expect(out()).toContain('web sleeps after 45 minutes without a request.');
    expect(out()).not.toContain(`${ESC}[2J`);
    expect(out()).toContain('It needs traffic analytics on (Traefik → Traffic) and a routed domain');
  });

  it('falls back to the value sent when the answer leaves it out', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue({ id: 4, name: 'web' });
    await sleepSet(asClient(client), '4', '10');
    expect(out()).toContain('web sleeps after 10 minutes without a request.');
  });

  it('refuses minutes out of range before calling the server', async () => {
    const client = makeClient();
    await sleepSet(asClient(client), '4', '2');
    expect(err()).toContain('<minutes> must be a whole number from 5 to 1440');
    expect(client.services.list).not.toHaveBeenCalled();
    expect(client.services.update).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('reports an unknown service and shows the server refusing as it is', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await sleepSet(asClient(client), 'nope', '30');
    expect(err()).toContain('No service named "nope"');
    expect(client.services.update).not.toHaveBeenCalled();

    client.services.update.mockRejectedValue(new Error('Scale to zero applies to docker services only'));
    await sleepSet(asClient(client), '4', '30');
    expect(err()).toContain('Scale to zero applies to docker services only');
    expect(process.exitCode).toBe(1);
  });
});

describe('sleep off', () => {
  it('sends sleepAfterMinutes: null', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue(service({ sleepAfterMinutes: null }));
    await sleepOff(asClient(client), '4');
    expect(client.services.update).toHaveBeenCalledWith(4, { sleepAfterMinutes: null });
    expect(out()).toContain('web never sleeps now.');
    expect(out()).not.toContain('It is asleep now');
  });

  it('says how a service that is asleep now wakes', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue(service({ sleepAfterMinutes: null, asleepAt: '2026-10-20T09:35:00.000Z' }));
    await sleepOff(asClient(client), '4');
    expect(out()).toContain('It is asleep now: the next request through one of its domains wakes it, or `ninedeploy sleep wake`.');
  });

  it('reports an unknown service and a failure', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await sleepOff(asClient(client), 'nope');
    expect(client.services.update).not.toHaveBeenCalled();
    client.services.update.mockRejectedValue(new Error('forbidden'));
    await sleepOff(asClient(client), '4');
    expect(err()).toContain('forbidden');
  });
});

describe('sleep now', () => {
  it('puts the service to sleep', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    client.services.sleep.mockResolvedValue({ ok: true, asleep: true });
    await sleepNow(asClient(client), 'web');
    expect(client.services.sleep).toHaveBeenCalledWith(4);
    expect(out()).toContain('web is asleep. The next request through one of its domains wakes it.');
  });

  it('shows why the server refuses, as it says it', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await sleepNow(asClient(client), 'nope');
    expect(err()).toContain('No service named "nope"');
    expect(client.services.sleep).not.toHaveBeenCalled();

    client.services.sleep.mockRejectedValue(new Error('Cannot put the service to sleep: no domain routes to the service, so no request could wake it'));
    await sleepNow(asClient(client), '4');
    expect(err()).toContain('Cannot put the service to sleep: no domain routes to the service, so no request could wake it');
    client.services.sleep.mockRejectedValue(new Error('The service changed meanwhile; try again'));
    await sleepNow(asClient(client), '4');
    expect(err()).toContain('The service changed meanwhile; try again');
    expect(process.exitCode).toBe(1);
  });
});

describe('sleep wake', () => {
  it('wakes the service', async () => {
    const client = makeClient();
    client.services.wake.mockResolvedValue({ ok: true, status: 'running' });
    await sleepWake(asClient(client), '4');
    expect(client.services.wake).toHaveBeenCalledWith(4);
    expect(out()).toContain('4 is awake (running).');
  });

  it('shows why the server refuses, as it says it', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await sleepWake(asClient(client), 'nope');
    expect(client.services.wake).not.toHaveBeenCalled();

    client.services.wake.mockRejectedValue(new Error('The service is not asleep'));
    await sleepWake(asClient(client), '4');
    expect(err()).toContain('The service is not asleep');
    client.services.wake.mockRejectedValue(new Error('The service could not be woken: its containers did not start or failed the healthcheck'));
    await sleepWake(asClient(client), '4');
    expect(err()).toContain('its containers did not start or failed the healthcheck');
    expect(process.exitCode).toBe(1);
  });
});
