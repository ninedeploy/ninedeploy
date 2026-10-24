import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canaryBody, canaryOff, canaryOptions, canaryPromote, canarySet, canaryShow, fmtSeconds } from '../src/commands/canary.js';

/** 0.16.9: `canary show|set|off|promote`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn(), get: vi.fn(), update: vi.fn() },
    deploys: { canary: vi.fn(), promoteCanary: vi.fn() },
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

const cfg = { steps: [10, 50], stepSeconds: 120, maxErrorRate: 5, maxP95Ms: null, minRequests: 20 };
const service = (over: Record<string, unknown> = {}) => ({ id: 4, name: `web${ESC}[2J`, slug: 'web', canary: cfg, ...over });

const running = (over: Record<string, unknown> = {}) => ({
  active: true,
  deploymentId: 9,
  step: 1,
  steps: 2,
  weight: 10,
  stepStartedAt: '2026-10-20T10:00:00.000Z',
  stepEndsAt: '2026-10-20T10:02:00.000Z',
  measured: true,
  canary: { requests: 40, errors: 1, errorRate: 2.5, p95Ms: 120 },
  stable: { requests: 360, errors: 0, errorRate: 0, p95Ms: 90 },
  promoting: false,
  ...over,
});

describe('helpers', () => {
  it('formats seconds', () => {
    expect(fmtSeconds(80)).toBe('1m 20s');
    expect(fmtSeconds(45.4)).toBe('45s');
    expect(fmtSeconds(-5)).toBe('0s');
  });

  it('parses the options the user gave, and only those', () => {
    expect(canaryOptions({})).toEqual({});
    expect(
      canaryOptions({ steps: '10, 50,90', stepSeconds: '60', maxErrorRate: '2.5', maxP95: '800', minRequests: '50' }),
    ).toEqual({ steps: [10, 50, 90], stepSeconds: 60, maxErrorRate: 2.5, maxP95Ms: 800, minRequests: 50 });
    expect(canaryOptions({ maxP95: 'OFF' })).toEqual({ maxP95Ms: null });
  });

  it('refuses options that are not numbers', () => {
    expect(canaryOptions({ steps: '10,,50' })).toBeNull();
    expect(err()).toContain('--steps must be percentages');
    expect(canaryOptions({ steps: '10,abc' })).toBeNull();
    expect(canaryOptions({ stepSeconds: 'soon' })).toBeNull();
    expect(err()).toContain('--step-seconds must be a number');
    expect(canaryOptions({ minRequests: ' ' })).toBeNull();
    expect(err()).toContain('--min-requests must be a number');
    expect(canaryOptions({ maxP95: 'fast' })).toBeNull();
    expect(err()).toContain('--max-p95 must be a number');
    expect(process.exitCode).toBe(1);
  });

  it('keeps the current values, or sends only what was given with the default steps', () => {
    expect(canaryBody(cfg, { stepSeconds: 60 })).toEqual({ ...cfg, stepSeconds: 60 });
    expect(canaryBody(null, { stepSeconds: 60 })).toEqual({ steps: [10, 50], stepSeconds: 60 });
    expect(canaryBody(undefined, { steps: [25] })).toEqual({ steps: [25] });
  });
});

describe('canary show', () => {
  it('prints the configuration and the running canary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:40.000Z'));
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    client.deploys.canary.mockResolvedValue(running());
    await canaryShow(asClient(client), '4');
    expect(client.services.list).not.toHaveBeenCalled();
    expect(client.services.get).toHaveBeenCalledWith(4);
    expect(client.deploys.canary).toHaveBeenCalledWith(4);
    const text = out();
    expect(text).toContain('Canary releases: web');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toContain('10%, 50%');
    expect(text).toContain('2m 0s');
    expect(text).toContain('not judged');
    expect(text).toContain('#9');
    expect(text).toContain('1/2');
    expect(text).toContain('10% to the new release');
    expect(text).toContain('1m 20s');
    expect(text).toContain('40 requests, 5xx 2.5%, p95 120 ms');
    expect(text).toContain('360 requests, 5xx 0%, p95 90 ms');
    expect(text).not.toContain('healthcheck only');
  });

  it('says when steps are judged on the healthcheck only, and when a promote is underway', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    client.services.get.mockResolvedValue(service({ canary: { ...cfg, maxP95Ms: 800 } }));
    client.deploys.canary.mockResolvedValue(
      running({ measured: false, promoting: true, stepEndsAt: undefined, canary: { requests: 0, errors: 0, errorRate: null, p95Ms: null }, stable: undefined }),
    );
    await canaryShow(asClient(client), 'web');
    expect(client.services.get).toHaveBeenCalledWith(4);
    const text = out();
    expect(text).toContain('800 ms');
    expect(text).toContain('Traffic analytics is off: steps are judged on the healthcheck only.');
    expect(text).toContain('Promote requested');
    expect(text).toContain('0 requests, 5xx —, p95 —');
    expect(text).not.toContain('Step ends in');
  });

  it('shows a service without a canary configuration and no canary running', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ canary: null }));
    client.deploys.canary.mockResolvedValue({ active: false });
    await canaryShow(asClient(client), '4');
    expect(out()).toContain('off: a deploy switches all traffic at once');
    expect(out()).toContain('No canary is running.');
  });

  it('prints JSON', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ canary: undefined }));
    client.deploys.canary.mockResolvedValue({ active: false });
    await canaryShow(asClient(client), '4', { json: true });
    expect(JSON.parse(out())).toEqual({ config: null, status: { active: false } });
  });

  it('reports an unknown service and an API failure', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await canaryShow(asClient(client), 'nope');
    expect(err()).toContain('No service named "nope"');
    expect(client.deploys.canary).not.toHaveBeenCalled();

    client.services.get.mockRejectedValue(new Error(`boom${ESC}[2J`));
    client.deploys.canary.mockResolvedValue({ active: false });
    await canaryShow(asClient(client), '4');
    expect(err()).toContain('boom');
    expect(err()).not.toContain(`${ESC}[2J`);

    client.services.get.mockRejectedValue('plain failure');
    await canaryShow(asClient(client), '4');
    expect(err()).toContain('plain failure');
    expect(process.exitCode).toBe(1);
  });
});

describe('canary set', () => {
  it('merges the given options into the current configuration', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    client.services.update.mockResolvedValue(service({ canary: { ...cfg, maxP95Ms: 500 } }));
    await canarySet(asClient(client), '4', { maxP95: '500' });
    expect(client.services.update).toHaveBeenCalledWith(4, { canary: { ...cfg, maxP95Ms: 500 } });
    expect(out()).toContain('Canary releases on for web');
    expect(out()).toContain('500 ms');
  });

  it('sends only what was given (with the default steps) when the service has none', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ canary: null }));
    client.services.update.mockResolvedValue(service());
    await canarySet(asClient(client), '4', { stepSeconds: '60' });
    expect(client.services.update).toHaveBeenCalledWith(4, { canary: { steps: [10, 50], stepSeconds: 60 } });
  });

  it('prints the stored configuration as JSON', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ canary: null }));
    client.services.update.mockResolvedValue(service());
    await canarySet(asClient(client), '4', { steps: '10,50', json: true });
    expect(JSON.parse(out())).toEqual(cfg);

    logSpy.mockClear();
    client.services.update.mockResolvedValue(service({ canary: undefined }));
    await canarySet(asClient(client), '4', { json: true });
    expect(JSON.parse(out())).toBeNull();
  });

  it('refuses invalid values before calling the server, naming the flag', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    await canarySet(asClient(client), '4', { steps: '50,10', stepSeconds: '5' });
    expect(err()).toContain('--steps: Canary steps must go up');
    expect(err()).toContain('--step-seconds:');
    expect(client.services.update).not.toHaveBeenCalled();

    await canarySet(asClient(client), '4', { minRequests: 'many' });
    expect(err()).toContain('--min-requests must be a number');
    expect(client.services.get).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('names a schema issue with no flag of its own', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ canary: { ...cfg, extra: 1 } }));
    await canarySet(asClient(client), '4', {});
    expect(err()).toContain('canary:');
    expect(client.services.update).not.toHaveBeenCalled();
  });

  it('reports an unknown service and the server refusing', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await canarySet(asClient(client), 'nope', {});
    expect(err()).toContain('No service named "nope"');

    client.services.get.mockResolvedValue(service({ canary: null }));
    client.services.update.mockRejectedValue(new Error('Canary releases are for docker services'));
    await canarySet(asClient(client), '4', {});
    expect(err()).toContain('Canary releases are for docker services');
    expect(process.exitCode).toBe(1);
  });
});

describe('canary off', () => {
  it('sends canary: null', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue(service({ canary: null }));
    await canaryOff(asClient(client), '4');
    expect(client.services.update).toHaveBeenCalledWith(4, { canary: null });
    expect(out()).toContain('Canary releases off for web');
  });

  it('reports an unknown service and a failure', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await canaryOff(asClient(client), 'nope');
    expect(client.services.update).not.toHaveBeenCalled();
    client.services.update.mockRejectedValue(new Error('forbidden'));
    await canaryOff(asClient(client), '4');
    expect(err()).toContain('forbidden');
  });
});

describe('canary promote', () => {
  it('promotes the running canary', async () => {
    const client = makeClient();
    client.deploys.canary.mockResolvedValue(running());
    client.deploys.promoteCanary.mockResolvedValue({ ok: true });
    await canaryPromote(asClient(client), '4');
    expect(client.deploys.promoteCanary).toHaveBeenCalledWith(4, 9);
    expect(out()).toContain('Deployment #9: promotion requested');
    expect(out()).toContain('current measured step');
  });

  it('promotes the deployment given, without asking for the status', async () => {
    const client = makeClient();
    client.deploys.promoteCanary.mockResolvedValue({ ok: true });
    await canaryPromote(asClient(client), '4', { deployment: '12' });
    expect(client.deploys.canary).not.toHaveBeenCalled();
    expect(client.deploys.promoteCanary).toHaveBeenCalledWith(4, 12);
  });

  it('says plainly when no canary is running', async () => {
    const client = makeClient();
    client.deploys.canary.mockResolvedValue({ active: false });
    await canaryPromote(asClient(client), '4');
    expect(err()).toContain('No canary is running on this service.');
    expect(client.deploys.promoteCanary).not.toHaveBeenCalled();

    client.deploys.canary.mockResolvedValue({ active: true });
    await canaryPromote(asClient(client), '4');
    expect(client.deploys.promoteCanary).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('refuses a bad --deployment, an unknown service and relays no_canary', async () => {
    const client = makeClient();
    await canaryPromote(asClient(client), '4', { deployment: 'x' });
    expect(err()).toContain('--deployment must be a positive integer');
    await canaryPromote(asClient(client), '4', { deployment: '0' });

    client.services.list.mockResolvedValue([]);
    await canaryPromote(asClient(client), 'nope');
    expect(client.deploys.canary).not.toHaveBeenCalled();

    client.deploys.promoteCanary.mockRejectedValue(new Error('This deployment has no canary in progress'));
    await canaryPromote(asClient(client), '4', { deployment: '12' });
    expect(err()).toContain('This deployment has no canary in progress');
  });
});
