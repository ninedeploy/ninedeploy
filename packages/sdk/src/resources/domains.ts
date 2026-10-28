// Client surface: domains, domainPresets.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  ComposeRoute,
  ComposeRouteView,
  ForwardAuthConfig,
  ForwardAuthGrant,
  ForwardAuthGrantInput,
  ForwardAuthView,
  CreateDomainInput,
  Domain,
  DomainPatch,
  DomainEntry,
} from '@ninedeploy/schemas';
import type { CreatedDomain, DomainVerifyResult, StartDomainTransferResult, DomainTransferPreview, AcceptDomainTransferInput, AcceptDomainTransferResult } from '../types.js';
import type { Transport } from '../transport.js';

export interface DomainsApi {
  domains: {
    /**
     * G2.3: panel sign-in in front of a domain. `set(id, null)` takes it off;
     * `grant` is what the panel's /forward-auth page calls to send a signed-in
     * user back to the protected domain.
     */
    forwardAuth: {
      get: (domainId: number) => Promise<ForwardAuthView>;
      set: (domainId: number, forwardAuth: Partial<ForwardAuthConfig> | null) => Promise<ForwardAuthView>;
      grant: (input: ForwardAuthGrantInput) => Promise<ForwardAuthGrant>;
    };
    /** G2.1: route a compose stack's domain to another service of the stack (null for the main service). */
    composeRoute: {
      get: (domainId: number) => Promise<ComposeRouteView>;
      set: (domainId: number, route: ComposeRoute | null) => Promise<ComposeRouteView>;
    };
    list: (serviceId: number) => Promise<Domain[]>;
    /** Add a domain. A non-operator's hostname outside the instance zone comes back `pending` with a TXT `verification` challenge. */
    create: (serviceId: number, input: CreateDomainInput) => Promise<CreatedDomain>;
    /**
     * r332: prove ownership of a `pending` domain and bring it live. Checks
     * the TXT challenge `create` returned; idempotent (an `active` domain
     * answers `verified: true`) and safe to poll while DNS propagates.
     */
    verify: (serviceId: number, domainId: number) => Promise<DomainVerifyResult>;
    /**
     * 0.16.1 "Generate domain": add the service's automatic URL (Settings →
     * Automatic URLs: a base domain or a free sslip.io name) now, instead of
     * on its next deploy. Idempotent: `created: false` when it already exists.
     */
    generate: (serviceId: number) => Promise<Domain & { created: boolean }>;
    remove: (serviceId: number, domainId: number) => Promise<void>;
    /**
     * DNS status for a domain: does the hostname resolve to the addresses
     * this panel expects? Advisory — routing is governed by ownership.
     */
    dnsCheck: (
      serviceId: number,
      domainId: number,
    ) => Promise<{
      hostname: string;
      status: 'ok' | 'mismatch' | 'unresolved';
      addresses: { a: string[]; aaaa: string[] };
      expected: string[];
    }>;
    /** Update routing extras: ssl toggle, www→apex redirect, custom headers, basicAuth, ipAllowlist, rateLimit. */
    update: (serviceId: number, domainId: number, input: DomainPatch) => Promise<Domain>;
    all: () => Promise<DomainEntry[]>;
    setSsl: (domainId: number, ssl: boolean) => Promise<{ id: number; ssl: boolean }>;
    /** Toggle sticky-session routing for the service (G-28). */
    setStickySession: (serviceId: number, enabled: boolean) => Promise<{ id: number; enabled: boolean; active: boolean }>;
    /**
     * Start a domain transfer (G-29). The source user (admin
     * on the source service) names the target email; the
     * server returns a one-time `acceptUrl` to forward. The
     * target user accepts via `acceptDomainTransfer(token,
     * { targetServiceId })`. The transfer expires after 7
     * days; cancelling is one call.
     */
    transfer: (domainId: number, input: { targetEmail: string }) => Promise<StartDomainTransferResult>;
    /**
     * Preview a transfer by token. Does NOT require auth
     * (the token is the secret) — the panel uses this to
     * render the accept page to a logged-out visitor.
     */
    previewTransfer: (token: string) => Promise<DomainTransferPreview>;
    /**
     * Accept a transfer. The caller must be authenticated
     * and the caller's email must equal the transfer's
     * target email; the panel / CLI surfaces the preview
     * first so the user knows what they're signing in to.
     */
    acceptTransfer: (token: string, input: AcceptDomainTransferInput) => Promise<AcceptDomainTransferResult>;
    /**
     * Cancel a pending transfer. Only the source user
     * (or an instance operator) can cancel.
     */
    cancelTransfer: (token: string) => Promise<{ transferId: number; status: 'cancelled' }>;
  };
  domainPresets: {
    /** Every `IDomainProvider` the running kernel has registered. */
    list: () => Promise<{ providers: string[] }>;
    /**
     * Manually create the DNS record for `hostname` via the operator's
     * active provider. `content` is optional: when omitted the route
     * falls back to the panel's `dns_records_content` setting, then to
     * `detectPublicIp()`. Returns the upstream recordId so the caller
     * can correlate.
     */
    apply: (input: { hostname: string; content?: string }) => Promise<{
      hostname: string;
      provider: string;
      zone: string;
      recordId: string;
      type: 'A' | 'CNAME';
      content: string;
    }>;
  };
}

export function domainsApi(t: Transport): DomainsApi {
  const { get, send, request } = t;
  return {
    domains: {
      forwardAuth: {
        get: (domainId) => get<ForwardAuthView>(`/v1/domains/${domainId}/forward-auth`),
        set: (domainId, forwardAuth) => send<ForwardAuthView>('PUT', `/v1/domains/${domainId}/forward-auth`, { forwardAuth }),
        grant: (input) => send<ForwardAuthGrant>('POST', '/v1/forward-auth/grant', input),
      },
      composeRoute: {
        get: (domainId) => get<ComposeRouteView>(`/v1/domains/${domainId}/compose-route`),
        set: (domainId, route) => send<ComposeRouteView>('PUT', `/v1/domains/${domainId}/compose-route`, { route }),
      },
      list: (serviceId) => get<Domain[]>(`/v1/services/${serviceId}/domains`),
      create: (serviceId, input) => send<CreatedDomain>('POST', `/v1/services/${serviceId}/domains`, input),
      verify: (serviceId, domainId) =>
        send<DomainVerifyResult>('POST', `/v1/services/${serviceId}/domains/${domainId}/verify`, {}),
      generate: (serviceId) => send<Domain & { created: boolean }>('POST', `/v1/services/${serviceId}/domains/auto`, {}),
      dnsCheck: (serviceId, domainId) =>
        get<{
          hostname: string;
          status: 'ok' | 'mismatch' | 'unresolved';
          addresses: { a: string[]; aaaa: string[] };
          expected: string[];
        }>(`/v1/services/${serviceId}/domains/${domainId}/dns`),
      update: (serviceId, domainId, input) =>
        send<Domain>('PATCH', `/v1/services/${serviceId}/domains/${domainId}`, input),
      remove: async (serviceId, domainId) => {
        await request(`/v1/services/${serviceId}/domains/${domainId}`, { method: 'DELETE' });
      },
      all: () => get<DomainEntry[]>('/v1/domains'),
      setSsl: (domainId, ssl) => send<{ id: number; ssl: boolean }>('PATCH', `/v1/domains/${domainId}`, { ssl }),
      /** Toggle sticky-session routing (G-28) — sits under `/domains` for legacy compatibility. */
      setStickySession: (serviceId, enabled) =>
        send<{ id: number; enabled: boolean; active: boolean }>(
          'POST',
          `/v1/services/${serviceId}/sticky-session`,
          { enabled },
        ),
      transfer: (domainId, input) =>
        send<StartDomainTransferResult>('POST', `/v1/domains/${domainId}/transfer`, input),
      previewTransfer: (token) => get<DomainTransferPreview>(`/v1/domain-transfers/${token}`),
      acceptTransfer: (token, input) =>
        send<AcceptDomainTransferResult>('POST', `/v1/domain-transfers/${token}/accept`, input),
      cancelTransfer: (token) =>
        send<{ transferId: number; status: 'cancelled' }>('POST', `/v1/domain-transfers/${token}/cancel`, {}),
    },
    domainPresets: {
      list: () => get<{ providers: string[] }>('/v1/domain-presets'),
      apply: (input) => send<{
        hostname: string;
        provider: string;
        zone: string;
        recordId: string;
        type: 'A' | 'CNAME';
        content: string;
      }>('POST', '/v1/domain-presets/apply', input),
    },
  };
}
