import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoscaleBody, autoscaleOff, autoscaleOptions, autoscaleSet, autoscaleShow, fmtMetric } from '../src/commands/autoscale.js';

/** 0.16.10: `autoscale show|set|off`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn(), get: vi.fn(), update: vi.fn(), autoscale: vi.fn() },
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

const cfg = { minReplicas: 1, maxReplicas: 4, metric: 'cpu' as const, target: 70, scaleUpSeconds: 60, scaleDownSeconds: 300 };
const service = (over: Record<string, unknown> = {}) => ({ id: 4, name: `web${ESC}[2J`, slug: 'web', autoscale: cfg, ...over });

const status = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  replicas: 2,
  minReplicas: 1,
  maxReplicas: 4,
  metric: 'cpu',
  target: 70,
  value: 91.5,
  desired: 3,
  holding: null,
  lastEvent: { at: '2026-10-20T09:55:00.000Z', from: 1, to: 2, reason: `cpu 88% per container over 60s (target 70%)${ESC}[2J` },
  ...over,
});

describe('helpers', () => {
  it('formats a metric value with its unit', () => {
    expect(fmtMetric('cpu', 70)).toBe('70%');
    expect(fmtMetric('memory', 55.5)).toBe('55.5%');
    expect(fmtMetric('rps', 120)).toBe('120 req/s');
  });

  it('parses the options the user gave, and only those', () => {
    expect(autoscaleOptions({})).toEqual({});
    expect(
      autoscaleOptions({ min: '2', max: '6', metric: ' RPS ', target: '150', upSeconds: '30', downSeconds: '600' }),
    ).toEqual({ minReplicas: 2, maxReplicas: 6, metric: 'rps', target: 150, scaleUpSeconds: 30, scaleDownSeconds: 600 });
  });

  it('refuses options that are not numbers or not a metric, naming the flag', () => {
    expect(autoscaleOptions({ min: 'two' })).toBeNull();
    expect(err()).toContain('--min must be a number');
    expect(autoscaleOptions({ target: ' ' })).toBeNull();
    expect(err()).toContain('--target must be a number');
    expect(autoscaleOptions({ downSeconds: 'later' })).toBeNull();
    expect(err()).toContain('--down-seconds must be a number');
    expect(autoscaleOptions({ metric: 'disk' })).toBeNull();
    expect(err()).toContain('--metric must be one of cpu, memory, rps');
    expect(process.exitCode).toBe(1);
  });

  it('merges over the current configuration, or needs --max and --target without one', () => {
    expect(autoscaleBody(cfg, { target: 50 })).toEqual({ body: { ...cfg, target: 50 } });
    expect(autoscaleBody(null, { maxReplicas: 3, target: 60 })).toEqual({ body: { maxReplicas: 3, target: 60 } });
    expect(autoscaleBody(undefined, { maxReplicas: 3 })).toEqual({ missing: ['--target'] });
    expect(autoscaleBody(null, {})).toEqual({ missing: ['--max', '--target'] });
  });
});

describe('autoscale show', () => {
  it('prints the configuration and the live status', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    client.services.autoscale.mockResolvedValue(status());
    await autoscaleShow(asClient(client), '4');
    expect(client.services.list).not.toHaveBeenCalled();
    expect(client.services.get).toHaveBeenCalledWith(4);
    expect(client.services.autoscale).toHaveBeenCalledWith(4);
    const text = out();
    expect(text).toContain('Autoscaling: web');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toContain('1–4 containers');
    expect(text).toContain('cpu, target 70% per container');
    expect(text).toContain('1m 0s');
    expect(text).toContain('5m 0s');
    expect(text).toContain('2 containers');
    expect(text).toContain('91.5% per container');
    expect(text).toContain('3 containers');
    expect(text).toContain('1 → 2 containers, cpu 88% per container over 60s (target 70%), 5m ago');
    expect(text).not.toContain('Not scaling now');
  });

  it('says plainly why it holds, and shows an rps service with nothing read yet', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    client.services.get.mockResolvedValue(service({ autoscale: { ...cfg, metric: 'rps', target: 200 } }));
    client.services.autoscale.mockResolvedValue(
      status({ replicas: 1, metric: 'rps', target: 200, value: null, desired: null, holding: 'requests per second need traffic analytics (Traefik → Traffic)', lastEvent: null }),
    );
    await autoscaleShow(asClient(client), 'web');
    expect(client.services.get).toHaveBeenCalledWith(4);
    const text = out();
    expect(text).toContain('rps, target 200 req/s per container');
    expect(text).toContain('1 container');
    expect(text).toContain('not read yet');
    expect(text).toContain('Not scaling now: requests per second need traffic analytics (Traefik → Traffic).');
    expect(text).toContain('none yet');
  });

  it('shows rps values in req/s and falls back to cpu when the status has no metric', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    client.services.autoscale.mockResolvedValue(status({ metric: 'rps', value: 12.5 }));
    await autoscaleShow(asClient(client), '4');
    expect(out()).toContain('12.5 req/s per container');

    logSpy.mockClear();
    client.services.autoscale.mockResolvedValue(status({ metric: undefined, value: 40, desired: undefined, lastEvent: undefined }));
    await autoscaleShow(asClient(client), '4');
    expect(out()).toContain('40% per container');
  });

  it('shows a service with autoscaling off', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ autoscale: null }));
    client.services.autoscale.mockResolvedValue({ enabled: false, replicas: 1 });
    await autoscaleShow(asClient(client), '4');
    expect(out()).toContain('off: the service runs its fixed replicas');
    expect(out()).toContain('1 container');
    expect(out()).not.toContain('Last value');
  });

  it('prints JSON', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ autoscale: undefined }));
    client.services.autoscale.mockResolvedValue({ enabled: false, replicas: 1 });
    await autoscaleShow(asClient(client), '4', { json: true });
    expect(JSON.parse(out())).toEqual({ config: null, status: { enabled: false, replicas: 1 } });
  });

  it('reports an unknown service and an API failure', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await autoscaleShow(asClient(client), 'nope');
    expect(err()).toContain('No service named "nope"');
    expect(client.services.autoscale).not.toHaveBeenCalled();

    client.services.get.mockRejectedValue(new Error(`boom${ESC}[2J`));
    client.services.autoscale.mockResolvedValue({ enabled: false, replicas: 1 });
    await autoscaleShow(asClient(client), '4');
    expect(err()).toContain('boom');
    expect(err()).not.toContain(`${ESC}[2J`);

    client.services.get.mockRejectedValue('plain failure');
    await autoscaleShow(asClient(client), '4');
    expect(err()).toContain('plain failure');
    expect(process.exitCode).toBe(1);
  });
});

describe('autoscale set', () => {
  it('merges the given options into the current configuration', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    client.services.update.mockResolvedValue(service({ autoscale: { ...cfg, maxReplicas: 6 } }));
    await autoscaleSet(asClient(client), '4', { max: '6' });
    expect(client.services.update).toHaveBeenCalledWith(4, { autoscale: { ...cfg, maxReplicas: 6 } });
    expect(out()).toContain('Autoscaling on for web.');
    expect(out()).toContain('1–6 containers');
    expect(out()).toContain('It applies fully at the next deploy, which creates the spare containers.');
  });

  it('sends only what was given when the service has none', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ autoscale: null }));
    client.services.update.mockResolvedValue(service());
    await autoscaleSet(asClient(client), '4', { max: '4', target: '70' });
    expect(client.services.update).toHaveBeenCalledWith(4, { autoscale: { maxReplicas: 4, target: 70 } });
  });

  it('needs --max and --target to turn it on', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ autoscale: null }));
    await autoscaleSet(asClient(client), '4', { min: '2' });
    expect(err()).toContain('Autoscaling is off for this service: give --max and --target to turn it on.');
    expect(client.services.update).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('prints the stored configuration as JSON, without the deploy note', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ autoscale: null }));
    client.services.update.mockResolvedValue(service());
    await autoscaleSet(asClient(client), '4', { max: '4', target: '70', json: true });
    expect(JSON.parse(out())).toEqual(cfg);

    logSpy.mockClear();
    client.services.update.mockResolvedValue(service({ autoscale: undefined }));
    await autoscaleSet(asClient(client), '4', { max: '4', target: '70', json: true });
    expect(JSON.parse(out())).toBeNull();
  });

  it('refuses invalid values before calling the server, naming the flag', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    await autoscaleSet(asClient(client), '4', { min: '4', max: '4', upSeconds: '5' });
    expect(err()).toContain('--max: maxReplicas must be above minReplicas');
    expect(err()).toContain('--up-seconds:');
    expect(client.services.update).not.toHaveBeenCalled();

    await autoscaleSet(asClient(client), '4', { metric: 'memory', target: '150' });
    expect(err()).toContain('--target: A memory target is a percentage, at most 100');
    expect(client.services.update).not.toHaveBeenCalled();

    await autoscaleSet(asClient(client), '4', { max: 'many' });
    expect(err()).toContain('--max must be a number');
    expect(client.services.get).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  it('names a schema issue with no flag of its own', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ autoscale: { ...cfg, extra: 1 } }));
    await autoscaleSet(asClient(client), '4', {});
    expect(err()).toContain('autoscale:');
    expect(client.services.update).not.toHaveBeenCalled();
  });

  it('reports an unknown service and the server refusing', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await autoscaleSet(asClient(client), 'nope', {});
    expect(err()).toContain('No service named "nope"');

    client.services.get.mockResolvedValue(service());
    client.services.update.mockRejectedValue(new Error('Autoscaling is for docker services'));
    await autoscaleSet(asClient(client), '4', {});
    expect(err()).toContain('Autoscaling is for docker services');
    expect(process.exitCode).toBe(1);
  });
});

describe('autoscale off', () => {
  it('sends autoscale: null', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue(service({ autoscale: null }));
    await autoscaleOff(asClient(client), '4');
    expect(client.services.update).toHaveBeenCalledWith(4, { autoscale: null });
    expect(out()).toContain('Autoscaling off for web.');
    expect(out()).toContain('until the next deploy');
  });

  it('reports an unknown service and a failure', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await autoscaleOff(asClient(client), 'nope');
    expect(client.services.update).not.toHaveBeenCalled();
    client.services.update.mockRejectedValue(new Error('forbidden'));
    await autoscaleOff(asClient(client), '4');
    expect(err()).toContain('forbidden');
  });
});
