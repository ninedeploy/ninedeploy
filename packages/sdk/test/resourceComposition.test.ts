import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/index.js';
import type { Transport } from '../src/transport.js';

/**
 * `createClient` composes the per-resource modules with object spread
 * (`{ ...authApi(t), ...servicesApi(t), ... }`). A top-level key defined by two
 * modules would not fail: the later spread silently overwrites the earlier one,
 * and when both declare the same member type even the interface `extends` in
 * client.ts compiles. This guard builds every module's surface and fails on
 * any shared key, naming both modules.
 *
 * The modules are discovered from disk, so a new resources/*.ts file is
 * covered without editing this test — and one that client.ts forgets to
 * compose fails the "every key reaches the client" check below.
 */
const RESOURCES = new URL('../src/resources/', import.meta.url);

/** A transport that must never be called: building a surface is side-effect free. */
const inertTransport: Transport = {
  baseUrl: 'http://inert.test',
  requestWithHeaders: () => Promise.reject(new Error('inert transport')),
  request: () => Promise.reject(new Error('inert transport')),
  get: () => Promise.reject(new Error('inert transport')),
  send: () => Promise.reject(new Error('inert transport')),
};

type Factory = (t: Transport) => Record<string, unknown>;

async function loadSurfaces(): Promise<Array<{ module: string; factory: string; keys: string[] }>> {
  const files = readdirSync(RESOURCES).filter((f) => f.endsWith('.ts')).sort();
  const out: Array<{ module: string; factory: string; keys: string[] }> = [];
  for (const file of files) {
    const mod = (await import(new URL(file, RESOURCES).href)) as Record<string, unknown>;
    const factories = Object.entries(mod).filter(([name, v]) => typeof v === 'function' && name.endsWith('Api'));
    // One surface per module is the layout contract (resources/<area>.ts → <area>Api).
    expect(factories.map(([name]) => name), `resources/${file}`).toHaveLength(1);
    const [factory, fn] = factories[0]!;
    out.push({ module: `resources/${file}`, factory, keys: Object.keys((fn as Factory)(inertTransport)) });
  }
  return out;
}

/** Every key claimed by more than one module, with the claimants. */
function duplicateKeys(surfaces: Array<{ module: string; keys: string[] }>): Record<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const { module, keys } of surfaces) {
    for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), module]);
  }
  return Object.fromEntries([...owners].filter(([, mods]) => mods.length > 1));
}

describe('client composition from resources/*.ts', () => {
  it('no two resource modules define the same top-level client key', async () => {
    const surfaces = await loadSurfaces();
    expect(surfaces.length).toBeGreaterThan(1);
    for (const s of surfaces) expect(s.keys.length, `${s.module} exposes no keys`).toBeGreaterThan(0);
    expect(duplicateKeys(surfaces)).toEqual({});
  });

  it('every module key reaches the client, and the client has no key of its own', async () => {
    const surfaces = await loadSurfaces();
    const fromModules = surfaces.flatMap((s) => s.keys).sort();
    const client = createClient({ baseUrl: 'http://inert.test', fetch: () => Promise.reject(new Error('no network')) });
    expect(Object.keys(client).sort()).toEqual(fromModules);
  });

  it('the duplicate check reports both modules when a key is shared (negative control)', () => {
    expect(
      duplicateKeys([
        { module: 'resources/a.ts', keys: ['services', 'labels'] },
        { module: 'resources/b.ts', keys: ['deploys', 'services'] },
      ]),
    ).toEqual({ services: ['resources/a.ts', 'resources/b.ts'] });
  });
});
