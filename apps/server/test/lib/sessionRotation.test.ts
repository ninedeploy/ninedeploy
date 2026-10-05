import { createDb, sessions } from '@ninedeploy/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { ttlSeconds, verifyJwt } from '../../src/lib/jwt.js';
import { issueSessionTokens, refreshSessionTokens } from '../../src/lib/sessions.js';

const NOW = 1_800_000_000_123;
const user = { id: 1, tokenVersion: 0 };
let fixture: ReturnType<typeof createDb>;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  fixture = createDb({ url: ':memory:' });
  await fixture.ready;
  await fixture.client!.executeMultiple(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO users VALUES (1);
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      jti TEXT NOT NULL UNIQUE, ip TEXT, user_agent TEXT,
      created_at INTEGER DEFAULT 0, last_used_at INTEGER,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
  `);
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.client?.close();
});

describe('session rotation with real SQLite and signed JWTs', () => {
  it.each([0, 123, 999])('refreshes a login issued at millisecond offset %i', async (offset) => {
    vi.mocked(Date.now).mockReturnValue(NOW - 123 + offset);
    const issued = await issueSessionTokens(fixture.db, user);
    const claims = await verifyJwt(issued.refreshToken);
    const row = (await fixture.db.query.sessions.findFirst())!;
    expect(claims.gen).toBe(row.expiresAt.getTime());
    const rotated = await refreshSessionTokens(fixture.db, user, claims.jti!, claims.gen);
    const next = await verifyJwt(rotated.refreshToken);
    expect(next.gen).toBe((await fixture.db.query.sessions.findFirst())!.expiresAt.getTime());
    expect(next.gen).toBeGreaterThan(claims.gen!);
    await expect(refreshSessionTokens(fixture.db, user, claims.jti!, claims.gen)).rejects.toThrow('session_revoked');
  });

  it('accepts a fractional generation from before timestamp alignment', async () => {
    const gen = NOW + ttlSeconds(config.jwt.refreshTtl) * 1000;
    await fixture.db.insert(sessions).values({ userId: 1, jti: 'fractional', expiresAt: new Date(gen) });
    const pair = await refreshSessionTokens(fixture.db, user, 'fractional', gen);
    const next = await verifyJwt(pair.refreshToken);
    expect(next.gen).toBe((await fixture.db.query.sessions.findFirst())!.expiresAt.getTime());
    await expect(refreshSessionTokens(fixture.db, user, 'fractional', gen)).rejects.toThrow('session_revoked');
  });

  it('allows only one concurrent use of a generation', async () => {
    const gen = NOW - 123 + 60_000;
    await fixture.db.insert(sessions).values({ userId: 1, jti: 'race', expiresAt: new Date(gen) });
    const read = fixture.db.query.sessions.findFirst.bind(fixture.db.query.sessions);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fixture.db.query.sessions, 'findFirst').mockImplementation(async (...args) => {
      const row = await read(...args);
      if (++reads === 2) release();
      await gate;
      return row;
    });
    const results = await Promise.allSettled([1, 2].map(() => refreshSessionTokens(fixture.db, user, 'race', gen)));
    spy.mockRestore();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused).toMatchObject({ reason: { message: 'session_revoked' } });
    await expect(refreshSessionTokens(fixture.db, user, 'race', gen)).rejects.toThrow('session_revoked');
  });

  it.each([0, -10_000])('retires the old generation with clock delta %i', async (delta) => {
    vi.mocked(Date.now).mockReturnValue(NOW - 123);
    const issued = await issueSessionTokens(fixture.db, user);
    const claims = await verifyJwt(issued.refreshToken);
    vi.mocked(Date.now).mockReturnValue(NOW - 123 + delta);
    const rotated = await refreshSessionTokens(fixture.db, user, claims.jti!, claims.gen);
    expect((await verifyJwt(rotated.refreshToken)).gen).toBeGreaterThan(claims.gen!);
    await expect(refreshSessionTokens(fixture.db, user, claims.jti!, claims.gen)).rejects.toThrow('session_revoked');
  });
});
