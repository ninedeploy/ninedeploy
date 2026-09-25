import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const base = mkdtempSync(path.join(os.tmpdir(), 'nd-registry-'));
  return {
    base,
    config: { paths: { dataDir: base }, templatesSource: null as string | null },
    getSettingString: vi.fn(async () => null as string | null),
  };
});

vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('../../src/lib/settings.js', () => ({ getSettingString: h.getSettingString }));

// The L-11 egress guard resolves the source host before fetching it; these
// tests are about the registry's cache/fallback logic and run offline. The
// guard's own wiring into fetchRemote is asserted in test/egressGuard.test.ts.
vi.mock('../../src/lib/egressGuard.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/egressGuard.js')>('../../src/lib/egressGuard.js');
  return { ...actual, guardedFetch: (url: string, init?: RequestInit) => fetch(url, init) };
});

import {
  BUNDLED_REGISTRY, getBundledTemplates, getTemplates, invalidateTemplateCache, parseBundle, parseTemplates,
} from '../../src/templates/registry.js';

const cacheFile = () => path.join(h.base, 'templates-cache.json');
const BUNDLE = { version: 1, updated: '2026-08-14', templates: [
  { id: 'x', name: 'X', tagline: 'x', description: 'x', category: 'Custom', emoji: '✨', image: 'x/img', port: 80 },
] };

afterAll(() => {
  rmSync(h.base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  h.getSettingString.mockReset().mockResolvedValue(null);
  h.config.templatesSource = null;
  invalidateTemplateCache();
  rmSync(cacheFile(), { force: true });
});

describe('bundled registry (default source)', () => {
  it('lists a non-empty, schema-valid template collection with unique ids', async () => {
    const templates = await getTemplates(null);
    expect(templates.length).toBeGreaterThan(10);
    const ids = new Set<string>();
    for (const t of templates) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(Number.isInteger(t.port)).toBe(true);
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
    }
  });

  it('known templates are present by id', async () => {
    const byId = new Map((await getTemplates(null)).map((t) => [t.id, t]));
    expect(byId.get('n8n')?.name).toBe('n8n');
    expect(byId.get('jellyfin')?.category).toBe('Media');
    expect(byId.get('ollama')?.featured).toBe(true);
    expect(byId.get('grafana')?.env?.some((e) => e.key === 'GF_SECURITY_ADMIN_PASSWORD')).toBe(true);
  });

  it('r320: a Docker socket is requested with dockerSocket, never mounted as a named volume', () => {
    // A volumeMount at /var/run/docker.sock creates an empty named-volume
    // DIRECTORY where the socket should be — wud watched nothing.
    for (const t of getBundledTemplates()) {
      expect(t.volumeMount ?? '', t.id).not.toMatch(/\.sock$/);
    }
    expect(getBundledTemplates().find((t) => t.id === 'wud')?.dockerSocket).toBe(true);
  });

  it('r320: speedtest-tracker mints the APP_KEY its image refuses to start without', () => {
    const t = getBundledTemplates().find((x) => x.id === 'speedtest-tracker');
    expect(t?.env?.find((e) => e.key === 'APP_KEY')).toMatchObject({ value: 'base64:', secret: true });
  });

  it('the bundled bundle parses cleanly', () => {
    expect(() => parseBundle(BUNDLED_REGISTRY)).not.toThrow();
    expect(getBundledTemplates().some((template) => template.id === 'ghost')).toBe(true);
  });
});

describe('parseBundle validation', () => {
  it('formats a missing-message issue without optional chaining fallbacks', () => {
    // A top-level non-array input yields an issues entry whose message exists;
    // the empty-path variant exercises the '' join branch.
    expect(() => parseTemplates('nope')).toThrow('Invalid registry bundle: template  Invalid input');
  });

  it('rejects non-objects and bundles without a template array', () => {
    expect(() => parseBundle(null)).toThrow('Invalid registry bundle');
    expect(() => parseBundle({ version: 1 })).toThrow('Invalid registry bundle');
  });

  it('reports the first schema violation precisely', () => {
    expect(() => parseTemplates([{ id: 'x', name: 'X', tagline: 'x', description: 'x', category: 'c', emoji: 'e', image: 'i', port: 'eighty' }])).toThrow(/port/);
  });

  it('accepts optional fields (env, volumeMount, website, docs, featured)', () => {
    const out = parseTemplates([{
      id: 'x', name: 'X', tagline: 'x', description: 'x', category: 'c', emoji: 'e', image: 'i', port: 1,
      volumeMount: '/data', website: 'https://x.test', docs: 'https://x.test/docs', featured: true,
      env: [{ key: 'K', value: 'v', secret: true }],
    }]);
    expect(out[0]?.env).toEqual([{ key: 'K', value: 'v', secret: true }]);
  });
});

describe('configured sources', () => {
  it('loads a local bundle from an absolute path (DB setting)', async () => {
    const file = path.join(h.base, 'custom.json');
    writeFileSync(file, JSON.stringify(BUNDLE));
    const db = {} as never;
    h.getSettingString.mockResolvedValue(file);
    expect((await getTemplates(db)).map((t) => t.id)).toEqual(['x']);
  });

  it('prefers the env var when no DB setting exists', async () => {
    const file = path.join(h.base, 'env.json');
    writeFileSync(file, JSON.stringify(BUNDLE));
    h.config.templatesSource = file;
    expect((await getTemplates({} as never))[0]?.id).toBe('x');
  });

  it('memoizes per source and invalidation clears it', async () => {
    const file = path.join(h.base, 'memo.json');
    writeFileSync(file, JSON.stringify(BUNDLE));
    h.getSettingString.mockResolvedValue(file);
    await getTemplates({} as never);
    writeFileSync(file, JSON.stringify({ ...BUNDLE, templates: [{ ...BUNDLE.templates[0]!, id: 'y' }] }));
    // Memoized: still the first load's data.
    expect((await getTemplates({} as never))[0]?.id).toBe('x');
    invalidateTemplateCache();
    expect((await getTemplates({} as never))[0]?.id).toBe('y');
  });

  it('falls back to the bundled registry when the settings read fails', async () => {
    h.getSettingString.mockRejectedValue(new Error('no table'));
    const templates = await getTemplates({} as never);
    expect(templates.length).toBeGreaterThan(10);
  });

  it('falls back to the bundled registry for an unreadable local source', async () => {
    h.getSettingString.mockResolvedValue('/nonexistent/registry.json');
    const templates = await getTemplates({} as never);
    expect(templates.length).toBeGreaterThan(10);
  });
});

describe('remote sources', () => {
  const URL_SRC = 'https://registry.example.com/registry.json';

  it('fetches a remote bundle and writes the cache', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => BUNDLE })));
    expect((await getTemplates({} as never))[0]?.id).toBe('x');
    expect(existsSync(cacheFile())).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8')).source).toBe(URL_SRC);
  });

  it('serves a fresh cache without refetching', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    writeFileSync(cacheFile(), JSON.stringify({ source: URL_SRC, fetchedAt: new Date().toISOString(), templates: BUNDLE.templates }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await getTemplates({} as never))[0]?.id).toBe('x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when the cache is stale or belongs to another source', async () => {
    writeFileSync(cacheFile(), JSON.stringify({ source: 'https://other.example.com/x.json', fetchedAt: new Date().toISOString(), templates: BUNDLE.templates }));
    h.getSettingString.mockResolvedValue(URL_SRC);
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return { ok: true, status: 200, json: async () => BUNDLE }; }));
    await getTemplates({} as never);
    expect(calls).toBe(1); // wrong-source cache → refetch

    invalidateTemplateCache();
    writeFileSync(cacheFile(), JSON.stringify({ source: URL_SRC, fetchedAt: new Date(Date.now() - 7 * 3600_000).toISOString(), templates: BUNDLE.templates }));
    await getTemplates({} as never);
    expect(calls).toBe(2); // stale cache → refetch
  });

  it('falls back to the stale cache when a refresh fails', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    writeFileSync(cacheFile(), JSON.stringify({ source: URL_SRC, fetchedAt: new Date(Date.now() - 7 * 3600_000).toISOString(), templates: BUNDLE.templates }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect((await getTemplates({} as never))[0]?.id).toBe('x');
  });

  it('ignores a cache entry without templates and falls back to bundled', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    writeFileSync(cacheFile(), JSON.stringify({ source: URL_SRC, fetchedAt: new Date().toISOString() }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const templates = await getTemplates({} as never);
    expect(templates.length).toBeGreaterThan(10);
  });

  it('falls back to the bundled registry when a fetch fails with no cache', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const templates = await getTemplates({} as never);
    expect(templates.length).toBeGreaterThan(10);
  });

  it('ignores a corrupt cache file', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    writeFileSync(cacheFile(), '{not json');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => BUNDLE })));
    expect((await getTemplates({} as never))[0]?.id).toBe('x');
  });

  it('rejects a non-ok remote response into the fallback chain', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const templates = await getTemplates({} as never);
    expect(templates.length).toBeGreaterThan(10);
  });

  it('ignores cache-write failures (read-only data dir simulation)', async () => {
    h.getSettingString.mockResolvedValue(URL_SRC);
    // A cache file already exists as a DIRECTORY → writeFileSync throws.
    writeFileSync(cacheFile(), 'x');
    rmSync(cacheFile());
    const fs = await import('node:fs');
    fs.mkdirSync(cacheFile());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => BUNDLE })));
    expect((await getTemplates({} as never))[0]?.id).toBe('x');
    fs.rmSync(cacheFile(), { recursive: true, force: true });
  });
});
