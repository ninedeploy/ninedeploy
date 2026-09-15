import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { notificationRoutes } from '../src/modules/notifications.js';
import { asUser, buildTestApp, channelRow, createFakeDb, notifLogRow } from './helpers.js';

describe('notification routes', () => {
  // These tests stub global fetch — no real outbound traffic happens. The
  // egress guard cannot know that and DNS-resolves the fixture hostnames
  // (h.example.com), which do not resolve; allow private egress for the
  // stubbed calls.
  const previousEgress = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  beforeEach(() => {
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
  });
  afterEach(() => {
    if (previousEgress === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = previousEgress;
  });

  it('lists channels', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          notificationChannels: [
            channelRow({ id: 1, name: 'ops', targetEncrypted: encrypt('target') }),
            channelRow({ id: 2, name: 'empty', targetEncrypted: '' }),
          ],
        },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'GET', url: '/channels', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toMatchObject({ id: 1, name: 'ops', hasTarget: true });
    expect(rows[1]).toMatchObject({ id: 2, name: 'empty', hasTarget: false });
  });

  it('creates a channel', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { notification_channels: [channelRow({ id: 5, name: 'ops', type: 'webhook' })] } }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/channels',
      headers: asUser(),
      payload: { name: 'ops', type: 'webhook', target: 'https://example.com/hook' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 5, name: 'ops', type: 'webhook', active: true });
  });

  it('rejects channels missing required fields', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'POST', url: '/channels', headers: asUser(), payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a channel request without a body', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels', headers: asUser() });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid channel type', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/channels',
      headers: asUser(),
      payload: { name: 'x', type: 'pigeon', target: 't' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('patches a channel eventFilter and active state', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ update: { notification_channels: [channelRow({ id: 5, eventFilter: 'deploy.', active: false })] } }),
    });
    await app.register(notificationRoutes);
    const both = await app.inject({
      method: 'PATCH', url: '/channels/5', headers: asUser(), payload: { eventFilter: 'deploy.', active: false },
    });
    expect(both.statusCode).toBe(200);
    expect(both.json()).toMatchObject({ eventFilter: 'deploy.', active: false });
    const filterOnly = await app.inject({
      method: 'PATCH', url: '/channels/5', headers: asUser(), payload: { eventFilter: 'backup.' },
    });
    expect(filterOnly.statusCode).toBe(200);
  });

  it('patches a channel name and target, encrypting the target at rest', async () => {
    let setPatch: Record<string, unknown> | null = null;
    const app = await buildTestApp({
      db: createFakeDb({
        update: {
          notification_channels: (patch: unknown) => {
            const p = patch as Record<string, unknown>;
            setPatch = p;
            return [channelRow({ id: 5, ...p })];
          },
        },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/channels/5', headers: asUser(),
      payload: { name: 'ops-renamed', target: 'https://hooks.example.com/new' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 5, name: 'ops-renamed', hasTarget: true });
    expect(setPatch).toMatchObject({ name: 'ops-renamed' });
    // The target is stored encrypted — a later read must decrypt it back.
    expect(typeof setPatch?.targetEncrypted).toBe('string');
    expect(decrypt(setPatch?.targetEncrypted as string)).toBe('https://hooks.example.com/new');
    // Fields not present in the request are omitted from the UPDATE, not blanked.
    expect('eventFilter' in (setPatch ?? {})).toBe(false);
    expect('active' in (setPatch ?? {})).toBe(false);
  });

  it('applies only the fields present in the patch', async () => {
    let setPatch: Record<string, unknown> | null = null;
    const app = await buildTestApp({
      db: createFakeDb({
        update: {
          notification_channels: (patch: unknown) => {
            const p = patch as Record<string, unknown>;
            setPatch = p;
            return [channelRow({ id: 5, ...p })];
          },
        },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/channels/5', headers: asUser(), payload: { name: 'x', active: true },
    });
    expect(res.statusCode).toBe(200);
    expect(setPatch).toMatchObject({ name: 'x', active: true });
    expect('targetEncrypted' in (setPatch ?? {})).toBe(false);
    expect('eventFilter' in (setPatch ?? {})).toBe(false);
  });

  it('returns 404 when patching a missing channel', async () => {
    const app = await buildTestApp({ db: createFakeDb({ update: { notification_channels: [] } }) });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/channels/99', headers: asUser(), payload: { active: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('patches a channel with an empty body', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ update: { notification_channels: [channelRow({ id: 5 })] } }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/channels/5', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 5 });
  });

  it('deletes a channel', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/channels/5', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('tests a telegram channel successfully', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'telegram', targetEncrypted: encrypt('bot:chat') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails a telegram channel test when the API errors', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'forbidden' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'telegram', targetEncrypted: encrypt('bot:chat') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Telegram API 403');
  });

  it('tests a webhook channel', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'webhook', targetEncrypted: encrypt('https://h.example.com') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('fails a webhook channel test on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'webhook', targetEncrypted: encrypt('https://h.example.com') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Webhook 500');
  });

  it('tests a gotify channel against its message endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'gotify', targetEncrypted: encrypt('https://push.example.com/message?token=Axxx') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://push.example.com/message?token=Axxx',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects a gotify channel whose target has no token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'gotify', targetEncrypted: encrypt('https://push.example.com/message') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('?token=');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests a pushover channel with form-encoded credentials', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'pushover', targetEncrypted: encrypt('appToken123@userKey456') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects a pushover channel without the @ separator', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'pushover', targetEncrypted: encrypt('justAUserKey') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('appToken@userKey');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests a lark channel and surfaces its error code', async () => {
    // Lark answers HTTP 200 even when it rejects — the code lives in the body.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'lark', targetEncrypted: encrypt('https://open.larksuite.com/open-apis/bot/v2/hook/x') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('fails a lark channel test when the bot returns an error code', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 19001, msg: 'invalid uri' }) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'lark', targetEncrypted: encrypt('https://open.larksuite.com/open-apis/bot/v2/hook/x') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Lark error 19001');
  });

  it('tests a discord channel', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'discord', targetEncrypted: encrypt('https://discord.example.com') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('fails a discord channel test when fetch rejects', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'discord', targetEncrypted: encrypt('https://discord.example.com') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('network');
  });

  it('fails a discord channel test on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'discord', targetEncrypted: encrypt('https://discord.example.com') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Discord 502');
  });

  it('fails for an unknown channel type without calling fetch', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'pigeon', targetEncrypted: encrypt('x') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Unknown notification channel type: pigeon');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats non-Error test failures', async () => {
    const fetchMock = vi.fn(async () => { throw 'plain string'; }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 5, type: 'webhook', targetEncrypted: encrypt('https://h.example.com') }) },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/5/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('plain string');
  });

  it('returns 404 when testing a missing channel', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/99/test', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('lists the notification log', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findMany: { notificationLog: [notifLogRow({ id: 3, event: 'deploy.completed' })] } }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'GET', url: '/log', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: 3,
        channelId: 1,
        event: 'deploy.completed',
        entity: null,
        status: 'sent',
        attempts: 2,
        error: null,
        ts: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });
});

// ─── Sprint 5 G-18 PR-A: notification_channels.config_json ────────────────
describe('notification channels configJson (G-18 PR-A)', () => {
  const previousEgress = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  beforeEach(() => {
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
  });
  afterEach(() => {
    if (previousEgress === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = previousEgress;
  });

  it('surfaces configJson in the list response', async () => {
    const cfg = JSON.stringify({ title: 'Deploy', color: 0xff0000 });
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          notificationChannels: [channelRow({ id: 1, name: 'ops', type: 'discord', targetEncrypted: encrypt('https://h.example.com'), configJson: cfg })],
        },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'GET', url: '/channels', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ configJson: cfg });
  });

  it('persists configJson on POST /channels', async () => {
    const cfg = JSON.stringify({ title: 'Deploy' });
    const inserts: unknown[] = [];
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          // Resolver receives the values object as its first arg; capture it
          // so the test can assert what the route actually persisted.
          notification_channels: (values: unknown) => {
            inserts.push(values);
            return [channelRow({ id: 7, name: 'discord-ops', type: 'discord', targetEncrypted: encrypt('https://h.example.com'), configJson: cfg })];
          },
        },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/channels',
      headers: asUser(),
      payload: { name: 'discord-ops', type: 'discord', target: 'https://h.example.com', configJson: cfg },
    });
    expect(res.statusCode).toBe(200);
    expect(inserts[0]).toMatchObject({ configJson: cfg });
  });

  it('clears configJson when PATCH sends an empty string', async () => {
    const updates: unknown[] = [];
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { notificationChannels: channelRow({ id: 8, type: 'discord', targetEncrypted: encrypt('https://h.example.com'), configJson: '{"title":"old"}' }) },
        update: {
          notification_channels: (set: unknown) => {
            updates.push(set);
            return [channelRow({ id: 8, type: 'discord', targetEncrypted: encrypt('https://h.example.com'), configJson: null })];
          },
        },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/channels/8',
      headers: asUser(),
      payload: { configJson: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({ configJson: null });
  });

  it('forwards configJson when testing a discord channel', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const cfg = JSON.stringify({ title: 'Test', color: 0x00ff00 });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          notificationChannels: channelRow({
            id: 9,
            type: 'discord',
            targetEncrypted: encrypt('https://h.example.com'),
            configJson: cfg,
          }),
        },
      }),
    });
    await app.register(notificationRoutes);
    const res = await app.inject({ method: 'POST', url: '/channels/9/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.embeds).toEqual([{ title: 'Test', description: expect.any(String), color: 0x00ff00 }]);
  });
});
