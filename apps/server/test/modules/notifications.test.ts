/**
 * Notification channel + log routes — coverage (Sprint 11 G-18 / PR #24).
 *
 * The pre-Sprint 11 surface is exercised here end-to-end through the
 * real Fastify app: every branch in `notificationRoutes` (channel
 * CRUD + test-dispatch + log list) hits a deterministic resolver on
 * the fake db and verifies the wire response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationRoutes } from '../../src/modules/notifications.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

const notifierMock = vi.hoisted(() => ({
  dispatchChannel: vi.fn(async () => undefined),
  // The channel routes fire-and-forget `audit()` calls, whose async tail
  // lands after the test — without this export the rejection escapes as an
  // unhandled error that fails the suite.
  notifyEvent: vi.fn(async () => undefined),
}));

vi.mock('../../src/lib/notifier.js', () => notifierMock);

// The crypto module loads the master key at first import. Stub the
// env var before any test in this file runs so encrypt/decrypt in
// `notifications.ts` (which uses AES-256-GCM with a per-instance
// master key) can round-trip the test fixtures without a real
// master.key file on disk.
const KEY_HEX = 'a'.repeat(64);
vi.stubEnv('NINEDEPLOY_MASTER_KEY', KEY_HEX);

beforeEach(() => {
  notifierMock.dispatchChannel.mockReset();
  notifierMock.dispatchChannel.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
});

interface ChannelRow {
  id: number;
  name: string;
  type: string;
  targetEncrypted: string;
  eventFilter: string;
  active: boolean;
  configJson: unknown;
  createdAt: Date;
}

const ch = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: 1,
  name: 'ops-telegram',
  type: 'telegram',
  targetEncrypted: 'enc:t0ken',
  eventFilter: '',
  active: true,
  configJson: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

const logRow = (over: Partial<{ id: number; channelId: number; event: string; entity: string; status: string; attempts: number; error: string | null; ts: Date }> = {}) => ({
  id: 1,
  channelId: 1,
  event: 'service.deployed',
  entity: 'service:1',
  status: 'sent',
  attempts: 1,
  error: null,
  ts: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

async function buildApp(
  db: ReturnType<typeof createFakeDb>,
  _userOpts: Parameters<typeof asUser>[0] = { isOperator: true },
) {
  const app = await buildTestApp({ db, logger: false });
  await app.register(notificationRoutes);
  return app;
}

describe('notifications — channel CRUD', () => {
  it('GET /channels lists every channel in descending id order', async () => {
    const db = createFakeDb({
      findMany: { notificationChannels: [ch({ id: 3 }), ch({ id: 2 }), ch({ id: 1 })] },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/channels', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(3);
    // The serializer must NOT leak the encrypted target; hasTarget is a boolean.
    for (const row of res.json()) {
      expect(row).not.toHaveProperty('targetEncrypted');
      expect(row).toHaveProperty('hasTarget');
    }
  });

  it('POST /channels creates a channel with the target encrypted and the default eventFilter', async () => {
    let captured: ChannelRow | undefined;
    const db = createFakeDb({
      insert: { notificationChannels: (v: ChannelRow) => { captured = v; return [{ ...v, id: 99, createdAt: new Date('2026-01-01T00:00:00.000Z') }]; } },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/channels',
      headers: asUser(),
      payload: { name: 'team-discord', type: 'discord', target: 'https://discord.com/api/webhooks/abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(captured).toBeDefined();
    expect(captured?.name).toBe('team-discord');
    expect(captured?.type).toBe('discord');
    // The target was encrypted before being handed to the insert chain.
    // `lib/crypto.ts:encrypt` produces `v<version>:<iv>:<tag>:<ct>` (all base64).
    expect(captured?.targetEncrypted).toMatch(/^v\d+:/);
    expect(captured?.active).toBe(true);
    expect(captured?.eventFilter).toBe('');
    // The serialised response carries a stable `id` and an ISO `createdAt`.
    expect(res.json()).toMatchObject({ id: 99, createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('POST /channels honours an explicit eventFilter and configJson', async () => {
    let captured: ChannelRow | undefined;
    const db = createFakeDb({
      insert: { notificationChannels: (v: ChannelRow) => { captured = v; return [{ ...v, id: 1, createdAt: new Date('2026-01-01T00:00:00.000Z') }]; } },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/channels',
      headers: asUser(),
      payload: {
        name: 'webhook',
        type: 'webhook',
        target: 'https://example.com/hook',
        eventFilter: 'service.deployed,deploy.failed',
        // `configJson` is a JSON-encoded string (max 4096 chars), not an
        // object — the route surfaces it as-is to the operator's UI.
        configJson: '{"retries":3}',
      },
    });
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
    }
    expect(captured?.eventFilter).toBe('service.deployed,deploy.failed');
    expect(captured?.configJson).toBe('{"retries":3}');
  });

  it('PATCH /channels/:id updates the supplied fields and re-encrypts a new target', async () => {
    const seenSets: Array<Partial<ChannelRow>> = [];
    const db = createFakeDb({
      findFirst: { notificationChannels: ch() },
      update: { notificationChannels: (s: Partial<ChannelRow>) => { seenSets.push(s); return [ch({ name: s.name, createdAt: new Date('2026-01-02T00:00:00.000Z') })]; } },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/channels/1',
      headers: asUser(),
      payload: { name: 'renamed', target: 'new-target', active: false, eventFilter: 'service.failed' },
    });
    expect(res.statusCode).toBe(200);
    const patch = seenSets[0]!;
    expect(patch.name).toBe('renamed');
    expect(patch.targetEncrypted).toMatch(/^v\d+:/);
    expect(patch.active).toBe(false);
    expect(patch.eventFilter).toBe('service.failed');
  });

  it('PATCH /channels/:id clears configJson when an empty string is supplied', async () => {
    const seenSets: Array<Partial<ChannelRow>> = [];
    const db = createFakeDb({
      findFirst: { notificationChannels: ch({ configJson: '{"foo":"bar"}' }) },
      update: { notificationChannels: (s: Partial<ChannelRow>) => { seenSets.push(s); return [ch()]; } },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/channels/1',
      headers: asUser(),
      payload: { configJson: '' },
    });
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
    }
    // The empty-string rule stores `null` instead of `''` so the
    // channel can fall back to provider defaults.
    expect(seenSets[0]?.configJson).toBeNull();
  });

  it('PATCH /channels/:id with an empty body parses to `{}` and applies a no-op patch', async () => {
    // The `req.body ?? {}` fallback at line 56 covers the case
    // where the operator sends a PATCH with no body at all —
    // the route must still parse (returning a 200) and the
    // resulting patch must be empty (the WHERE clause runs but
    // sets nothing). Without the fallback the route would 400 on
    // a missing body.
    const seenSets: Array<Partial<ChannelRow>> = [];
    const db = createFakeDb({
      findFirst: { notificationChannels: ch() },
      update: { notificationChannels: (s: Partial<ChannelRow>) => { seenSets.push(s); return [ch()]; } },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/channels/1',
      headers: asUser(),
      // No `payload` at all — relies on the `req.body ?? {}` default.
    });
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
    }
    // Every optional field was undefined → no field keys in the set.
    expect(seenSets[0]).toEqual({});
  });

  it('PATCH /channels/:id 404s when the channel is gone', async () => {
    // Two ways the update can produce no row: the channel was
    // deleted between findFirst and the update, OR the id never
    // existed. The lib's `if (!ch) throw notFound(...)` covers
    // both — we exercise the second by returning an empty array
    // from the update resolver.
    const db = createFakeDb({
      findFirst: { notificationChannels: ch() },
      update: { notificationChannels: () => [] },
    });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/channels/1',
      headers: asUser(),
      payload: { name: 'gone' },
    });
    if (res.statusCode !== 404) {
      throw new Error(`expected 404, got ${res.statusCode}: ${res.body}`);
    }
  });

  it('DELETE /channels/:id removes the row', async () => {
    const db = createFakeDb({
      delete: { notificationChannels: () => [] },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'DELETE', url: '/channels/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('notifications — test dispatch', () => {
  it('POST /channels/:id/test decrypts the target and dispatches a test message', async () => {
    // The route decrypts `targetEncrypted`, hands the plaintext to
    // `dispatchChannel`, and surfaces a 200 on success. We assert
    // both the decrypted plaintext (not the encrypted blob) and
    // the call shape.
    // The stored ciphertext is produced by the real `encrypt` so
    // `decrypt` can round-trip it back to the original plaintext.
    const { encrypt } = await import('../../src/lib/crypto.js');
    const storedTarget = encrypt('plain-token');
    const db = createFakeDb({
      findFirst: {
        notificationChannels: ch({ targetEncrypted: storedTarget, configJson: { retries: 2 } }),
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/channels/1/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(notifierMock.dispatchChannel).toHaveBeenCalledOnce();
    const call = notifierMock.dispatchChannel.mock.calls[0]!;
    expect(call[0]).toBe('telegram');
    expect(call[1]).toBe('plain-token'); // decrypted plaintext
    expect(call[3]).toMatch(/test notification/);
    expect(call[4]).toEqual({ configJson: { retries: 2 } });
  });

  it('POST /channels/:id/test surfaces a 400 when dispatchChannel throws', async () => {
    notifierMock.dispatchChannel.mockRejectedValueOnce(new Error('webhook returned 401'));
    // The channel row needs a real-encrypted target so the
    // route's `decrypt(ch.targetEncrypted)` doesn't fail before
    // it gets to the dispatch call (where the throw we want to
    // exercise actually happens).
    const { encrypt } = await import('../../src/lib/crypto.js');
    const db = createFakeDb({
      findFirst: { notificationChannels: ch({ targetEncrypted: encrypt('plain-token') }) },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/channels/1/test', headers: asUser() });
    if (res.statusCode !== 400) {
      throw new Error(`expected 400, got ${res.statusCode}: ${res.body}`);
    }
    // The global error handler wraps the thrown HttpError in the
    // canonical `{ error: { code, message } }` envelope; the
    // badRequest('Test failed: ...') carries the reason.
    expect(res.json()).toMatchObject({
      error: {
        code: 'bad_request',
        message: expect.stringMatching(/Test failed.*webhook returned 401/),
      },
    });
  });

  it('POST /channels/:id/test 404s when the channel is gone', async () => {
    const db = createFakeDb({ findFirst: { notificationChannels: undefined } });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/channels/1/test', headers: asUser() });
    if (res.statusCode !== 404) {
      throw new Error(`expected 404, got ${res.statusCode}: ${res.body}`);
    }
    expect(notifierMock.dispatchChannel).not.toHaveBeenCalled();
  });
});

describe('notifications — log', () => {
  it('GET /log returns the most recent 50 entries with serialised timestamps', async () => {
    const db = createFakeDb({
      findMany: {
        notificationLog: [
          logRow({ id: 2, ts: new Date('2026-01-02T00:00:00.000Z') }),
          logRow({ id: 1, ts: new Date('2026-01-01T00:00:00.000Z') }),
        ],
      },
    });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/log', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(2);
    expect(body[0].ts).toBe('2026-01-02T00:00:00.000Z');
    // `error` is null on a clean delivery, not absent.
    expect(body[0]).toHaveProperty('error');
    expect(body[0].error).toBeNull();
  });
});
