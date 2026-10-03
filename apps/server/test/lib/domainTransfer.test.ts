/**
 * G-29 domain transfer — lib coverage.
 *
 * `domainTransfer.ts` is the two-phase domain handover
 * (start -> accept). The behaviour worth pinning down:
 *  - the token is the random 32-byte base64url string the caller
 *    embeds in `acceptUrl`; the database stores only SHA-256.
 *  - a second `start` on the same domain is refused while a
 *    `pending` row exists (no race between two concurrent
 *    transfers).
 *  - `accept` re-checks source service is still alive, target
 *    service is admin-reachable for the caller, the row is
 *    still `pending` and not expired, and the caller's email
 *    equals the target email.
 *  - `pending -> expired` is a lazy transition computed from
 *    `expires_at`; there's no background sweep.
 *  - `cancel` is source-only by default; an instance operator
 *    can also cancel.
 *  - the accept URL is built from the panel origin (no
 *    trailing slash) plus the token.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, NOW } from '../helpers.js';

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

const userRows = new Map<number, { id: number; email: string }>();
const domainRows = new Map<number, { id: number; hostname: string; serviceId: number }>();
const serviceRows = new Map<number, { id: number; name: string; ownerUserId: number }>();
const transferRows = new Map<number, {
  id: number;
  domainId: number;
  sourceUserId: number;
  targetEmail: string;
  tokenSha256: string;
  status: 'pending' | 'accepted' | 'cancelled';
  expiresAt: number;
  createdAt: Date;
  acceptedAt: number | null;
  cancelledAt: number | null;
  targetUserId: number | null;
  targetServiceId: number | null;
}>();
let nextTransferId = 1;

function reset() {
  userRows.clear();
  domainRows.clear();
  serviceRows.clear();
  transferRows.clear();
  nextTransferId = 1;
}

function buildDb() {
  return createFakeDb({
    findFirst: {
      users: (args: unknown) => {
        const id = (args as { where?: { queryChunks?: Array<{ value?: unknown }> } })?.where?.queryChunks?.find(
          (c) => typeof c?.value === 'number',
        )?.value as number | undefined;
        if (id == null) return undefined;
        return userRows.get(id);
      },
      domains: (args: unknown) => {
        const id = (args as { where?: { queryChunks?: Array<{ value?: unknown }> } })?.where?.queryChunks?.find(
          (c) => typeof c?.value === 'number',
        )?.value as number | undefined;
        if (id == null) return undefined;
        return domainRows.get(id);
      },
      services: (args: unknown) => {
        const id = (args as { where?: { queryChunks?: Array<{ value?: unknown }> } })?.where?.queryChunks?.find(
          (c) => typeof c?.value === 'number',
        )?.value as number | undefined;
        if (id == null) return undefined;
        return serviceRows.get(id);
      },
      domainTransfers: (args: unknown) => {
        const tokenSha256 = (args as { where?: { queryChunks?: Array<{ value?: unknown }> } })?.where?.queryChunks?.find(
          (c) => typeof c?.value === 'string',
        )?.value as string | undefined;
        if (tokenSha256 == null) return undefined;
        return [...transferRows.values()].find((r) => r.tokenSha256 === tokenSha256);
      },
    },
    select: {
      // (hostname, email) projections: return the first matching row.
      // Aliased columns (`sourceEmail`, `targetEmail`) are matched
      // by the underlying `users.email` field.
      domains: (cols: unknown) => {
        if (!cols) return [];
        const keys = Object.keys(cols as Record<string, unknown>);
        if (keys.length === 0) {
          // No projection: return the full rows so domainTransfer can
          // pick fields it actually needs.
          return [...domainRows.values()].map((d) => ({ ...d }));
        }
        // Map each known column to its row value.
        return [...domainRows.values()].map((d) => {
          const row: Record<string, unknown> = {};
          for (const k of keys) {
            if (k === 'hostname') row[k] = d.hostname;
            // Aliased: domainTransfer joins to `users` for emails.
            if (k === 'sourceEmail') {
              const src = [...userRows.values()].find((u) => u.id === d.id);
              row[k] = src?.email ?? null;
            }
            if (k === 'targetEmail') {
              // Falls back to the first user — previewTransfer uses
              // the transfer row's targetEmail directly via findFirst.
              const tgt = [...userRows.values()][0];
              row[k] = tgt?.email ?? null;
            }
          }
          return row;
        });
      },
      users: (cols: unknown) => {
        if (!cols) return [];
        const keys = Object.keys(cols as Record<string, unknown>);
        return [...userRows.values()].map((u) => {
          const row: Record<string, unknown> = {};
          for (const k of keys) {
            if (k === 'email') row[k] = u.email;
            if (k === 'id') row[k] = u.id;
          }
          return row;
        });
      },
      // domainTransfer.previewTransfer reads the transfer row plus
      // a join to source / target users. The lib resolves emails
      // via separate `findFirst.users` calls; the projection here
      // is a fallback in case the test exercises the join path.
      domainTransfers: (cols: unknown) => {
        if (!cols) return [];
        return [...transferRows.values()].map((t) => ({ ...t }));
      },
    },
    insert: {
      domainTransfers: (value: Record<string, unknown>) => {
        const id = nextTransferId++;
        const row = {
          id,
          domainId: value['domainId'] as number,
          sourceUserId: value['sourceUserId'] as number,
          targetEmail: value['targetEmail'] as string,
          tokenSha256: value['tokenSha256'] as string,
          status: (value['status'] ?? 'pending') as 'pending' | 'accepted' | 'cancelled',
          expiresAt: value['expiresAt'] as number,
          createdAt: NOW,
          acceptedAt: null,
          cancelledAt: null,
          targetUserId: null,
          targetServiceId: null,
        };
        transferRows.set(id, row);
        return [row];
      },
    },
    update: {
      domainTransfers: (value: Record<string, unknown>, args: unknown) => {
        // The lib calls `update(domainTransfers).set({...}).where(eq(id, X))`.
        // Drizzle's `eq(col, val)` returns a SQL object whose
        // `queryChunks` array carries the bound values; we read the
        // numeric id from there to filter which in-memory row to
        // mutate.
        const chunks = (args as { queryChunks?: Array<{ value?: unknown }> } | undefined)?.queryChunks;
        const id = Array.isArray(chunks)
          ? (chunks.find((c) => typeof c?.value === 'number')?.value as number | undefined)
          : undefined;
        for (const r of transferRows.values()) {
          if (id != null && r.id !== id) continue;
          if (value['status'] === 'accepted') {
            r.status = 'accepted';
            r.acceptedAt = (value['acceptedAt'] as number) ?? r.acceptedAt;
            r.targetUserId = (value['targetUserId'] as number) ?? r.targetUserId;
            r.targetServiceId = (value['targetServiceId'] as number) ?? r.targetServiceId;
          } else if (value['status'] === 'cancelled') {
            r.status = 'cancelled';
            r.cancelledAt = (value['cancelledAt'] as number) ?? r.cancelledAt;
          }
        }
        return [value];
      },
      domains: (value: Record<string, unknown>, args: unknown) => {
        const chunks = (args as { queryChunks?: Array<{ value?: unknown }> } | undefined)?.queryChunks;
        const id = Array.isArray(chunks)
          ? (chunks.find((c) => typeof c?.value === 'number')?.value as number | undefined)
          : undefined;
        const serviceId = value['serviceId'] as number;
        for (const d of domainRows.values()) {
          if (id != null && d.id !== id) continue;
          d.serviceId = serviceId;
        }
        return [value];
      },
    },
    counts: {},
  });
}

beforeEach(() => {
  reset();
});

afterEach(() => {
  reset();
});

describe('lib/domainTransfer', () => {
  describe('startTransfer', () => {
    it('refuses an invalid target email', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const { startTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(
        startTransfer(db, { domainId: 10, sourceUserId: 1, targetEmail: 'not-an-email', panelOrigin: 'https://panel.example.com' }),
      ).rejects.toThrow(/not a valid email/);
    });

    it('refuses a transfer to the source user themselves', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const { startTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(
        startTransfer(db, {
          domainId: 10,
          sourceUserId: 1,
          targetEmail: 'SRC@example.com', // case-insensitive compare
          panelOrigin: 'https://panel.example.com',
        }),
      ).rejects.toThrow(/same user/);
    });

    it('refuses a transfer on a non-existent domain', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      const { startTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(
        startTransfer(db, { domainId: 999, sourceUserId: 1, targetEmail: 'tgt@example.com', panelOrigin: 'https://panel.example.com' }),
      ).rejects.toThrow(/Domain not found/);
    });

    it('refuses a second pending transfer on the same domain', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      // Seed a pending transfer for domain 10.
      const token = 'already-pending-token';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'first@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { startTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(
        startTransfer(db, { domainId: 10, sourceUserId: 1, targetEmail: 'tgt@example.com', panelOrigin: 'https://panel.example.com' }),
      ).rejects.toThrow(/pending transfer already exists/);
    });

    it('persists a SHA-256 token and returns the plaintext + acceptUrl', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const { startTransfer } = await import('../../src/lib/domainTransfer.js');
      const result = await startTransfer(db, {
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'Tgt@Example.COM', // lowercased on the way in
        panelOrigin: 'https://panel.example.com/',
      });
      expect(result.hostname).toBe('a.example.com');
      // Token is base64url and decodes to 32 random bytes.
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // DB stored the SHA-256 of the token, not the token itself.
      const stored = [...transferRows.values()][0]!;
      expect(stored.tokenSha256).toBe(sha256Hex(result.token));
      expect(stored.targetEmail).toBe('tgt@example.com');
      // Accept URL uses the panel origin with the trailing slash
      // stripped, and embeds the plaintext token.
      expect(result.acceptUrl).toBe(`https://panel.example.com/domains/transfers/${result.token}/accept`);
      // Expiry is roughly 7 days from now.
      const sevenDays = 7 * 24 * 60 * 60;
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + sevenDays - 5);
      expect(result.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + sevenDays + 5);
    });
  });

  describe('previewTransfer', () => {
    it('returns null for an unknown token', async () => {
      const db = buildDb();
      const { previewTransfer } = await import('../../src/lib/domainTransfer.js');
      const result = await previewTransfer(db, 'no-such-token');
      expect(result).toBeNull();
    });

    it('returns a populated preview for a known token', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const token = 'preview-token';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { previewTransfer } = await import('../../src/lib/domainTransfer.js');
      const result = await previewTransfer(db, token);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.hostname).toBe('a.example.com');
      expect(result!.sourceEmail).toBe('src@example.com');
      expect(result!.targetEmail).toBe('tgt@example.com');
      expect(result!.status).toBe('pending');
      expect(result!.effectivelyExpired).toBe(false);
      expect(result!.acceptedAt).toBeNull();
      expect(result!.cancelledAt).toBeNull();
    });

    it('marks a past-expiry pending row as effectively expired', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const token = 'expired-token';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending', // DB row still says pending, but expires_at is past
        expiresAt: Math.floor(Date.now() / 1000) - 60,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { previewTransfer } = await import('../../src/lib/domainTransfer.js');
      const result = await previewTransfer(db, token);
      expect(result!.status).toBe('expired');
      expect(result!.effectivelyExpired).toBe(true);
    });
  });

  describe('acceptTransfer', () => {
    it('rejects a missing token', async () => {
      const db = buildDb();
      const { acceptTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(acceptTransfer(db, { token: '', userId: 1, targetServiceId: 100 })).rejects.toThrow(/token is required/);
    });

    it('rejects an unknown token', async () => {
      const db = buildDb();
      const { acceptTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(acceptTransfer(db, { token: 'nope', userId: 1, targetServiceId: 100 })).rejects.toThrow(/Transfer not found/);
    });

    it('rejects a transfer already in a terminal state', async () => {
      const db = buildDb();
      userRows.set(2, { id: 2, email: 'tgt@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const token = 'accepted-token';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'accepted',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: Math.floor(Date.now() / 1000),
        cancelledAt: null,
        targetUserId: 2,
        targetServiceId: 200,
      });
      const { acceptTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(acceptTransfer(db, { token, userId: 2, targetServiceId: 200 })).rejects.toThrow(/accepted/);
    });

    it('rejects when the caller is signed in as a different user', async () => {
      const db = buildDb();
      userRows.set(2, { id: 2, email: 'tgt@example.com' });
      userRows.set(3, { id: 3, email: 'attacker@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const token = 'mismatch-token';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { acceptTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(acceptTransfer(db, { token, userId: 3, targetServiceId: 200 })).rejects.toThrow(/different email/);
    });

    it('moves the domain to the target service and flips the transfer to accepted', async () => {
      const db = buildDb();
      userRows.set(1, { id: 1, email: 'src@example.com' });
      userRows.set(2, { id: 2, email: 'tgt@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      serviceRows.set(100, { id: 100, name: 'src-svc', ownerUserId: 1 });
      serviceRows.set(200, { id: 200, name: 'tgt-svc', ownerUserId: 2 });
      const token = 'happy-token';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { acceptTransfer } = await import('../../src/lib/domainTransfer.js');
      const result = await acceptTransfer(db, { token, userId: 2, targetServiceId: 200 });
      expect(result.domainId).toBe(10);
      expect(result.serviceId).toBe(200);
      expect(result.fromServiceId).toBe(100);
      expect(result.hostname).toBe('a.example.com');
      // The in-memory map records the move.
      expect(domainRows.get(10)!.serviceId).toBe(200);
      // The transfer row was flipped.
      const tr = transferRows.get(1)!;
      expect(tr.status).toBe('accepted');
      expect(tr.targetUserId).toBe(2);
      expect(tr.targetServiceId).toBe(200);
      expect(tr.acceptedAt).not.toBeNull();
    });

    it('rejects when the target service does not exist', async () => {
      const db = buildDb();
      userRows.set(2, { id: 2, email: 'tgt@example.com' });
      domainRows.set(10, { id: 10, hostname: 'a.example.com', serviceId: 100 });
      const token = 'no-svc';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { acceptTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(acceptTransfer(db, { token, userId: 2, targetServiceId: 999 })).rejects.toThrow(/Target service not found/);
    });

    it('rejects when the domain was deleted between start and accept', async () => {
      const db = buildDb();
      userRows.set(2, { id: 2, email: 'tgt@example.com' });
      serviceRows.set(200, { id: 200, name: 'tgt-svc', ownerUserId: 2 });
      const token = 'gone-domain';
      transferRows.set(1, {
        id: 1,
        // domainId points to a row that does not exist in domainRows.
        domainId: 999,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { acceptTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(acceptTransfer(db, { token, userId: 2, targetServiceId: 200 })).rejects.toThrow(/no longer exists/);
    });
  });

  describe('cancelTransfer', () => {
    it('rejects a non-source, non-operator caller', async () => {
      const db = buildDb();
      const token = 'cancel-token';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { cancelTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(cancelTransfer(db, token, 99, false)).rejects.toThrow(/Only the source user/);
    });

    it('lets the source user cancel a pending transfer', async () => {
      const db = buildDb();
      const token = 'src-cancel';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { cancelTransfer } = await import('../../src/lib/domainTransfer.js');
      const result = await cancelTransfer(db, token, 1, false);
      expect(result).toEqual({ transferId: 1, status: 'cancelled' });
      const tr = transferRows.get(1)!;
      expect(tr.status).toBe('cancelled');
      expect(tr.cancelledAt).not.toBeNull();
    });

    it('lets an instance operator cancel any transfer', async () => {
      const db = buildDb();
      const token = 'op-cancel';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'pending',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: null,
        cancelledAt: null,
        targetUserId: null,
        targetServiceId: null,
      });
      const { cancelTransfer } = await import('../../src/lib/domainTransfer.js');
      const result = await cancelTransfer(db, token, 999, true);
      expect(result.status).toBe('cancelled');
    });

    it('refuses to cancel a transfer that is not pending', async () => {
      const db = buildDb();
      const token = 'already-accepted';
      transferRows.set(1, {
        id: 1,
        domainId: 10,
        sourceUserId: 1,
        targetEmail: 'tgt@example.com',
        tokenSha256: sha256Hex(token),
        status: 'accepted',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: NOW,
        acceptedAt: Math.floor(Date.now() / 1000),
        cancelledAt: null,
        targetUserId: 2,
        targetServiceId: 200,
      });
      const { cancelTransfer } = await import('../../src/lib/domainTransfer.js');
      await expect(cancelTransfer(db, token, 1, false)).rejects.toThrow(/accepted/);
    });
  });
});
