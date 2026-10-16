// HTTP request core shared by every resource module.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import { NineDeployError } from './errors.js';

/**
 * Minimal structural fetch type so the SDK is isomorphic (browser + Node)
 * without pulling in DOM lib types. Both `globalThis.fetch` implementations
 * satisfy this shape.
 */
export type FetchLike = (input: string, init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    credentials?: 'omit' | 'same-origin' | 'include';
  }) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    /** Optional so minimal fetch stand-ins stay assignable; a real fetch has it (F1010). */
    headers?: { get(name: string): string | null };
  }>

export interface NineDeployClientOptions {
  /** Base URL of the NineDeploy API, e.g. http://localhost:3000. */
  baseUrl: string;
  /** Returns the current access token (or bearer credential). */
  getToken?: () => string | undefined | null;
  /**
   * Per-request timeout in milliseconds. A stalled backend must not hang
   * callers forever (worst in CI, where nothing is interactive to Ctrl-C).
   * Defaults to 30_000; pass `0` to disable entirely.
   */
  timeoutMs?: number;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: FetchLike;
}

export interface RequestInit {
  method?: string;
  credentials?: 'omit' | 'same-origin' | 'include';
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Propagated to fetch as-is. Typed structurally: the SDK compiles without
   * DOM lib types, and only `AbortSignal.timeout()` ever produces one here.
   */
  signal?: unknown;
  /** 0.14: a binary body, sent as-is (`application/octet-stream`). */
  raw?: Uint8Array;
  /** 0.14: keep a refusal's top-level `errors` / `warnings` as the error's `details`. */
  findings?: boolean;
}

const NO_FETCH = (): Promise<never> =>
  Promise.reject(new NineDeployError(0, 'no_fetch', 'No fetch implementation is available'));

/** The request core every resource module calls through. */
export interface Transport {
  baseUrl: string;
  requestWithHeaders<T>(path: string, init?: RequestInit, minTimeoutMs?: number): Promise<{ data: T; header: (name: string) => string | null }>;
  request<T>(path: string, init?: RequestInit, minTimeoutMs?: number): Promise<T>;
  get<T>(path: string): Promise<T>;
  send<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export function createTransport(opts: NineDeployClientOptions): Transport {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl: FetchLike = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch ?? NO_FETCH);
  /** Default per-request budget when the caller does not configure one. */
  const DEFAULT_TIMEOUT_MS = 30_000;

  /** A call's parsed body plus read access to its response headers (F1010). */
  async function requestWithHeaders<T>(
    path: string,
    init: RequestInit = {},
    minTimeoutMs?: number,
  ): Promise<{ data: T; header: (name: string) => string | null }> {
    const token = opts.getToken?.();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (init.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const configured = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // A long-running call (image pull) may widen the budget, never narrow it;
    // `0` (timeouts disabled) stays disabled.
    const timeoutMs = configured > 0 && minTimeoutMs !== undefined ? Math.max(configured, minTimeoutMs) : configured;
    // AbortSignal.timeout exists everywhere the SDK runs (Node 17.3+, all
    // modern browsers); it is resolved off globalThis and attached opaquely —
    // FetchLike's shape stays untouched (widening it with `signal: unknown`
    // breaks assigning a real `typeof fetch` at the call sites).
    const out: { method?: string; headers?: Record<string, string>; body?: string; credentials?: 'omit' | 'same-origin' | 'include' } = {
      method: init.method ?? 'GET',
      headers,
      body,
    };
    if (init.credentials !== undefined) out.credentials = init.credentials;
    if (init.raw !== undefined) {
      // Attached opaquely, like the signal: FetchLike's `body` stays `string`.
      headers['Content-Type'] = 'application/octet-stream';
      (out as { body?: unknown }).body = init.raw;
    }
    if (timeoutMs > 0) {
      const abort = (globalThis as { AbortSignal?: { timeout: (ms: number) => unknown } }).AbortSignal;
      if (abort) (out as { signal?: unknown }).signal = abort.timeout(timeoutMs);
    }

    const res = await fetchImpl(`${baseUrl}${path}`, out);
    const header = (name: string): string | null => (typeof res.headers?.get === 'function' ? res.headers.get(name) : null);
    const text = await res.text();
    // Guard the parse: proxies (HTML 502 pages, empty bodies) must surface as a
    // typed error, not an opaque SyntaxError.
    let parsed: unknown;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      if (parsed === undefined) throw new NineDeployError(res.status, 'http_error', `Request failed (${res.status})`);
      const failure = NineDeployError.fromBody(res.status, parsed);
      const findings = parsed as { errors?: unknown; warnings?: unknown };
      if (init.findings && Array.isArray(findings.errors)) {
        throw new NineDeployError(failure.status, failure.code, failure.message, {
          errors: findings.errors,
          warnings: Array.isArray(findings.warnings) ? findings.warnings : [],
        });
      }
      throw failure;
    }
    // An ok response with an empty/unparseable body (204s, HTML pages from a
    // misconfigured proxy) must never resolve to `undefined` — query functions
    // built on this client would crash TanStack Query ("Query data cannot be
    // undefined"). Empty 2xx bodies resolve to {}; non-JSON bodies surface as
    // a typed error so callers see the real problem instead of a crash.
    if (parsed === undefined) {
      if (text === '') return { data: {} as T, header };
      throw new NineDeployError(res.status, 'invalid_response', `Expected JSON but received a non-JSON body (status ${res.status})`);
    }
    return { data: parsed as T, header };
  }

  async function request<T>(path: string, init: RequestInit = {}, minTimeoutMs?: number): Promise<T> {
    return (await requestWithHeaders<T>(path, init, minTimeoutMs)).data;
  }

  const get = <T>(path: string) => request<T>(path);
  const send = <T>(method: string, path: string, body?: unknown) => request<T>(path, { method, body });

  return { baseUrl, requestWithHeaders, request, get, send };
}
