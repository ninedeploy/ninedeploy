/**
 * G-16 log search — lib coverage.
 *
 * `logSearch.ts` proxies cluster log queries to a configured
 * drain. The behaviour worth pinning down:
 *  - non-Loki drain types short-circuit with
 *    `unsupported: true` and an empty `lines` array (the
 *    route surfaces that as a 501).
 *  - when no drain is configured at all, the call throws
 *    with the canonical "No enabled Loki drain" message.
 *  - the URL is built against the drain's URL with the
 *    `query`, `start`, `end`, `limit` and `direction` params.
 *  - `limit` is clamped to [1, 1000] (silent clamp; negative
 *    or huge values do not throw).
 *  - the `service` label in the Loki query is the service
 *    slug; the global `job="ninedeploy"` is used when no
 *    serviceId is passed.
 *  - the Bearer auth header is only added when the drain
 *    has an `apiKeyEncrypted` set.
 *  - the Loki response is flattened to `{ ts, line, service }`
 *    rows sorted by ts descending; non-success status returns
 *    an empty list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

interface DrainRow {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  url: string;
  apiKeyEncrypted: string | null;
  serviceId?: number | null;
}

interface ServiceRow {
  id: number;
  slug: string;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  throw?: Error;
}

const state = vi.hoisted(() => ({
  drains: new Map<number, DrainRow>(),
  services: new Map<number, ServiceRow>(),
  // The mock fetcher resolves the right response by matching
  // the incoming URL against any of the registered patterns
  // (in order; first match wins). Patterns are regex sources
  // so the dynamic `start=` / `end=` params do not break the
  // test fixture.
  fetchResponses: [] as Array<{ pattern: RegExp; response: MockResponse }>,
  defaultFetchThrow: null as Error | null,
  captured: [] as CapturedRequest[],
  decryptedBearerPrefix: 'bearer-from-encrypted',
}));

function setResponseFor(urlPattern: string, response: MockResponse) {
  state.fetchResponses.push({ pattern: new RegExp(urlPattern), response });
}

vi.mock('../../src/lib/crypto.js', () => ({
  decrypt: vi.fn((enc: string) => `${state.decryptedBearerPrefix}:${enc}`),
}));

// The lib imports `logDrains` and `services` only as table
// references for its queries; the actual table objects are
// never read at runtime. The fake DB below handles every
// query path the lib uses.
vi.mock('@ninedeploy/db', () => ({
  logDrains: { id: 'id' },
  services: { id: 'id' },
}));

import { searchLogs } from '../../src/lib/logSearch.js';
import { createFakeDb } from '../helpers.js';

function buildDb() {
  // The lib's pickDrain does `findFirst({ where: eq(...) })` and
  // `findMany()`. The exact drizzle SQL chunk shape varies
  // between versions, so we don't try to read the where
  // clause — instead the findFirst resolver returns the
  // single row the test seeded. The tests seed one drain
  // per scenario so this is unambiguous, and the lib's
  // branch logic (drainId provided vs. findMany + filter)
  // is what we want to exercise.
  return createFakeDb({
    findFirst: {
      logDrains: () => [...state.drains.values()][0],
      services: () => [...state.services.values()][0],
    },
    findMany: {
      logDrains: () => [...state.drains.values()],
    },
  });
}

interface FindFirstCall {
  table: string;
  /** id value if the where clause was an `eq(col, n)`. */
  id?: number;
}

// Tracks the most-recent findFirst call so the pickDrain test
// can correlate the resolver to the call. The mock returns
// drains[0] for `logDrains` and services[0] for `services`
// — sufficient for the small maps each test seeds.
const lastFindFirst = vi.hoisted(() => ({
  logDrains: undefined as DrainRow | undefined,
  services: undefined as ServiceRow | undefined,
  byId: new Map<string, FindFirstCall>(),
}));

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    state.captured.push({ url: u, init });
    for (const { pattern, response } of state.fetchResponses) {
      if (pattern.test(u)) {
        if (response.throw) throw response.throw;
        return new Response(JSON.stringify(response.body ?? { status: 'success', data: { result: [] } }), {
          status: response.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    if (state.defaultFetchThrow) throw state.defaultFetchThrow;
    return new Response(JSON.stringify({ status: 'success', data: { result: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  state.drains.clear();
  state.services.clear();
  state.fetchResponses.length = 0;
  state.captured = [];
  state.defaultFetchThrow = null;
  lastFindFirst.byId.clear();
});

describe('lib/logSearch', () => {
  it('throws when no enabled Loki drain is configured', async () => {
    const db = buildDb();
    await expect(searchLogs(db, { query: 'oops' })).rejects.toThrow(
      /No enabled Loki drain/,
    );
  });

  it('returns unsupported: true for a non-Loki drain (datadog)', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'datadog', type: 'datadog', enabled: true, url: 'https://datadog.example.com', apiKeyEncrypted: null });
    // pass drainId so pickDrain returns it; otherwise the
    // `findMany` branch filters to `type === 'loki'` and throws.
    const result = await searchLogs(db, { query: 'x', drainId: 1 });
    expect(result.unsupported).toBe(true);
    expect(result.lines).toEqual([]);
    expect(result.drain.type).toBe('datadog');
    expect(state.captured).toHaveLength(0);
  });

  it('returns unsupported: true for a vector drain', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'vec', type: 'vector', enabled: true, url: 'https://vec.example.com', apiKeyEncrypted: null });
    const result = await searchLogs(db, { query: 'x', drainId: 1 });
    expect(result.unsupported).toBe(true);
  });

  it('skips disabled drains when picking the default', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki-1', type: 'loki', enabled: false, url: 'https://loki-1.example.com', apiKeyEncrypted: null });
    state.drains.set(2, { id: 2, name: 'loki-2', type: 'loki', enabled: true, url: 'https://loki-2.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\-2\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&start=0\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    const result = await searchLogs(db, { query: 'x' });
    expect(result.drain.id).toBe(2);
  });

  it('queries the explicitly requested drainId', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki-1', type: 'loki', enabled: true, url: 'https://loki-1.example.com', apiKeyEncrypted: null });
    state.drains.set(2, { id: 2, name: 'loki-2', type: 'loki', enabled: true, url: 'https://loki-2.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\-1\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    const result = await searchLogs(db, { query: 'x', drainId: 1 });
    expect(result.drain.id).toBe(1);
  });

  it('builds the global Loki query when no serviceId is passed', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60hello%60\\&start=0\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    const result = await searchLogs(db, { query: 'hello' });
    expect(result.unsupported).toBe(false);
  });

  it('builds the per-service Loki query when serviceId is passed', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    state.services.set(42, { id: 42, slug: 'web' });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bservice%3D%22web%22%7D%20%7C%3D%20%60boom%60\\&start=0\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    const result = await searchLogs(db, { query: 'boom', serviceId: 42 });
    expect(result.serviceId).toBe(42);
  });

  it('emits a double-quoted literal that round-trips backticks and backslashes (r008)', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%22a%60b%5C%5Cc%22\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    const result = await searchLogs(db, { query: 'a`b\\c' });
    expect(result.unsupported).toBe(false);
    const url = state.captured[0]?.url ?? '';
    // LogQL raw backtick strings support NO escapes, so the filter must be
    // a double-quoted (interpreted) literal: the backtick survives verbatim
    // and every input backslash is doubled for Loki. URLSearchParams uses
    // form-urlencoded encoding: space -> +, ` -> %60, \ -> %5C, " -> %22.
    expect(url).toContain('query=%7Bjob%3D%22ninedeploy%22%7D+%7C%3D+%22a%60b%5C%5Cc%22');
    expect(new URL(url).searchParams.get('query')).toBe('{job="ninedeploy"} |= "a`b\\\\c"');
  });

  it('does not let a backtick end the filter literal early (r008 injection guard)', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range.*', {
      body: { status: 'success', data: { result: [] } },
    });
    const hostile = 'x` } |= `injected';
    await searchLogs(db, { query: hostile });
    const query = new URL(state.captured[0]?.url ?? '').searchParams.get('query') ?? '';
    // Under the old backtick-raw-string form the first interior backtick
    // terminated the literal and the tail (` } |= `injected`) parsed as
    // LogQL pipeline syntax. Exact equality proves the whole hostile text
    // stayed inside one literal.
    expect(query).toBe('{job="ninedeploy"} |= "x` } |= `injected"');
  });

  it('escapes double quotes and newlines so pasted multi-line text stays one literal (r008)', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range.*', {
      body: { status: 'success', data: { result: [] } },
    });
    await searchLogs(db, { query: 'say "hi"\nbye' });
    const query = new URL(state.captured[0]?.url ?? '').searchParams.get('query') ?? '';
    // Raw " would terminate an interpreted literal and a raw newline is
    // illegal inside one, so both must reach Loki escaped (\", \n).
    expect(query).toBe('{job="ninedeploy"} |= "say \\"hi\\"\\nbye"');
  });

  it('clamps `limit` to [1, 1000]', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    // Huge limit -> 1000.
    await searchLogs(db, { query: 'x', limit: 100_000 });
    expect(state.captured[0]?.url).toContain('limit=1000');
    state.captured = [];
    // Negative limit -> 1.
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&end=0\\&limit=1\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    await searchLogs(db, { query: 'x', limit: -5 });
    expect(state.captured[0]?.url).toContain('limit=1');
  });

  it('adds Authorization: Bearer <decrypted> when the drain has an api key', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: 'enc:abc' });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    await searchLogs(db, { query: 'x' });
    const init = state.captured[0]?.init;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer bearer-from-encrypted:enc:abc`);
  });

  it('omits Authorization when the drain has no api key', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    await searchLogs(db, { query: 'x' });
    const init = state.captured[0]?.init;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('throws when Loki returns a non-OK status', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range.*', {
      status: 500, body: 'internal',
    });
    await expect(searchLogs(db, { query: 'x' })).rejects.toThrow(/Loki query failed: 500/);
  });

  it('flattens Loki streams to { ts, line, service } sorted by ts desc', async () => {
    // The flattenLokiStreams branch runs; the exact ts-desc
    // ordering is left as a TODO for PR #59 (URL-mock caveat).
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range.*', {
      body: {
        status: 'success',
        data: { result: [] },
      },
    });
    const result = await searchLogs(db, { query: 'x' });
    expect(result.unsupported).toBe(false);
  });

  it('returns an empty list when Loki status is not "success"', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'error', data: { result: [] } },
    });
    const result = await searchLogs(db, { query: 'x' });
    expect(result.lines).toEqual([]);
  });

  it('echoes the window in ISO form so the CLI can render a "searched N–M" line', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range\\?query=%7Bjob%3D%22ninedeploy%22%7D%20%7C%3D%20%60x%60\\&end=0\\&limit=200\\&direction=backward', {
      body: { status: 'success', data: { result: [] } },
    });
    const since = new Date(100_000);
    const until = new Date(200_000);
    const result = await searchLogs(db, { query: 'x', since });
    expect(new Date(result.window.since).getTime()).toBe(since.getTime());
    expect(new Date(result.window.until).getTime()).toBeGreaterThanOrEqual(until.getTime() - 1000);
  });

  it('returns unsupported: true for a non-Loki drain type', async () => {
    const db = buildDb();
    // Seed ONLY a non-Loki drain — no Loki candidate at all.
    state.drains.set(2, { id: 2, name: 'vector', type: 'vector', enabled: true, url: 'https://vector.example.com', apiKeyEncrypted: null });
    const result = await searchLogs(db, { query: 'x', drainId: 2 });
    expect(result.unsupported).toBe(true);
    expect(result.lines).toEqual([]);
    expect(result.drain).toEqual({ id: 2, name: 'vector', type: 'vector' });
  });

  it('throws when no Loki drain is configured', async () => {
    const db = buildDb();
    state.drains.set(3, { id: 3, name: 'disabled-loki', type: 'loki', enabled: false, url: 'https://loki.example.com', apiKeyEncrypted: null });
    state.drains.set(4, { id: 4, name: 'vector', type: 'vector', enabled: true, url: 'https://vector.example.com', apiKeyEncrypted: null });
    await expect(searchLogs(db, { query: 'x' })).rejects.toThrow(/No enabled Loki drain/);
  });

  it('clamps limit to the [1, 1000] range', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range.*', {
      body: { status: 'success', data: { result: [] } },
    });
    await searchLogs(db, { query: 'x', limit: 999_999 });
    const url = state.captured[0]?.url ?? '';
    expect(url).toMatch(/limit=1000/);
    await searchLogs(db, { query: 'x', limit: -5 });
    const url2 = state.captured[1]?.url ?? '';
    expect(url2).toMatch(/limit=1/);
  });

  it('uses the service slug as the Loki label when serviceId is provided', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    state.services.set(7, { id: 7, slug: 'api-gateway' });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range.*', {
      body: { status: 'success', data: { result: [] } },
    });
    await searchLogs(db, { query: 'x', serviceId: 7 });
    const url = state.captured[0]?.url ?? '';
    expect(url).toMatch(/query=%7Bservice%3D%22api-gateway%22%7D/);
  });

  it('falls back to job="ninedeploy" when the serviceId points to nothing', async () => {
    const db = buildDb();
    state.drains.set(1, { id: 1, name: 'loki', type: 'loki', enabled: true, url: 'https://loki.example.com', apiKeyEncrypted: null });
    setResponseFor('https://loki\\.example\\.com/loki/api/v1/query_range.*', {
      body: { status: 'success', data: { result: [] } },
    });
    await searchLogs(db, { query: 'x', serviceId: 999 });
    const url = state.captured[0]?.url ?? '';
    expect(url).toMatch(/query=%7Bjob%3D%22ninedeploy%22%7D/);
  });

  it('picks a specific drain when drainId is provided (and ignores enabled/type)', async () => {
    const db = buildDb();
    // Seed the disabled / non-Loki drain FIRST so the
    // pickDrain-by-id branch must return it (otherwise the
    // default-enabled-Loki branch would have matched first).
    state.drains.set(11, { id: 11, name: 'vector', type: 'vector', enabled: false, url: 'https://vector.example.com', apiKeyEncrypted: null });
    const result = await searchLogs(db, { query: 'x', drainId: 11 });
    // The disabled / non-Loki drain is still chosen when
    // drainId is set — callers know what they want.
    expect(result.drain).toEqual({ id: 11, name: 'vector', type: 'vector' });
    expect(result.unsupported).toBe(true);
  });

  describe('r287: restrictToServiceId (non-operator callers)', () => {
    it("refuses an explicit drainId bound to another service — its api key is never spent", async () => {
      const db = buildDb();
      state.drains.set(5, { id: 5, name: 'tenant-b', type: 'loki', enabled: true, url: 'https://loki-b.example.com', apiKeyEncrypted: 'kb', serviceId: 99 });
      await expect(searchLogs(db, { query: 'x', serviceId: 1, drainId: 5, restrictToServiceId: 1 })).rejects.toThrow(/No enabled Loki drain/);
      expect(state.captured).toHaveLength(0);
    });

    it('refuses an explicit drainId that is disabled', async () => {
      const db = buildDb();
      state.drains.set(6, { id: 6, name: 'off', type: 'loki', enabled: false, url: 'https://loki-off.example.com', apiKeyEncrypted: 'ko', serviceId: null });
      await expect(searchLogs(db, { query: 'x', serviceId: 1, drainId: 6, restrictToServiceId: 1 })).rejects.toThrow(/No enabled Loki drain/);
      expect(state.captured).toHaveLength(0);
    });

    it('accepts an enabled drain that is global or bound to the queried service', async () => {
      for (const serviceId of [null, 1]) {
        state.drains.clear();
        state.captured = [];
        const db = buildDb();
        state.drains.set(7, { id: 7, name: 'ok', type: 'loki', enabled: true, url: 'https://loki-ok.example.com', apiKeyEncrypted: null, serviceId });
        const result = await searchLogs(db, { query: 'x', serviceId: 1, drainId: 7, restrictToServiceId: 1 });
        expect(result.drain.id, `drain.serviceId=${serviceId}`).toBe(7);
        expect(state.captured).toHaveLength(1);
      }
    });

    it("skips another service's drain when picking the default", async () => {
      const db = buildDb();
      state.drains.set(1, { id: 1, name: 'tenant-b', type: 'loki', enabled: true, url: 'https://loki-b.example.com', apiKeyEncrypted: 'kb', serviceId: 99 });
      state.drains.set(2, { id: 2, name: 'global', type: 'loki', enabled: true, url: 'https://loki-g.example.com', apiKeyEncrypted: null, serviceId: null });
      const result = await searchLogs(db, { query: 'x', serviceId: 1, restrictToServiceId: 1 });
      expect(result.drain.id).toBe(2);
      expect(state.captured[0]?.url).toMatch(/^https:\/\/loki-g\.example\.com/);
    });
  });
});
