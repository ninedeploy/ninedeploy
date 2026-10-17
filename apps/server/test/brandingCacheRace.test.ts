/**
 * F1030 — GET /v1/branding caches for 60 s and PATCH invalidates. A GET already
 * reading the config store when a PATCH landed finished afterwards and cached
 * its pre-PATCH values, so every later GET served the old branding for up to a
 * minute after a successful save. The slow read is held open on a latch, so no
 * timing is involved.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetBrandingCacheForTests, brandingRoutes } from '../src/modules/branding.js';

const OLD = 'https://old.example/logo.png';
const NEW = 'https://new.example/logo.png';

async function build(store: Map<string, unknown>, gate?: { reached: () => void; wait: Promise<void> }) {
  const reads = { count: 0 };
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorate('authenticate', async (req: { user: unknown }) => {
    req.user = { id: 1, isOperator: true };
  });
  app.decorate('requireOperator', async () => undefined);
  app.decorate('db', {});
  app.decorate('kernel', {
    configCenter: {
      get: async (key: string) => {
        reads.count++;
        const value = store.get(key) ?? null;
        if (gate) {
          gate.reached();
          await gate.wait;
        }
        return value;
      },
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
  });
  await app.register(brandingRoutes, { prefix: '/branding' });
  return { app, reads };
}

const getLogo = async (app: Awaited<ReturnType<typeof build>>['app']) => (await app.inject({ method: 'GET', url: '/branding' })).json().logoUrl;

afterEach(() => _resetBrandingCacheForTests());

describe('branding cache under an overlapping save (F1030)', () => {
  it('does not re-cache the pre-save values read by a GET that was in flight', async () => {
    const store = new Map<string, unknown>([['branding:logoUrl', OLD]]);
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const { app } = await build(store, { reached, wait });

    const inFlight = app.inject({ method: 'GET', url: '/branding' });
    await reachedP;
    expect((await app.inject({ method: 'PATCH', url: '/branding', payload: { logoUrl: NEW } })).statusCode).toBe(200);
    release();
    expect((await inFlight).json().logoUrl).toBe(OLD); // the overlapping read may answer with what it read ...
    expect(await getLogo(app)).toBe(NEW); // ... but the next GET sees the save
    await app.close();
  });

  it('still caches a read nothing overlapped', async () => {
    const store = new Map<string, unknown>([['branding:logoUrl', OLD]]);
    const { app, reads } = await build(store);
    expect(await getLogo(app)).toBe(OLD);
    const after = reads.count;
    expect(await getLogo(app)).toBe(OLD);
    expect(reads.count).toBe(after);
    await app.inject({ method: 'PATCH', url: '/branding', payload: { logoUrl: NEW } });
    expect(await getLogo(app)).toBe(NEW);
    await app.close();
  });
});
