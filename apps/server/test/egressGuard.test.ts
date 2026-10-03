import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPublicHttpUrl, guardedFetch, isPrivateAddress } from '../src/lib/egressGuard.js';
import { notifyEvent } from '../src/lib/notifier.js';
import { exchangeOidcCode, fetchOidcConfiguration, fetchOidcUserInfo } from '../src/lib/oauth.js';
import { encrypt } from '../src/lib/crypto.js';

/**
 * L-11 regression: operator-supplied URLs cannot be pointed at the host's own
 * network.
 *
 * Everything here uses IP LITERALS, so no test needs DNS and none of it
 * depends on what a resolver happens to answer.
 */

const fetchMock = vi.hoisted(() => vi.fn(async () => new Response('{}', { status: 200 })));
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockClear();
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
});

describe('isPrivateAddress', () => {
  it('names the addresses a server must not dial', () => {
    for (const ip of [
      '127.0.0.1', // loopback
      '169.254.169.254', // cloud instance metadata — the one that matters
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
      '::1',
      'fd00::1', // unique-local
      'fe80::1', // link-local
      '::ffff:169.254.169.254', // IPv4-mapped metadata
      '::ffff:a9fe:a9fe', // same address after WHATWG URL normalisation
      '64:ff9b::a9fe:a9fe', // RFC 6052 NAT64 metadata endpoint
      '2002:a9fe:a9fe::1', // 6to4 metadata endpoint
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('lets ordinary public addresses through', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '203.0.113.10', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('treats a non-address as unsafe rather than assuming', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('assertPublicHttpUrl', () => {
  it('refuses the cloud metadata endpoint', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/'))
      .rejects.toThrow(/private or link-local/);
  });

  it('refuses loopback, RFC1918 and bracketed IPv6 loopback', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:3000/hook')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://10.0.0.5/hook')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[::1]:3000/hook')).rejects.toThrow();
  });

  it('refuses non-http schemes and malformed URLs', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/scheme is not allowed/);
    await expect(assertPublicHttpUrl('gopher://203.0.113.1/')).rejects.toThrow(/scheme is not allowed/);
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/not a valid URL/);
  });

  it('allows a public literal', async () => {
    await expect(assertPublicHttpUrl('https://203.0.113.10/hook')).resolves.toBeInstanceOf(URL);
  });

  it('honours the operator escape hatch', async () => {
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
    await expect(assertPublicHttpUrl('http://127.0.0.1:3000/hook')).resolves.toBeInstanceOf(URL);
  });

  it('does not follow a validated public URL to an unchecked redirect target', async () => {
    await guardedFetch('https://203.0.113.10/redirect', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://203.0.113.10/redirect',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
  });
});

describe('the guard is actually wired into the sinks', () => {
  const EVENT = { id: 1, action: 'deploy.completed', entity: 'web', ts: '2026-01-01T00:00:00.000Z' };

  const channel = (type: string, url: string) => ({
    id: 3, type, targetEncrypted: encrypt(url), eventFilter: 'deploy,service', active: true,
  });

  function dbWith(channels: unknown[]) {
    const logged: Record<string, unknown>[] = [];
    const db = {
      query: { notificationChannels: { findMany: async () => channels } },
      insert: () => ({ values: async (v: Record<string, unknown>) => { logged.push(v); } }),
    } as never;
    return { db, logged };
  }

  it('sanity: this fixture DOES deliver when the target is public', async () => {
    // Without this control the "never sent" assertions below could pass for
    // the wrong reason (a filter that never matched).
    const { db, logged } = dbWith([channel('webhook', 'https://203.0.113.10/hook')]);
    await notifyEvent(db, EVENT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logged[0]).toMatchObject({ status: 'sent' });
  });

  it('a notification webhook aimed at cloud metadata is never sent', async () => {
    const { db, logged } = dbWith([channel('webhook', 'http://169.254.169.254/latest/meta-data/')]);
    await notifyEvent(db, EVENT);
    expect(fetchMock).not.toHaveBeenCalled();
    // refused, and the refusal is recorded rather than swallowed
    expect(logged[0]).toMatchObject({ status: 'failed' });
    expect(String(logged[0]!['error'])).toMatch(/Refusing to send an outbound request/);
  });

  it.each([
    ['discord', 'http://10.0.0.9/webhooks/1/x'],
    ['slack', 'http://127.0.0.1:9000/services/x'],
    ['ntfy', 'http://192.168.1.10/topic'],
  ])('a %s channel pointed inside the network is never sent', async (type, url) => {
    const { db } = dbWith([channel(type, url)]);
    await notifyEvent(db, EVENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the template registry refuses an internal source and falls back to the bundle', async () => {
    const { getTemplates, invalidateTemplateCache } = await import('../src/templates/registry.js');
    const { setSettingString } = await import('../src/lib/settings.js');
    void setSettingString;
    invalidateTemplateCache();
    const db = {
      query: { settings: { findFirst: async () => ({ key: 'templates_source', value: 'http://169.254.169.254/registry.json' }) } },
    } as never;
    const templates = await getTemplates(db);
    expect(fetchMock).not.toHaveBeenCalled();
    // fallback chain still yields the bundled registry rather than an error
    expect(templates.length).toBeGreaterThan(0);
    invalidateTemplateCache();
  });

  it('OIDC discovery, token exchange and userinfo all refuse internal hosts', async () => {
    await expect(fetchOidcConfiguration('http://169.254.169.254')).rejects.toThrow(/Refusing to send/);
    await expect(exchangeOidcCode('http://127.0.0.1:8080/token', 'id', 'secret', 'code', 'https://panel/cb'))
      .rejects.toThrow(/Refusing to send/);
    await expect(fetchOidcUserInfo('http://10.0.0.1/userinfo', 'access-token')).rejects.toThrow(/Refusing to send/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
