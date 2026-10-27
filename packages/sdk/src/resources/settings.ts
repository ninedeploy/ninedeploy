// Client surface: settings, branding, configPresets, config, emailTemplates, notifications.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  ConfigItem,
  ConfigListResponse,
  SetConfigInput,
  SecretProviderKind,
  SecretProviderTestRequest,
  SecretProviderTestResult,
  SecretProviderView,
  VaultProviderPut,
  AwsProviderPut,
  GcpProviderPut,
  AzureProviderPut,
  OnePasswordProviderPut,
  ExecProviderPut,
} from '@ninedeploy/schemas';
import type { VaultAllowlistView, VaultSettings, EmailTemplateName, EmailTemplateEntry, EmailTemplateRender } from '../types.js';
import type { Transport } from '../transport.js';

/** The PUT body of each secret provider kind (G3.2 added gcp, azure, onepassword, exec). */
export type SecretProviderPutFor<K extends SecretProviderKind> = {
  vault: VaultProviderPut;
  aws: AwsProviderPut;
  gcp: GcpProviderPut;
  azure: AzureProviderPut;
  onepassword: OnePasswordProviderPut;
  exec: ExecProviderPut;
}[K];

/** G3.5: the DNS record providers configured through `settings.dnsProvider`. */
export type DnsCredentialProviderName = 'route53' | 'ovh' | 'porkbun' | 'hetzner';
export interface DnsProviderSettings {
  providers: DnsCredentialProviderName[];
  /** The active `dns_records_provider` (may be cloudflare, dnsimple, …). */
  provider: string | null;
  /** Which of these four has credentials saved. */
  configured: DnsCredentialProviderName | null;
  /** The saved non-secret fields (an access key id, an OVH endpoint). */
  fields: Record<string, string>;
}

export type AutoUrlMode = 'off' | 'domain' | 'sslip';
export interface AutoUrlEffective {
  mode: AutoUrlMode;
  domain: string | null;
  ip: string | null;
  source: 'env' | 'setting';
}
export interface AutoUrlSettings {
  effective: AutoUrlEffective;
  stored: { mode: string; domain: string | null; ip: string | null };
  envWildcard: string | null;
  /** The installer's address (NINEDEPLOY_PUBLIC_URL), offered for sslip.io. */
  suggestedIp: string | null;
}

export type OnboardingStepId =
  | 'auto_url'
  | 'git_source'
  | 'first_service'
  | 'first_deploy'
  | 'custom_domain'
  | 'https'
  | 'notifications'
  | 'backups';
export interface OnboardingStatus {
  steps: { id: OnboardingStepId; done: boolean; optional: boolean }[];
  completed: number;
  total: number;
  /** Every required step is done. */
  ready: boolean;
  dismissed: boolean;
  autoUrl: AutoUrlEffective;
}

export interface SettingsApi {
  settings: {
    get: () => Promise<{ allowRegistration: boolean; acmeEmail: string | null; templatesSource: string | null; dnsProvider: string | null; hasDnsToken: boolean; wildcardApex: string | null; panelDomain: string | null }>;
    setPanelDomain: (domain: string) => Promise<{ ok: boolean; panelDomain: string | null }>;
    setAllowRegistration: (enabled: boolean) => Promise<{ ok: boolean; allowRegistration: boolean }>;
    setAcmeEmail: (email: string) => Promise<{ ok: boolean; acmeEmail: string | null; applied: string }>;
    setTemplatesSource: (source: string) => Promise<{ ok: boolean; templatesSource: string | null }>;
    /** Configure the ACME DNS-01 challenge (wildcard certificates). */
    setDns: (input: { provider: string; token?: string; wildcardApex: string }) => Promise<{ ok: boolean; dnsProvider: string | null; wildcardApex: string | null; applied: string }>;
    /**
     * 0.16.1 Automatic URLs: how a service gets its own URL with no DNS work —
     * `<slug>.<domain>` or a free `<slug>.<ip>.sslip.io`. `envWildcard`
     * (NINEDEPLOY_WILDCARD_DOMAIN) wins over the stored choice when set.
     */
    autoUrl: {
      get: () => Promise<AutoUrlSettings>;
      set: (input: { mode: AutoUrlMode; domain?: string; ip?: string }) => Promise<{ ok: boolean; effective: AutoUrlEffective }>;
      /** Asks a public echo service which IPv4 this host egresses from. */
      detectIp: () => Promise<{ ip: string; public: boolean }>;
    };
    /** Vault provider (deploy-time secret resolution). */
    vault: {
      get: () => Promise<VaultSettings>;
      set: (input: { provider: '' | 'infisical' | 'doppler'; token?: string; projectId?: string; environment?: string }) => Promise<{ ok: boolean; provider: string | null }>;
      test: () => Promise<{ ok: boolean; secrets: number }>;
      /** Which workspaces (and legacy un-tagged services) may resolve vault references. */
      setAllowlist: (input: { workspaceIds: number[]; serviceIds?: number[] }) => Promise<{ ok: boolean } & VaultAllowlistView>;
    };
    /** Cloudflare DNS-record auto-provisioning for added domains. */
    dnsRecords: {
      get: () => Promise<{ enabled: boolean; hasToken: boolean; content: string | null }>;
      set: (input: { enabled: boolean; token?: string; content?: string }) => Promise<{ ok: boolean; enabled: boolean }>;
      test: () => Promise<{ ok: boolean; status?: string; error?: string }>;
    };
    /** Namecheap DNS-record auto-provisioning for added domains (G-07 PR-A). */
    namecheap: {
      get: () => Promise<{ configured: boolean; apiUser: string | null; clientIp: string | null; hasKey: boolean }>;
      set: (input: { apiUser: string; apiKey: string; clientIp: string }) => Promise<{ ok: boolean; apiUser: string }>;
    };
    /**
     * G3.5: Route 53, OVH, Porkbun and Hetzner DNS record auto-provisioning.
     * Saving credentials makes that provider the active one; `get` never
     * returns a secret.
     */
    dnsProvider: {
      get: () => Promise<DnsProviderSettings>;
      set: (input: { provider: DnsCredentialProviderName; credentials: Record<string, string> }) => Promise<{ ok: boolean; provider: string }>;
      clear: () => Promise<{ ok: boolean }>;
      test: () => Promise<{ ok: boolean; provider?: string; zones?: string[]; zoneCount?: number; error?: string }>;
    };
    /**
     * Master-key rotation. `rotate` re-encrypts every stored secret onto the
     * highest key version in `NINEDEPLOY_MASTER_KEYS`; it does NOT rewrite
     * backup envelopes, which is what `warning` reports.
     */
    masterKey: {
      get: () => Promise<{ activeVersion: number; knownVersions: number[]; rotatable: boolean }>;
      rotate: () => Promise<{ rotated: number; activeVersion: number; backupsNotRotated: number; warning: string | null }>;
    };
    /**
     * Node-enrolment token (r463): the secret an operator pastes into a
     * remote agent's NINEDEPLOY_ENROLMENT_TOKEN. Returned in clear — the
     * server routes are admin-only for exactly that reason.
     */
    enrolment: {
      get: () => Promise<{ enabled: boolean; token: string | null }>;
      rotate: () => Promise<{ ok: boolean; enabled: boolean; token: string }>;
      disable: () => Promise<{ ok: boolean; enabled: boolean }>;
    };
    /**
     * 0.14: HashiCorp Vault / OpenBao and AWS Secrets Manager (operator-only).
     * Credentials are write-only: `list` never returns them, and an omitted
     * credential field on `set` keeps the stored value.
     */
    secretProviders: {
      list: () => Promise<SecretProviderView[]>;
      set: <K extends SecretProviderKind>(kind: K, input: SecretProviderPutFor<K>) => Promise<SecretProviderView>;
      delete: (kind: SecretProviderKind) => Promise<{ ok: boolean; deleted: boolean }>;
      test: (kind: SecretProviderKind, probe?: SecretProviderTestRequest) => Promise<SecretProviderTestResult>;
    };
  };
  branding: {
    /** Read the four operator-overridable branding fields. G-30. */
    get: () => Promise<{
      logoUrl: string | null;
      primaryColor: string | null;
      supportEmail: string | null;
      footerHtml: string | null;
    }>;
    /** Set one or more branding fields. Empty strings are stored as `null`. */
    set: (input: {
      logoUrl?: string | null;
      primaryColor?: string | null;
      supportEmail?: string | null;
      footerHtml?: string | null;
    }) => Promise<{ ok: boolean }>;
  };
  configPresets: {
    /** Every preset the kernel has registered. */
    list: () => Promise<{ presets: string[] }>;
    /** Fetch a single preset's values + description. */
    get: (id: string) => Promise<{
      id: string;
      description: string | null;
      values: Record<string, unknown>;
      createdAt: string;
    }>;
    /** Register a new preset. Throws if `id` already exists. */
    register: (input: { id: string; description?: string; values: Record<string, unknown> }) => Promise<{ ok: boolean; id: string; keyCount: number }>;
    /** Write every value in the preset to the live configCenter. */
    apply: (id: string, opts?: { override?: Record<string, unknown> }) => Promise<{
      ok: boolean;
      id: string;
      keyCount: number;
      failureCount?: number;
      failures?: Array<{ key: string; status: 'failed'; reason?: string }>;
    }>;
    /** Unregister a preset. Does NOT undo the apply. */
    remove: (id: string) => Promise<{ ok: boolean; id: string }>;
  };
  config: {
    list: (query?: { category?: string; pluginId?: string; reveal?: boolean }) => Promise<ConfigListResponse>;
    get: (key: string) => Promise<ConfigItem>;
    set: (key: string, input: SetConfigInput) => Promise<{ ok: boolean; key: string }>;
    delete: (key: string) => Promise<{ ok: boolean; key: string }>;
  };
  /**
   * Per-workspace email template overrides (G-30).
   * Read-side is open to members; write-side requires the
   * workspace's admin role. The list / preview are safe
   * to call from a CI script; `set` / `reset` mutate the
   * panel's outbound email and should be operator-only.
   */
  emailTemplates: {
    list: (workspaceId: number) => Promise<{ workspaceId: number; templates: EmailTemplateEntry[] }>;
    preview: (workspaceId: number, name: EmailTemplateName, vars?: Record<string, string | number | null>) => Promise<EmailTemplateRender>;
    set: (workspaceId: number, name: EmailTemplateName, subject: string, text: string) => Promise<{ ok: boolean }>;
    reset: (workspaceId: number, name: EmailTemplateName) => Promise<{ ok: boolean }>;
  };
  notifications: {
    /**
     * r473: the provider config blob is encrypted at rest and WRITE-ONLY over
     * the API for everything but the secret-free Discord shape — `configJson`
     * is null with `hasConfig: true` for webhook/FCM channels. Never PATCH
     * the read value back: send the full config, `''` to clear it, or omit
     * the field.
     *
     * r552: the write side is `configJson?: string` — the server schema is
     * `z.string().optional()`, so the `null` the type used to allow was a 400.
     */
    listChannels: () => Promise<Array<{ id: number; name: string; type: string; eventFilter: string; active: boolean; configJson: string | null; hasConfig: boolean; createdAt: string }>>;
    createChannel: (input: { name: string; type: string; target: string; eventFilter?: string; configJson?: string }) => Promise<{ id: number; name: string; type: string }>;
    updateChannel: (id: number, input: { name?: string; target?: string; eventFilter?: string; active?: boolean; configJson?: string }) => Promise<{ id: number; active: boolean }>;
    removeChannel: (id: number) => Promise<void>;
    testChannel: (id: number) => Promise<{ ok: boolean }>;
    log: () => Promise<Array<{ id: number; channelId: number | null; event: string; entity: string | null; status: string; error: string | null; ts: string }>>;
  };
  /** 0.16.1: the operator's Getting started checklist (Dashboard card). */
  onboarding: {
    get: () => Promise<OnboardingStatus>;
    setDismissed: (dismissed: boolean) => Promise<{ ok: boolean; dismissed: boolean }>;
  };
}

export function settingsApi(t: Transport): SettingsApi {
  const { get, send, request } = t;
  return {
    settings: {
      get: () => get<{ allowRegistration: boolean; acmeEmail: string | null; templatesSource: string | null; dnsProvider: string | null; hasDnsToken: boolean; wildcardApex: string | null; panelDomain: string | null }>('/v1/settings'),
      setPanelDomain: (domain) =>
        send<{ ok: boolean; panelDomain: string | null }>('PUT', '/v1/settings/panel-domain', { domain }),
      setAllowRegistration: (enabled) =>
        send<{ ok: boolean; allowRegistration: boolean }>('PUT', '/v1/settings/allow-registration', { enabled }),
      setAcmeEmail: (email) =>
        send<{ ok: boolean; acmeEmail: string | null; applied: string }>('PUT', '/v1/settings/acme-email', { email }),
      setTemplatesSource: (source) =>
        send<{ ok: boolean; templatesSource: string | null }>('PUT', '/v1/settings/templates-source', { source }),
      setDns: (input) =>
        send<{ ok: boolean; dnsProvider: string | null; wildcardApex: string | null; applied: string }>('PUT', '/v1/settings/dns', input),
      autoUrl: {
        get: () => get<AutoUrlSettings>('/v1/settings/auto-url'),
        set: (input) => send<{ ok: boolean; effective: AutoUrlEffective }>('PUT', '/v1/settings/auto-url', input),
        detectIp: () => send<{ ip: string; public: boolean }>('POST', '/v1/settings/auto-url/detect-ip', {}),
      },
      vault: {
        get: () => get<VaultSettings>('/v1/settings/vault'),
        set: (input) => send<{ ok: boolean; provider: string | null }>('PUT', '/v1/settings/vault', input),
        test: () => send<{ ok: boolean; secrets: number }>('POST', '/v1/settings/vault/test'),
        setAllowlist: (input) => send<{ ok: boolean } & VaultAllowlistView>('PUT', '/v1/settings/vault/allowlist', input),
      },
      dnsRecords: {
        get: () => get<{ enabled: boolean; hasToken: boolean; content: string | null }>('/v1/settings/dns-records'),
        set: (input) => send<{ ok: boolean; enabled: boolean }>('PUT', '/v1/settings/dns-records', input),
        test: () => send<{ ok: boolean; status?: string; error?: string }>('POST', '/v1/settings/dns-records/test'),
      },
      namecheap: {
        get: () => get<{ configured: boolean; apiUser: string | null; clientIp: string | null; hasKey: boolean }>('/v1/settings/dns-records/namecheap'),
        set: (input) => send<{ ok: boolean; apiUser: string }>('PUT', '/v1/settings/dns-records/namecheap', input),
      },
      dnsProvider: {
        get: () => get<DnsProviderSettings>('/v1/settings/dns-records/provider'),
        set: (input) => send<{ ok: boolean; provider: string }>('PUT', '/v1/settings/dns-records/provider', input),
        clear: () => send<{ ok: boolean }>('DELETE', '/v1/settings/dns-records/provider'),
        test: () =>
          send<{ ok: boolean; provider?: string; zones?: string[]; zoneCount?: number; error?: string }>('POST', '/v1/settings/dns-records/provider/test'),
      },
      masterKey: {
        get: () => get<{ activeVersion: number; knownVersions: number[]; rotatable: boolean }>('/v1/settings/master-key'),
        rotate: () =>
          send<{ rotated: number; activeVersion: number; backupsNotRotated: number; warning: string | null }>(
            'POST',
            '/v1/settings/master-key/rotate',
          ),
      },
      enrolment: {
        get: () => get<{ enabled: boolean; token: string | null }>('/v1/settings/enrolment'),
        rotate: () => send<{ ok: boolean; enabled: boolean; token: string }>('POST', '/v1/settings/enrolment/rotate'),
        disable: () => send<{ ok: boolean; enabled: boolean }>('DELETE', '/v1/settings/enrolment'),
      },
      secretProviders: {
        list: () => get<SecretProviderView[]>('/v1/settings/secret-providers'),
        set: (kind, input) => send<SecretProviderView>('PUT', `/v1/settings/secret-providers/${kind}`, input),
        delete: (kind) => send<{ ok: boolean; deleted: boolean }>('DELETE', `/v1/settings/secret-providers/${kind}`),
        test: (kind, probe) =>
          send<SecretProviderTestResult>('POST', `/v1/settings/secret-providers/${kind}/test`, probe ?? {}),
      },
    },
    branding: {
      get: () => get<{
        logoUrl: string | null;
        primaryColor: string | null;
        supportEmail: string | null;
        footerHtml: string | null;
      }>('/v1/branding'),
      set: (input) => send<{ ok: boolean }>('PATCH', '/v1/branding', input),
    },
    configPresets: {
      list: () => get<{ presets: string[] }>('/v1/config-presets'),
      get: (id) => get<{
        id: string;
        description: string | null;
        values: Record<string, unknown>;
        createdAt: string;
      }>(`/v1/config-presets/${encodeURIComponent(id)}`),
      register: (input) => send<{ ok: boolean; id: string; keyCount: number }>('POST', '/v1/config-presets', input),
      apply: (id, opts) => send<{
        ok: boolean;
        id: string;
        keyCount: number;
        failureCount?: number;
        failures?: Array<{ key: string; status: 'failed'; reason?: string }>;
      }>('PUT', `/v1/config-presets/${encodeURIComponent(id)}/apply`, opts ?? {}),
      remove: (id) => send<{ ok: boolean; id: string }>('DELETE', `/v1/config-presets/${encodeURIComponent(id)}`),
    },
    config: {
      list: (query) => {
        const parts: string[] = [];
        if (query?.category) parts.push(`category=${encodeURIComponent(query.category)}`);
        if (query?.pluginId) parts.push(`pluginId=${encodeURIComponent(query.pluginId)}`);
        if (query?.reveal) parts.push('reveal=true');
        const qs = parts.length ? `?${parts.join('&')}` : '';
        return get<ConfigListResponse>(`/v1/config${qs}`);
      },
      get: (key) => get<ConfigItem>(`/v1/config/${encodeURIComponent(key)}`),
      set: (key, input) => send<{ ok: boolean; key: string }>('POST', `/v1/config/${encodeURIComponent(key)}`, input),
      delete: (key) => send<{ ok: boolean; key: string }>('DELETE', `/v1/config/${encodeURIComponent(key)}`),
    },
    emailTemplates: {
      list: (workspaceId) =>
        get<{ workspaceId: number; templates: EmailTemplateEntry[] }>(
          `/v1/workspaces/${workspaceId}/email-templates`,
        ),
      preview: (workspaceId, name, vars) =>
        send<EmailTemplateRender>(
          'POST',
          `/v1/workspaces/${workspaceId}/email-templates/preview`,
          { name, vars: vars ?? {} },
        ),
      set: (workspaceId, name, subject, text) =>
        send<{ ok: boolean }>(
          'PUT',
          `/v1/workspaces/${workspaceId}/email-templates/${name}`,
          { subject, text },
        ),
      reset: (workspaceId, name) =>
        send<{ ok: boolean }>('DELETE', `/v1/workspaces/${workspaceId}/email-templates/${name}`, {}),
    },
    notifications: {
      listChannels: () => get<Array<{ id: number; name: string; type: string; eventFilter: string; active: boolean; configJson: string | null; hasConfig: boolean; createdAt: string }>>('/v1/notifications/channels'),
      createChannel: (input) => send('POST', '/v1/notifications/channels', input),
      updateChannel: (id, input) => send('PATCH', `/v1/notifications/channels/${id}`, input),
      removeChannel: async (id) => { await request(`/v1/notifications/channels/${id}`, { method: 'DELETE' }); },
      testChannel: (id) => send('POST', `/v1/notifications/channels/${id}/test`),
      log: () => get('/v1/notifications/log'),
    },
    onboarding: {
      get: () => get<OnboardingStatus>('/v1/onboarding'),
      setDismissed: (dismissed) => send<{ ok: boolean; dismissed: boolean }>('PUT', '/v1/onboarding/dismissed', { dismissed }),
    },
  };
}
