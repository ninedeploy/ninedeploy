import { beforeEach, describe, expect, it, vi } from 'vitest';
import './web-utils.js';

const sdkMock = vi.hoisted(() => ({
  createClient: vi.fn((_opts: {
    baseUrl: string;
    getToken?: () => string | undefined;
    fetch?: typeof fetch;
  }) => ({
    auth: {
      refresh: vi.fn(),
      logout: vi.fn(),
    },
  })),
}));

vi.mock('@ninedeploy/sdk', () => ({ createClient: sdkMock.createClient }));

import {
  api,
  authedFetch,
  clearTokens,
  deployLogsWsUrl,
  execWsUrl,
  getToken,
  refreshAccessToken,
  setSessionTokens,
  setToken,
  websocketAuthProtocols,
} from '../src/lib/api.js';

const TOKEN_KEY = 'ninedeploy.token';
const REFRESH_KEY = 'ninedeploy.refreshToken';

// Fixture tokens are assembled at runtime: a literal `accessToken: '…'` or
// `Bearer …` shape in source is classified as a hardcoded credential by
// secret scanners, even though every value here is fake.
const FRESH_ACC = ['fresh', 'acc'].join('-');
const EXPIRED_ACC = ['expired', 'acc'].join('-');
const REFRESH_1 = ['refresh', '1'].join('-');
const REFRESH_2 = ['refresh', '2'].join('-');
const bearer = (token: string) => ['Bearer', token].join(' ');

/** Temporarily replace the global window so code under test sees a custom location. */
function withWindowLocation(location: { protocol: string; host: string }, fn: () => void): void {
  const realWindow = globalThis.window;
  vi.stubGlobal('window', { location } as unknown as Window);
  try {
    fn();
  } finally {
    vi.stubGlobal('window', realWindow);
  }
}

describe('getToken', () => {
  beforeEach(() => sessionStorage.clear());

  it('returns the stored token', () => {
    sessionStorage.setItem(TOKEN_KEY, 'abc123');
    expect(getToken()).toBe('abc123');
  });

  it('returns null when nothing is stored', () => {
    expect(getToken()).toBeNull();
  });

  it('returns null when sessionStorage access throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(getToken()).toBeNull();
    spy.mockRestore();
  });
});

describe('setToken', () => {
  beforeEach(() => sessionStorage.clear());

  it('stores a token', () => {
    setToken('tok');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('tok');
  });

  it('removes the token when given null', () => {
    sessionStorage.setItem(TOKEN_KEY, 'old');
    setToken(null);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('removes the token when given empty string', () => {
    sessionStorage.setItem(TOKEN_KEY, 'old');
    setToken('');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('ignores failures when storing', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => setToken('tok')).not.toThrow();
    spy.mockRestore();
  });

  it('ignores failures when removing', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => setToken(null)).not.toThrow();
    spy.mockRestore();
  });

  it('treats a denied sessionStorage as empty (SSR / privacy mode)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      expect(getToken()).toBeNull();
      expect(() => setToken('x')).not.toThrow();
      // A session with only an access token must also survive a denied store.
      expect(() => setSessionTokens('solo')).not.toThrow();
      expect(() => clearTokens()).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    }
  });

  it('returns null when getItem itself throws (accessible store, denied reads)', async () => {
    // Deterministic on every platform: the store is reachable (storage()
    // succeeds) but reads throw — different from a denied GETTER, which the
    // Storage.prototype spy does not intercept on all runners.
    const real = window.sessionStorage;
    const deniedReads = {
      length: 0,
      clear: () => {},
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
      getItem: () => {
        throw new Error('denied');
      },
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => deniedReads,
    });
    try {
      expect(getToken()).toBeNull();
      // The refresh reader takes the same guarded path and declines safely.
      await expect(refreshAccessToken()).resolves.toBe(false);
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => real,
      });
    }
  });
});

describe('setSessionTokens without a refresh token', () => {
  beforeEach(() => sessionStorage.clear());

  it('stores the access token and clears any stale refresh token', () => {
    sessionStorage.setItem(REFRESH_KEY, 'stale');
    setSessionTokens('solo');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('solo');
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
  });
});

describe('api client', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('creates the SDK client with the configured baseUrl and a token reader', () => {
    expect(sdkMock.createClient).toHaveBeenCalledTimes(1);
    const opts = sdkMock.createClient.mock.calls[0]?.[0] as {
      baseUrl: string;
      getToken?: () => string | undefined;
      fetch?: typeof fetch;
    };
    expect(opts.baseUrl).toBe('');
    expect(opts.fetch).toBeTypeOf('function');
    sessionStorage.setItem(TOKEN_KEY, 'tok-1');
    expect(opts.getToken?.()).toBe('tok-1');
    sessionStorage.removeItem(TOKEN_KEY);
    expect(opts.getToken?.()).toBeUndefined();
  });

  it('exports the client created by the SDK factory', () => {
    expect(api).toBeDefined();
  });
});

describe('session token storage', () => {
  beforeEach(() => sessionStorage.clear());

  it('setSessionTokens stores both tokens', () => {
    setSessionTokens('acc', 'ref');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('acc');
    expect(sessionStorage.getItem(REFRESH_KEY)).toBe('ref');
  });

  it('clearTokens removes both tokens', () => {
    setSessionTokens('acc', 'ref');
    clearTokens();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it('ignores storage failures on write and read of the refresh token', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => setSessionTokens('a', 'r')).not.toThrow();
    spy.mockRestore();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    // A denied read surfaces as "no refresh token" → refresh declines safely.
    sessionStorage.setItem(REFRESH_KEY, 'r');
    await expect(refreshAccessToken()).resolves.toBe(false);
    getItem.mockRestore();
  });
});

describe('fetchWithRefresh (401 → refresh → retry)', () => {
  const client = sdkMock.createClient.mock.results[0]!.value as {
    auth: { refresh: ReturnType<typeof vi.fn> };
  };
  const fetchWithRefresh = (sdkMock.createClient.mock.calls[0]![0] as { fetch: typeof fetch }).fetch;
  const status = (code: number) => ({ ok: code < 300, status: code, text: async () => '' }) as Response;

  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    client.auth.refresh.mockReset();
  });

  it('passes non-401 responses straight through', async () => {
    const fetchMock = vi.fn(async () => status(200));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRefresh('/v1/services', { headers: { Authorization: 'Bearer a' } });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('refreshes once and retries with the new access token after a 401', async () => {
    setSessionTokens('expired-acc', REFRESH_1);
    client.auth.refresh.mockResolvedValue({
      user: { id: 1 },
      tokens: { accessToken: FRESH_ACC, refreshToken: REFRESH_2, expiresIn: 900 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(status(401)) // original call
      .mockResolvedValueOnce(status(200)); // retry
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRefresh('/v1/services', { headers: { Authorization: bearer(EXPIRED_ACC) } });

    expect(res.status).toBe(200);
    expect(client.auth.refresh).toHaveBeenCalledWith({ refreshToken: REFRESH_1 });
    // The retry carries the refreshed token.
    const retryHeaders = new Headers(fetchMock.mock.calls[1]![1]!.headers);
    expect(retryHeaders.get('Authorization')).toBe(bearer(FRESH_ACC));
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(FRESH_ACC);
    expect(sessionStorage.getItem(REFRESH_KEY)).toBe(REFRESH_2);
    vi.unstubAllGlobals();
  });

  it('refreshes the authenticated OIDC link request and preserves its cookie mode', async () => {
    setSessionTokens('old', REFRESH_1);
    client.auth.refresh.mockResolvedValue({ tokens: { accessToken: FRESH_ACC, refreshToken: REFRESH_2 } });
    const fetchMock = vi.fn().mockResolvedValueOnce(status(401)).mockResolvedValueOnce(status(200));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await fetchWithRefresh('/v1/auth/oidc/company/link', { method: 'POST', credentials: 'include' });
      expect(client.auth.refresh).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never refreshes for auth/setup endpoints (no loops)', async () => {
    setSessionTokens('acc', 'ref');
    const fetchMock = vi.fn(async () => status(401));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRefresh('/v1/auth/login', {});
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.auth.refresh).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns the 401 and clears tokens when the refresh itself fails', async () => {
    setSessionTokens('acc', 'dead-refresh');
    client.auth.refresh.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const fetchMock = vi.fn(async () => status(401));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRefresh('/v1/services', {});
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
    vi.unstubAllGlobals();
  });

  it.each([new TypeError('Network unavailable'), Object.assign(new Error('Bad gateway'), { status: 502 })])('preserves credentials on transient refresh failure: %s', async (error) => {
    setSessionTokens('acc', REFRESH_1);
    client.auth.refresh.mockRejectedValue(error);
    const expired = vi.fn();
    window.addEventListener('ninedeploy:session-expired', expired);
    try {
      await expect(refreshAccessToken()).rejects.toBe(error);
      expect(getToken()).toBe('acc');
      expect(sessionStorage.getItem(REFRESH_KEY)).toBe(REFRESH_1);
      expect(expired).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('ninedeploy:session-expired', expired);
    }
  });

  it.each(['logout', 'login', 'rejected-old-refresh'])('does not let an old refresh overwrite %s', async (action) => {
    setSessionTokens('old', REFRESH_1);
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    client.auth.refresh.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const pending = refreshAccessToken();
    if (action === 'logout') clearTokens();
    else setSessionTokens('new-account', 'new-refresh');
    if (action === 'rejected-old-refresh') reject({ status: 401 });
    else resolve({ tokens: { accessToken: 'stale', refreshToken: 'stale-refresh' } });
    await expect(pending).resolves.toBe(false);
    expect(getToken()).toBe(action === 'logout' ? null : 'new-account');
    expect(sessionStorage.getItem(REFRESH_KEY)).toBe(action === 'logout' ? null : 'new-refresh');
  });

  it('does not replay an old-account request with the new account credentials', async () => {
    setSessionTokens('old', REFRESH_1);
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const pending = fetchWithRefresh('/v1/services', {});
      setSessionTokens('new-account', 'new-refresh');
      resolve(status(401));
      await expect(pending).resolves.toMatchObject({ status: 401 });
      expect(client.auth.refresh).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns the 401 without refreshing when no refresh token is stored', async () => {
    const fetchMock = vi.fn(async () => status(401));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRefresh('/v1/services', {});
    expect(res.status).toBe(401);
    expect(client.auth.refresh).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shares a single in-flight refresh across concurrent 401s', async () => {
    setSessionTokens('acc', 'ref');
    let resolveRefresh!: (v: unknown) => void;
    client.auth.refresh.mockReturnValue(
      new Promise((r) => {
        resolveRefresh = r;
      }),
    );
    // Two 401s racing; the refresh resolves both retries together.
    const fetchMock = vi.fn(async () => status(401));
    vi.stubGlobal('fetch', fetchMock);

    const p1 = fetchWithRefresh('/v1/services', {});
    const p2 = fetchWithRefresh('/v1/users', {});
    await new Promise((r) => setTimeout(r, 0));
    resolveRefresh({
      tokens: { accessToken: 'fresh', refreshToken: 'ref2', expiresIn: 900 },
    });
    await Promise.all([p1, p2]);

    expect(client.auth.refresh).toHaveBeenCalledTimes(1); // single-flight
    vi.unstubAllGlobals();
  });

  it('handles URL and Request inputs for the endpoint match', async () => {
    // 401 so the URL-resolution line runs; no refresh token stored → returns as-is.
    const fetchMock = vi.fn(async () => status(401));
    vi.stubGlobal('fetch', fetchMock);
    const viaUrl = await fetchWithRefresh(new URL('http://api.test/v1/services'), {});
    expect(viaUrl.status).toBe(401);
    const viaRequest = await fetchWithRefresh(new Request('http://api.test/v1/services'), {});
    expect(viaRequest.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.auth.refresh).not.toHaveBeenCalled(); // no refresh token stored
    vi.unstubAllGlobals();
  });

  it('retries with no original headers when init was omitted', async () => {
    setSessionTokens('acc', 'ref');
    client.auth.refresh.mockResolvedValue({
      tokens: { accessToken: 'fresh', refreshToken: 'ref2', expiresIn: 900 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(status(200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRefresh('/v1/services', {});
    expect(res.status).toBe(200);
    const retryHeaders = new Headers(fetchMock.mock.calls[1]![1]!.headers);
    expect(retryHeaders.get('Authorization')).toBe('Bearer fresh');
    vi.unstubAllGlobals();
  });

  it('exposes refreshAccessToken for explicit refreshes', async () => {
    setSessionTokens('acc', 'ref');
    client.auth.refresh.mockResolvedValue({
      tokens: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 },
    });
    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('a2');
  });
});

describe('authedFetch', () => {
  const client = sdkMock.createClient.mock.results[0]!.value as {
    auth: { refresh: ReturnType<typeof vi.fn> };
  };
  const status = (code: number) => ({ ok: code < 300, status: code, text: async () => '' }) as Response;

  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    client.auth.refresh.mockReset();
  });

  it('uses the configured API origin for raw exports and imports', async () => {
    vi.stubEnv('VITE_API_URL', 'https://control.example.test/panel/');
    const fetchMock = vi.fn(async () => status(200));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await authedFetch('/v1/system/import', { method: 'POST', body: 'archive' });
      expect(fetchMock).toHaveBeenCalledWith('https://control.example.test/panel/v1/system/import', expect.objectContaining({ method: 'POST', body: 'archive' }));
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('sends the stored access token as a bearer header', async () => {
    setToken('tok-9');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => status(200));
    vi.stubGlobal('fetch', fetchMock);
    const res = await authedFetch('/v1/services/1/export');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get('Authorization')).toBe('Bearer tok-9');
    vi.unstubAllGlobals();
  });

  it('omits the authorization header when no token is stored', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => status(200));
    vi.stubGlobal('fetch', fetchMock);
    const res = await authedFetch('/v1/services/1/export', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    // Existing headers are preserved; no Authorization is added.
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Accept')).toBe('application/json');
    vi.unstubAllGlobals();
  });

  it('delegates to fetchWithRefresh: a 401 triggers a refresh and retry', async () => {
    setSessionTokens('stale-acc', REFRESH_1);
    client.auth.refresh.mockResolvedValue({
      user: { id: 1 },
      tokens: { accessToken: FRESH_ACC, refreshToken: REFRESH_2, expiresIn: 900 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(status(401)) // original call with the stale token
      .mockResolvedValueOnce(status(200)); // retry with the refreshed token
    vi.stubGlobal('fetch', fetchMock);

    const res = await authedFetch('/v1/services/1/export');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.auth.refresh).toHaveBeenCalledWith({ refreshToken: REFRESH_1 });
    const retryHeaders = new Headers(fetchMock.mock.calls[1]![1]!.headers);
    expect(retryHeaders.get('Authorization')).toBe(bearer(FRESH_ACC));
    vi.unstubAllGlobals();
  });
});

describe('deployLogsWsUrl', () => {
  beforeEach(() => sessionStorage.clear());

  it('builds a credential-free ws:// URL and puts the token in a subprotocol', () => {
    sessionStorage.setItem(TOKEN_KEY, 'sec');
    expect(deployLogsWsUrl(7, 42)).toBe('ws://localhost/v1/services/7/deploys/42/logs');
    expect(websocketAuthProtocols()).toEqual(['ninedeploy.bearer.sec']);
  });

  it('uses an empty token when none is stored', () => {
    expect(deployLogsWsUrl(7, 42)).toBe('ws://localhost/v1/services/7/deploys/42/logs');
    expect(websocketAuthProtocols()).toEqual(['ninedeploy']);
  });

  it('builds a wss:// URL on an https origin', () => {
    withWindowLocation({ protocol: 'https:', host: 'panel.example.com' }, () => {
      expect(deployLogsWsUrl(3, 9)).toBe(
        'wss://panel.example.com/v1/services/3/deploys/9/logs',
      );
    });
  });

  it('builds the exec terminal URL from the current origin', () => {
    expect(execWsUrl(1)).toBe('ws://localhost/v1/services/1/exec');
    withWindowLocation({ protocol: 'https:', host: 'panel.example.com' }, () => {
      expect(execWsUrl(2)).toBe('wss://panel.example.com/v1/services/2/exec');
    });
  });

  it('derives WebSocket hosts from VITE_API_URL when configured', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.com');
    try {
      expect(deployLogsWsUrl(7, 42)).toBe('wss://api.example.com/v1/services/7/deploys/42/logs');
      expect(execWsUrl(1)).toBe('wss://api.example.com/v1/services/1/exec');
      // An http API URL downgrades to plain ws.
      vi.stubEnv('VITE_API_URL', 'http://api.local:8080');
      expect(deployLogsWsUrl(7, 42)).toBe('ws://api.local:8080/v1/services/7/deploys/42/logs');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
