import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({ answer: '' }));
vi.mock('../src/prompts.js', () => ({ prompt: vi.fn(async () => prompts.answer) }));

import { versionSet, versionShow } from '../src/commands/databaseVersion.js';

/** N12: `ninedeploy databases version …`. */
const status = (over: Record<string, unknown> = {}) => ({
  databaseId: 9, version: null, namedAt: null, canSet: true, why: null, creationImage: 'mysql:8.0', defaultImage: 'mysql:9.7', defaultTag: '9.7',
  containerImage: null, ambiguous: true, choices: ['8.0', '8.4', '9.7'], ...over,
});

function client(over: Record<string, unknown> = {}) {
  const version = {
    get: vi.fn(async () => status()),
    set: vi.fn(async (_id: number, input: { version: string }) => status({ version: input.version, namedAt: '2026-11-28T02:00:00.000Z', canSet: true })),
    ...over,
  };
  return { version, client: { databases: { version } } as never };
}

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  process.exitCode = 0;
  prompts.answer = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
const text = () => out.join('\n');

describe('databases version', () => {
  it('show says what is known about a row without a version, the cost of a Start, and how to name the release', async () => {
    const { client: c } = client();
    await versionShow(c, '9');
    expect(text()).toContain('none');
    expect(text()).toContain('mysql:8.0');
    expect(text()).toContain('mysql:9.7');
    expect(text()).toContain('upgrades the data in place, with no way back');
    expect(text()).toContain('8.0, 8.4, 9.7');
    expect(text()).toContain('ninedeploy databases version set 9 <release>');
  });

  it('show gives the reason when the release cannot be named, and only the version when the server runs it', async () => {
    const { client: c } = client({ get: vi.fn(async () => status({ canSet: false, ambiguous: false, why: 'Its container exists: the panel pins the release it runs at its next boot.', containerImage: 'mysql:8.4' })) });
    await versionShow(c, '9');
    expect(text()).toContain('Its container exists');
    expect(text()).toContain('Its container runs');
    expect(text()).toContain('mysql:8.4');
    expect(text()).not.toContain('May be named');
    const { client: pinned } = client({ get: vi.fn(async () => status({ version: '8.0', canSet: false, ambiguous: false })) });
    await versionShow(pinned, '9');
    expect(text()).toContain('8.0');
    expect(text()).not.toContain('May be named');
    await versionShow(client({ get: vi.fn(async () => status({ version: '8.0', namedAt: '2026-11-27T02:00:00.000Z' })) }).client, '9');
    expect(text()).toContain('Named by hand on 2026-11-27T02:00:00.000Z');
    expect(text()).toContain('May be named');
  });

  it('set asks first, then names the release and says the first start tries it', async () => {
    prompts.answer = 'yes';
    const { client: c, version } = client();
    await versionSet(c, '9', '8.0');
    expect(version.set).not.toHaveBeenCalled();
    expect(text()).toContain('Aborted');

    prompts.answer = 'version';
    await versionSet(c, '9', '8.0');
    expect(version.set).toHaveBeenCalledWith(9, { version: '8.0' });
    expect(text()).toContain('Version set to 8.0.');
    expect(text()).toContain('provisional until the server has run on it');
    expect(process.exitCode).toBe(0);
  });

  it('set refuses a tag that is not one, one outside the list, and a row that cannot be named', async () => {
    const { client: c, version } = client();
    await versionSet(c, '9', 'latest', { yes: true });
    expect(text()).toContain('<release> must be a release tag');
    await versionSet(c, '9', '8.3', { yes: true });
    expect(text()).toContain('"8.3" is not a release this database may be given. Choose one of: 8.0, 8.4, 9.7.');
    const { client: closed } = client({ get: vi.fn(async () => status({ canSet: false, why: 'The database is starting on the named release; wait until it is up, or has failed.' })) });
    await versionSet(closed, '9', '8.0', { yes: true });
    expect(text()).toContain('wait until it is up, or has failed');
    expect(process.exitCode).toBe(1);
    expect(version.set).not.toHaveBeenCalled();
    // Naming the release it already has changes nothing and starts no confirmation.
    const same = client({ get: vi.fn(async () => status({ version: '8.0', namedAt: '2026-11-27T02:00:00.000Z' })) });
    await versionSet(same.client, '9', '8.0', {});
    expect(same.version.set).not.toHaveBeenCalled();
    expect(text()).toContain('already named 8.0');
  });

  it('reports what the panel refuses', async () => {
    const { client: c } = client({ set: vi.fn(async () => { throw new Error('The database ran on its named release meanwhile; it is its version now.'); }) });
    await versionSet(c, '9', '8.4', { yes: true });
    expect(text()).toContain('it is its version now');
    expect(process.exitCode).toBe(1);
  });
});
