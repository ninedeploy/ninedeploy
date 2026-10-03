import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  domainsPresetAddNamecheap,
  domainsPresetAddNamecheapAction,
  domainsPresetApply,
  domainsPresetApplyAction,
  domainsPresetList,
  domainsPresetListAction,
} from '../src/commands/domains.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  headerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', () => ({
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

function makeClient(over: {
  list?: unknown | Error;
  apply?: unknown | Error;
  namecheapSet?: unknown | Error;
}) {
  const throwIfRejection = (v: unknown) => {
    if (v instanceof Error) throw v;
    if (v !== null && (typeof v !== 'object' || Array.isArray(v))) throw v;
    return v;
  };
  return {
    domainPresets: {
      list: vi.fn(async () => throwIfRejection(over.list)),
      apply: vi.fn(async () => throwIfRejection(over.apply)),
    },
    settings: {
      namecheap: {
        set: vi.fn(async () => throwIfRejection(over.namecheapSet ?? { ok: true, apiUser: 'nc-user' })),
      },
    },
  } as never;
}

let savedExitCode: number | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = savedExitCode;
});

const LIST_PAYLOAD = { providers: ['cloudflare-zone', 'dnsimple'] };
const APPLY_PAYLOAD = {
  hostname: 'app.example.com',
  provider: 'cloudflare-zone',
  zone: 'example.com',
  recordId: 'rec-1',
  type: 'A' as const,
  content: '203.0.113.9',
};

describe('domains preset — pure entry points', () => {
  it('domainsPresetList returns the upstream provider list', async () => {
    const client = makeClient({ list: LIST_PAYLOAD });
    await expect(domainsPresetList(client)).resolves.toEqual(LIST_PAYLOAD);
  });

  it('domainsPresetApply posts the hostname and optional content', async () => {
    const client = makeClient({ apply: APPLY_PAYLOAD });
    await expect(domainsPresetApply(client, 'app.example.com', { content: '203.0.113.9' })).resolves.toEqual(APPLY_PAYLOAD);
  });

  it('domainsPresetApply works without a content override', async () => {
    const client = makeClient({ apply: APPLY_PAYLOAD });
    await expect(domainsPresetApply(client, 'app.example.com')).resolves.toEqual(APPLY_PAYLOAD);
  });
});

describe('domains preset — CLI actions', () => {
  it('domainsPresetListAction prints every provider on its own bullet', async () => {
    const client = makeClient({ list: LIST_PAYLOAD });
    await domainsPresetListAction(client);
    expect(h.infoSpy).toHaveBeenCalledWith('• cloudflare-zone');
    expect(h.infoSpy).toHaveBeenCalledWith('• dnsimple');
  });

  it('domainsPresetListAction prints a hint when the kernel has no drivers', async () => {
    const client = makeClient({ list: { providers: [] } });
    await domainsPresetListAction(client);
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No IDomainProvider drivers/));
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/Set dns_records_provider/));
  });

  it('domainsPresetListAction surfaces upstream errors as non-zero exits', async () => {
    const client = makeClient({ list: new Error('connection refused') });
    await domainsPresetListAction(client);
    expect(h.errorSpy).toHaveBeenCalledWith('connection refused');
    expect(process.exitCode).toBe(1);
  });

  it('domainsPresetListAction falls back to String() for non-Error rejections', async () => {
    const client = makeClient({ list: 'plain failure' });
    await domainsPresetListAction(client);
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });

  it('domainsPresetApplyAction prints the success line and metadata on the happy path', async () => {
    const client = makeClient({ apply: APPLY_PAYLOAD });
    await domainsPresetApplyAction(client, 'app.example.com');
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/Applied A record for app\.example\.com/));
    expect(h.infoSpy).toHaveBeenCalledWith('Provider: cloudflare-zone');
    expect(h.infoSpy).toHaveBeenCalledWith('Zone:     example.com');
    expect(h.infoSpy).toHaveBeenCalledWith('Record:   rec-1');
    expect(h.infoSpy).toHaveBeenCalledWith('Content:  203.0.113.9');
  });

  it('domainsPresetApplyAction forwards upstream errors verbatim', async () => {
    const client = makeClient({ apply: new Error('No zone matches "nope.other.org"') });
    await domainsPresetApplyAction(client, 'nope.other.org');
    expect(h.errorSpy).toHaveBeenCalledWith('No zone matches "nope.other.org"');
    expect(process.exitCode).toBe(1);
  });

  it('domainsPresetApplyAction falls back to String() for non-Error rejections', async () => {
    const client = makeClient({ apply: 'plain failure' });
    await domainsPresetApplyAction(client, 'nope.other.org');
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });

  it('domainsPresetApplyAction prints usage and exits 1 when hostname is empty', async () => {
    const client = makeClient({ apply: APPLY_PAYLOAD });
    await domainsPresetApplyAction(client, '');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });
});

describe('domainsPresetAddNamecheap', () => {
  it('forwards apiUser, apiKey, and clientIp to settings.namecheap.set', async () => {
    const client = makeClient({ namecheapSet: { ok: true, apiUser: 'nc-user' } });
    const result = await domainsPresetAddNamecheap(client, {
      apiUser: 'nc-user',
      apiKey: 'nc-key',
      clientIp: '1.2.3.4',
    });
    expect(result).toEqual({ ok: true, apiUser: 'nc-user' });
    expect((client as { settings: { namecheap: { set: ReturnType<typeof vi.fn> } } }).settings.namecheap.set).toHaveBeenCalledWith({
      apiUser: 'nc-user',
      apiKey: 'nc-key',
      clientIp: '1.2.3.4',
    });
  });

  it('throws a descriptive error when any of the three flags is missing', async () => {
    const client = makeClient({});
    await expect(
      domainsPresetAddNamecheap(client, { apiUser: 'u', apiKey: 'k' }),
    ).rejects.toThrow(/Missing required flags/);
    await expect(
      domainsPresetAddNamecheap(client, { apiUser: 'u', clientIp: '1.2.3.4' }),
    ).rejects.toThrow(/Missing required flags/);
    await expect(
      domainsPresetAddNamecheap(client, { apiKey: 'k', clientIp: '1.2.3.4' }),
    ).rejects.toThrow(/Missing required flags/);
  });

  it('action prints usage and exits 1 when flags are missing', async () => {
    const client = makeClient({});
    await domainsPresetAddNamecheapAction(client, {});
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/whitelisted/));
    expect(process.exitCode).toBe(1);
  });

  it('action surfaces upstream errors and exits 1', async () => {
    const client = makeClient({ namecheapSet: new Error('upstream 500') });
    await domainsPresetAddNamecheapAction(client, { apiUser: 'u', apiKey: 'k', clientIp: '1.2.3.4' });
    expect(h.errorSpy).toHaveBeenCalledWith('upstream 500');
    expect(process.exitCode).toBe(1);
  });

  it('action prints success and the next-step hint on success', async () => {
    const client = makeClient({ namecheapSet: { ok: true, apiUser: 'nc-user' } });
    await domainsPresetAddNamecheapAction(client, { apiUser: 'nc-user', apiKey: 'k', clientIp: '1.2.3.4' });
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/nc-user/));
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/dns_records_provider=namecheap/));
  });
});
