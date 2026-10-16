// Client surface: traefik.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  TraefikCertificate,
  CertificateInventoryEntry,
  CertificateInventoryReport,
  TraefikInfo,
  TraefikStatus,
  TraefikCustomConfig,
  TraefikCustomConfigApplied,
  TraefikCustomConfigValidation,
  CustomCertificate,
  CustomCertificateReplace,
  CustomCertificateSaved,
  CustomCertificateUpload,
} from '@ninedeploy/schemas';
import type { TraefikVersionInfo, TraefikRoutingConfig } from '../types.js';
import type { Transport } from '../transport.js';

export interface TraefikApi {
  traefik: {
    get: () => Promise<TraefikInfo>;
    status: () => Promise<TraefikStatus>;
    certificates: () => Promise<TraefikCertificate[]>;
    /**
     * Richer certificate inventory (G-15). Same
     * underlying data as `certificates()` but adds a
     * `status` classification (valid / expiring-soon /
     * expired), a `summary` block, and the full set of
     * fields the Certificates page renders.
     * `threshold` is the days-out cutoff for the
     * `expiring-soon` bucket; default 30.
     */
    certificateInventory: (opts?: { threshold?: number }) => Promise<CertificateInventoryReport>;
    /**
     * Focused "expiring within N days" filter. Default
     * 30. Used by the alert engine and by the panel's
     * "About to expire" widget.
     */
    expiringCertificates: (opts?: { days?: number }) => Promise<{ threshold: number; count: number; certificates: CertificateInventoryEntry[] }>;
    logs: (lines?: number) => Promise<{ logs: string[] }>;
    restart: () => Promise<{ ok: boolean; message?: string }>;
    /** r334: the server answers the host path of the copied acme.json. */
    backupCerts: () => Promise<{ ok: boolean; backupPath: string }>;
    /** r557: routers / services / middlewares from the dynamic config (operator-only). */
    config: () => Promise<TraefikRoutingConfig>;
    /** r557: running vs latest Traefik version (operator-only). */
    version: () => Promise<TraefikVersionInfo>;
    /**
     * r557: pull the pinned Traefik image and recreate the proxy container
     * (operator-only). An image pull outlasts the default request budget, so
     * this call allows up to 10 minutes unless the client disabled timeouts.
     */
    update: () => Promise<{ ok: boolean; newVersion: string | null }>;
    /**
     * 0.14: the operator's custom dynamic config (`custom.yml`). `set` throws
     * a NineDeployError whose `details` is `{ errors, warnings }` on a refusal.
     */
    customConfig: {
      get: () => Promise<TraefikCustomConfig>;
      /** No state change. */
      validate: (content: string) => Promise<TraefikCustomConfigValidation>;
      set: (content: string) => Promise<TraefikCustomConfigApplied>;
      clear: () => Promise<{ ok: boolean; cleared: boolean }>;
    };
    /** 0.14: uploaded TLS certificates (operator-only). No response carries a private key. */
    customCertificates: {
      list: () => Promise<CustomCertificate[]>;
      upload: (input: CustomCertificateUpload) => Promise<CustomCertificateSaved>;
      replace: (id: number, input: CustomCertificateReplace) => Promise<CustomCertificateSaved>;
      delete: (id: number) => Promise<{ ok: boolean }>;
    };
  };
}

export function traefikApi(t: Transport): TraefikApi {
  const { get, send, request } = t;
  return {
    traefik: {
      get: () => get<TraefikInfo>('/v1/traefik'),
      status: () => get<TraefikStatus>('/v1/traefik/status'),
      certificates: () => get<TraefikCertificate[]>('/v1/traefik/certificates'),
      certificateInventory: (opts) =>
        get<CertificateInventoryReport>(
          // `!= null` (not truthiness): 0 ("only already-expired") is a real
          // threshold and must reach the server, not silently become the
          // server-side default of 30.
          `/v1/traefik/certificates/inventory${opts?.threshold != null ? `?threshold=${opts.threshold}` : ''}`,
        ),
      expiringCertificates: (opts) =>
        get<{ threshold: number; count: number; certificates: CertificateInventoryEntry[] }>(
          `/v1/traefik/certificates/expiring${opts?.days != null ? `?days=${opts.days}` : ''}`,
        ),
      logs: (lines = 50) => get<{ logs: string[] }>(`/v1/traefik/logs?lines=${lines}`),
      restart: () => send<{ ok: boolean; message: string }>('POST', '/v1/traefik/restart'),
      backupCerts: () => send<{ ok: boolean; backupPath: string }>('POST', '/v1/traefik/backup-certs'),
      config: () => get<TraefikRoutingConfig>('/v1/traefik/config'),
      version: () => get<TraefikVersionInfo>('/v1/traefik/version'),
      update: () => request<{ ok: boolean; newVersion: string | null }>('/v1/traefik/update', { method: 'POST' }, 10 * 60_000),
      customConfig: {
        get: () => get<TraefikCustomConfig>('/v1/traefik/custom-config'),
        validate: (content) => send<TraefikCustomConfigValidation>('POST', '/v1/traefik/custom-config/validate', { content }),
        set: (content) =>
          request<TraefikCustomConfigApplied>('/v1/traefik/custom-config', { method: 'PUT', body: { content }, findings: true }),
        clear: () => send<{ ok: boolean; cleared: boolean }>('DELETE', '/v1/traefik/custom-config'),
      },
      customCertificates: {
        list: () => get<CustomCertificate[]>('/v1/traefik/certificates/custom'),
        upload: (input) => send<CustomCertificateSaved>('POST', '/v1/traefik/certificates/custom', input),
        replace: (id, input) => send<CustomCertificateSaved>('PUT', `/v1/traefik/certificates/custom/${id}`, input),
        delete: (id) => send<{ ok: boolean }>('DELETE', `/v1/traefik/certificates/custom/${id}`),
      },
    },
  };
}
