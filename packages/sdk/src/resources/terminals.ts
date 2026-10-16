// Client surface: terminals, traffic, api.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  CreateTerminalSessionInput,
  ServiceTrafficSummary,
  TerminalSession,
  TerminalSessionCreated,
  TerminalSessionList,
  TerminalSettingsInput,
  TerminalSettingsView,
  TerminalTerminateResult,
  TrafficSettingsUpdate,
  TrafficSettingsView,
  TrafficSummary,
} from '@ninedeploy/schemas';
import { apiGetUrl, type ApiQuery } from '../apiPath.js';
import { terminalAttachInfo, connectTerminal, type TerminalAttachSource, type WebSocketLocation, type TerminalAttachInfo, type TerminalHandlers, type TerminalConnectOptions, type TerminalConnection } from '../terminal.js';
import type { TerminalListQuery, TrafficQuery } from '../types.js';
import type { Transport } from '../transport.js';

export interface TerminalsApi {
  // ── end 0.15 T4 ──
  // ── 0.15 T6 surfaces ──
  /**
   * Interactive terminals (0.15, operator only). A session is created over
   * HTTP and attached over a WebSocket with its single-use ticket (valid 30s).
   * Host shells (`target.kind: 'host'`) are off by default and need an
   * interactive session plus the account password in `password`.
   */
  terminals: {
    create: (input: CreateTerminalSessionInput) => Promise<TerminalSessionCreated>;
    /** History, newest first; page back with `before: list.nextBefore`. */
    list: (query?: TerminalListQuery) => Promise<TerminalSessionList>;
    get: (id: number) => Promise<TerminalSession>;
    /** Close a live session (close 4410) or revoke a pending ticket. */
    terminate: (id: number) => Promise<TerminalTerminateResult>;
    settings: {
      get: () => Promise<TerminalSettingsView>;
      /** Partial. Turning host shells on needs `password` (step-up). */
      set: (input: TerminalSettingsInput) => Promise<TerminalSettingsView>;
    };
    /** The WebSocket URL and subprotocols that attach a created session. */
    attachInfo: (created: TerminalAttachSource, location?: WebSocketLocation) => TerminalAttachInfo;
    /** Attach a created session over protocol v1 (see `connectTerminal`). */
    connect: (created: TerminalAttachSource, handlers?: TerminalHandlers, options?: TerminalConnectOptions) => TerminalConnection;
  };
  /** Traffic analytics (0.15, opt-in). Settings and the summary are operator only. */
  traffic: {
    settings: {
      get: () => Promise<TrafficSettingsView>;
      /**
       * Enabling or disabling recreates Traefik once (about 1–2s of refused
       * connections). A browser behind Traefik may lose this response; read
       * `settings.get()` again on a network error.
       */
      set: (input: TrafficSettingsUpdate) => Promise<TrafficSettingsView>;
    };
    summary: (query?: TrafficQuery) => Promise<TrafficSummary>;
    /** One service's series (any seat on the service). Empty series, never 404, without data. */
    service: (serviceId: number, query?: TrafficQuery) => Promise<ServiceTrafficSummary>;
  };
  // ── 0.15 T4 api ──
  /**
   * Raw access to the documented API (0.15, see `GET /v1/openapi.json`).
   * Read-only on purpose: there is no generic write method. The generated MCP
   * read tools call through here.
   */
  api: {
    /**
     * GET any `/v1/…` route. The path must match `^/v1/[A-Za-z0-9/_.-]+$` and
     * may not contain a `..` segment; query values are URL-encoded and
     * `undefined` values are dropped.
     */
    get: <T = unknown>(path: `/v1/${string}`, query?: ApiQuery) => Promise<T>;
  };
}

export function terminalsApi(t: Transport): TerminalsApi {
  const { get, send, baseUrl } = t;
  return {
    // ── end 0.15 T4 ──
    // ── 0.15 T6 surfaces ──
    terminals: {
      create: (input) => send<TerminalSessionCreated>('POST', '/v1/terminals', input),
      list: (query) => get<TerminalSessionList>(apiGetUrl('/v1/terminals', { ...query })),
      get: (id) => get<TerminalSession>(`/v1/terminals/${id}`),
      terminate: (id) => send<TerminalTerminateResult>('DELETE', `/v1/terminals/${id}`),
      settings: {
        get: () => get<TerminalSettingsView>('/v1/terminals/settings'),
        set: (input) => send<TerminalSettingsView>('PUT', '/v1/terminals/settings', input),
      },
      attachInfo: (created, location) => terminalAttachInfo(baseUrl, created, location),
      connect: (created, handlers, options) =>
        connectTerminal(terminalAttachInfo(baseUrl, created, options?.location), handlers, options),
    },
    traffic: {
      settings: {
        get: () => get<TrafficSettingsView>('/v1/traffic/settings'),
        set: (input) => send<TrafficSettingsView>('PUT', '/v1/traffic/settings', input),
      },
      summary: (query) => get<TrafficSummary>(apiGetUrl('/v1/traffic/summary', { ...query })),
      service: (serviceId, query) =>
        get<ServiceTrafficSummary>(apiGetUrl(`/v1/services/${serviceId}/traffic`, { ...query })),
    },
    // ── 0.15 T4 api ──
    api: {
      // async: a refused path rejects like any other failed call, never throws synchronously.
      get: async <T = unknown>(path: `/v1/${string}`, query?: ApiQuery) => get<T>(apiGetUrl(path, query)),
    },
  };
}
