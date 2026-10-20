import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOnOff, previewsDatabaseCopies, previewsShow } from '../src/commands/previews.js';

/** 0.16.12: `previews show|database-copies`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn(), get: vi.fn(), update: vi.fn() },
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
  process.exitCode = 0;
});

const service = (over: Record<string, unknown> = {}) => ({
  id: 4,
  name: `web${ESC}[2J`,
  slug: 'web',
  type: 'docker',
  previewDeploymentsEnabled: true,
  previewAutoDestroyOnClose: true,
  previewDatabaseCopy: true,
  previewDomainPattern: 'pr-{{pr}}-{{slug}}.{{domain}}',
  previewMaxActive: 5,
  ...over,
});

describe('parseOnOff', () => {
  it('reads on and off, and their spellings', () => {
    for (const v of ['on', ' ON ', 'true', 'yes']) expect(parseOnOff(v)).toBe(true);
    for (const v of ['off', 'Off', 'false', 'no']) expect(parseOnOff(v)).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('refuses anything else', () => {
    expect(parseOnOff('maybe')).toBeNull();
    expect(parseOnOff(undefined)).toBeNull();
    expect(err()).toContain('The setting must be on or off (got "maybe")');
    expect(err()).toContain('(got "")');
    expect(process.exitCode).toBe(1);
  });
});

describe('previews show', () => {
  it('shows the preview settings, database copies included', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    await previewsShow(asClient(client), '4');
    expect(client.services.list).not.toHaveBeenCalled();
    expect(client.services.get).toHaveBeenCalledWith(4);
    const text = out();
    expect(text).toContain('PR previews: web');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toMatch(/Database copies.*on/);
    expect(text).toMatch(/Auto-destroy on close.*on/);
    expect(text).toContain('pr-{{pr}}-{{slug}}.{{domain}}');
    expect(text).toMatch(/Max active.*5/);
  });

  it('shows defaults when an older panel leaves the fields out', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    client.services.get.mockResolvedValue({ id: 4, name: 'web', slug: 'web' });
    await previewsShow(asClient(client), 'web');
    const text = out();
    expect(text).toMatch(/Previews.*off/);
    expect(text).toMatch(/Database copies.*off/);
    expect(text).toMatch(/Domain pattern.*default/);
    expect(text).toMatch(/Max active.*default/);
  });

  it('says a preview takes its settings from the parent', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service({ isEphemeralPreview: true, prNumber: 12 }));
    await previewsShow(asClient(client), '4');
    expect(out()).toContain('This is the preview of PR #12; its settings come from the parent service.');
    expect(out()).not.toContain('Database copies');

    logSpy.mockClear();
    client.services.get.mockResolvedValue(service({ isEphemeralPreview: true, prNumber: null }));
    await previewsShow(asClient(client), '4');
    expect(out()).toContain('PR #?');
  });

  it('prints JSON', async () => {
    const client = makeClient();
    client.services.get.mockResolvedValue(service());
    await previewsShow(asClient(client), '4', { json: true });
    expect(JSON.parse(out())).toEqual({
      previewDeploymentsEnabled: true,
      previewAutoDestroyOnClose: true,
      previewDatabaseCopy: true,
      previewDomainPattern: 'pr-{{pr}}-{{slug}}.{{domain}}',
      previewMaxActive: 5,
    });

    logSpy.mockClear();
    client.services.get.mockResolvedValue({ id: 4, name: 'web', slug: 'web' });
    await previewsShow(asClient(client), '4', { json: true });
    expect(JSON.parse(out())).toEqual({
      previewDeploymentsEnabled: false,
      previewAutoDestroyOnClose: true,
      previewDatabaseCopy: false,
      previewDomainPattern: null,
      previewMaxActive: null,
    });
  });

  it('reports an unknown service and an API failure', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await previewsShow(asClient(client), 'nope');
    expect(err()).toContain('No service named "nope"');
    expect(client.services.get).not.toHaveBeenCalled();

    client.services.get.mockRejectedValue(new Error(`boom${ESC}[2J`));
    await previewsShow(asClient(client), '4');
    expect(err()).toContain('boom');
    expect(err()).not.toContain(`${ESC}[2J`);

    client.services.get.mockRejectedValue('plain failure');
    await previewsShow(asClient(client), '4');
    expect(err()).toContain('plain failure');
    expect(process.exitCode).toBe(1);
  });
});

describe('previews database-copies', () => {
  it('turns copies on and says what is copied', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue(service());
    await previewsDatabaseCopies(asClient(client), '4', 'on');
    expect(client.services.update).toHaveBeenCalledWith(4, { previewDatabaseCopy: true });
    const text = out();
    expect(text).toContain('web: database copies per preview on.');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toContain('attached PostgreSQL and Redis-family databases, made from the latest backup');
    expect(text).toContain('MySQL, MariaDB and MongoDB are not copied yet.');
    expect(text).not.toContain('PR previews are off');
  });

  it('notes when previews themselves are off', async () => {
    const client = makeClient();
    client.services.update.mockResolvedValue(service({ previewDeploymentsEnabled: false }));
    await previewsDatabaseCopies(asClient(client), '4', 'yes');
    expect(out()).toContain('PR previews are off for this service');
  });

  it('turns copies off, falling back to the value sent when the answer leaves it out', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'web' }]);
    client.services.update.mockResolvedValue({ id: 4, name: 'web' });
    await previewsDatabaseCopies(asClient(client), 'web', 'off');
    expect(client.services.update).toHaveBeenCalledWith(4, { previewDatabaseCopy: false });
    expect(out()).toContain('web: database copies per preview off.');
    expect(out()).not.toContain('Redis-family');
  });

  it('refuses a bad value before calling the server', async () => {
    const client = makeClient();
    await previewsDatabaseCopies(asClient(client), '4', 'sometimes');
    expect(err()).toContain('The setting must be on or off');
    expect(client.services.list).not.toHaveBeenCalled();
    expect(client.services.update).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('reports an unknown service and shows the server refusing as it is', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await previewsDatabaseCopies(asClient(client), 'nope', 'on');
    expect(err()).toContain('No service named "nope"');
    expect(client.services.update).not.toHaveBeenCalled();

    client.services.update.mockRejectedValue(new Error('Forbidden'));
    await previewsDatabaseCopies(asClient(client), '4', 'on');
    expect(err()).toContain('Forbidden');
    expect(process.exitCode).toBe(1);
  });
});
