import { vi } from 'vitest';
import type { ReactNode } from 'react';

/**
 * The fake `src/lib/api.ts` module, deliberately kept in its own file with NO
 * imports from `src/`.
 *
 * Every test that mocks the api module does it with an async factory:
 *
 *     vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
 *
 * If that factory awaits `./helpers.js` instead, the run DEADLOCKS: helpers
 * imports `src/lib/workspace.tsx`, which imports `src/lib/api.js` — the module
 * whose factory is still executing. Vitest waits for the factory, the factory
 * waits for the import, and the file never finishes collecting (it reports
 * "no tests" and hangs until killed). Importing this file instead breaks the
 * cycle, because nothing here reaches back into the application.
 *
 * The auth / theme / workspace module mocks live here for the same reason.
 */

export function createFakeApiModule() {
  const api = {
    auth: {
      status: vi.fn(),
      setup: vi.fn(),
      register: vi.fn(),
      login: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      forgotPassword: vi.fn(),
      resetPasswordWithToken: vi.fn(),
      twoFactor: {
        setup: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        recoveryCodes: { status: vi.fn().mockResolvedValue({ totpEnabled: false, remaining: 0 }), regenerate: vi.fn() },
        requirement: vi.fn().mockResolvedValue({ required: false, enrolled: false, verified: false, workspaces: [] }),
      },
      passkeys: {
        list: vi.fn(),
        registerOptions: vi.fn(),
        registerVerify: vi.fn(),
        remove: vi.fn(),
        loginOptions: vi.fn(),
        loginVerify: vi.fn(),
      },
      sessions: { list: vi.fn(), revoke: vi.fn() },
      // Resolves by default: `getToken()` returns a token here, so AuthProvider
      // always calls me() on mount. An un-stubbed vi.fn() returns undefined and
      // the provider would crash on `.then`.
      me: vi.fn(async () => null),
      tokens: { create: vi.fn(), list: vi.fn().mockResolvedValue([]), remove: vi.fn() },
      saml: { publicProviders: vi.fn().mockResolvedValue([]), link: vi.fn() },
      oidc: {
        link: vi.fn(),
        list: vi.fn(),
        publicProviders: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    },
    sso: { listProviders: vi.fn().mockResolvedValue({ providers: [] }), addProvider: vi.fn(), removeProvider: vi.fn() },
    workspaces: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      twoFactor: { get: vi.fn().mockResolvedValue({ required: false, ssoExemptProviders: [], membersWithout: 0 }), set: vi.fn() },
      addMember: vi.fn(),
      updateMemberRole: vi.fn(),
      removeMember: vi.fn(),
      inviteMember: vi.fn(),
      listInvitations: vi.fn().mockResolvedValue([]),
      revokeInvitation: vi.fn(),
      previewInvitation: vi.fn(),
      acceptInvitation: vi.fn(),
    },
    fanout: {
      recovery: vi.fn().mockResolvedValue([]),
      retryRecovery: vi.fn().mockResolvedValue({ recovered: 0, held: 0, entries: [] }),
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn(),
    },
    scim: {
      listTokens: vi.fn().mockResolvedValue([]),
      createToken: vi.fn(),
      revokeToken: vi.fn(),
    },
    services: {
      restartLimit: { get: vi.fn().mockResolvedValue({ limit: null, recentRestarts: 0, trippedAt: null }), set: vi.fn() },
      pending: {
        get: vi.fn().mockResolvedValue({ serviceId: 1, staging: false, changes: [], updatedAt: null, updatedBy: null }),
        stage: vi.fn(),
        setStaging: vi.fn(),
        discard: vi.fn(),
        apply: vi.fn(),
      },
      sizing: vi.fn().mockResolvedValue({ serviceId: 1, spanHours: 0, samples: 0, memory: null, cpu: null, limits: { memoryMiB: null, cpuCores: null }, enoughHistory: false, hints: [] }),
      lifecycle: vi.fn().mockResolvedValue({ command: null }),
      retryLifecycle: vi.fn(),
      routing: vi.fn().mockResolvedValue({ live: true, liveNote: null, container: null, http: [], ports: [] }),
      runtimeRecovery: vi.fn().mockResolvedValue(null),
      retryRuntimeRecovery: vi.fn(),
      swarmRecovery: vi.fn().mockResolvedValue(null),
      retrySwarmRecovery: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      clone: vi.fn(),
      uploadSource: vi.fn(),
      files: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), put: vi.fn(), remove: vi.fn() },
      deployHook: {
        get: vi.fn().mockResolvedValue({ enabled: false, url: null }),
        enable: vi.fn(),
        disable: vi.fn(),
      },
      commitStatus: { get: vi.fn().mockResolvedValue({ enabled: false, provider: null, unavailable: 'The service does not clone through a git source' }), set: vi.fn() },
      registryHook: {
        get: vi.fn().mockResolvedValue({ enabled: false, mine: false, url: null, createdAt: null, lastPushAt: null }),
        enable: vi.fn(),
        disable: vi.fn(),
      },
      maintenance: { get: vi.fn().mockResolvedValue({ maintenance: null, since: null }), set: vi.fn() },
      errorPages: { get: vi.fn().mockResolvedValue({ pages: {} }), set: vi.fn() },
      inlineDockerfile: { get: vi.fn().mockResolvedValue({ content: null }), set: vi.fn() },
      errors: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        setStatus: vi.fn(),
        ingest: { get: vi.fn().mockResolvedValue({ enabled: false, createdAt: null }), create: vi.fn(), remove: vi.fn() },
      },
      move: { get: vi.fn().mockResolvedValue({ state: 'none', from: null, to: null, step: null, error: null, startedAt: null, finishedAt: null, deploymentId: null }), start: vi.fn() },
      badge: {
        get: vi.fn().mockResolvedValue({ enabled: false, url: null }),
        enable: vi.fn(),
        disable: vi.fn(),
      },
      sourceUploads: vi.fn().mockResolvedValue({ uploadSourced: true, maxBytes: 104857600, uploads: [] }),
      hostAddresses: vi.fn().mockResolvedValue({ detected: false, addresses: [] }),
      stop: vi.fn(),
      start: vi.fn(),
      restart: vi.fn(),
      logs: vi.fn(),
      exportUrl: vi.fn(),
      importBundle: vi.fn(),
      // 0.13: the GitHub App link (SettingsTab GitHub card).
      github: {
        get: vi.fn().mockResolvedValue({ link: null }),
        link: vi.fn(),
        feedback: vi.fn(),
        migrate: vi.fn(),
        finalize: vi.fn(),
        unlink: vi.fn(),
      },
      // Multi-node: build placement, image transfers and the Swarm tasks.
      placement: { get: vi.fn(), set: vi.fn() },
      imageTransfers: vi.fn().mockResolvedValue([]),
      swarm: vi.fn(),
    },
    environments: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      rename: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    ai: {
      getConfig: vi.fn().mockResolvedValue({ configured: false, baseUrl: null, model: null, hasApiKey: false }),
      updateConfig: vi.fn(),
      diagnose: vi.fn(),
      suggestManifest: vi.fn(),
      analyzeLogs: vi.fn(),
    },
    deploys: {
      trigger: vi.fn(),
      list: vi.fn(),
      queue: vi.fn().mockResolvedValue({ items: [], count: 0, byStatus: { queued: 0, building: 0, deploying: 0 } }),
      rollback: vi.fn(),
      releaseInfo: vi.fn().mockResolvedValue({ available: true, mode: 'legacy', imageCount: 0, reason: 'Legacy redeploy: current settings and environment.' }),
      cancel: vi.fn(),
      remove: vi.fn(),
      removeMany: vi.fn(),
      configDiff: vi.fn(),
      promote: vi.fn(),
      approvals: vi.fn().mockResolvedValue({ items: [], count: 0 }),
      approve: vi.fn(),
      reject: vi.fn(),
    },
    domains: {
      forwardAuth: { get: vi.fn().mockResolvedValue({ domainId: 0, forwardAuth: null }), set: vi.fn(), grant: vi.fn() },
      composeRoute: { get: vi.fn().mockResolvedValue({ domainId: 0, route: null, services: null }), set: vi.fn() },
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      generate: vi.fn(),
      all: vi.fn().mockResolvedValue([]),
      setSsl: vi.fn(),
      update: vi.fn(),
      transfer: vi.fn(),
      previewTransfer: vi.fn(),
      acceptTransfer: vi.fn(),
      cancelTransfer: vi.fn(),
    },
    volumes: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), prune: vi.fn(), listFiles: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), deleteFile: vi.fn() },
    serviceVolumes: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    volumeBackups: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      restore: vi.fn(),
      downloadUrl: vi.fn((volumeName: string, id: number) => `/v1/volumes/${volumeName}/backups/${id}/download`),
    },
    containers: { inspect: vi.fn(), compose: vi.fn(), listFiles: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), deleteFile: vi.fn() },
    // G1.5: no DNS provider registered by default, so the record card stays hidden.
    domainPresets: { list: vi.fn().mockResolvedValue({ providers: [] }), apply: vi.fn() },
    gitops: { get: vi.fn().mockResolvedValue({ config: null, lastCheck: null }), configure: vi.fn(), remove: vi.fn(), check: vi.fn(), apply: vi.fn(), export: vi.fn() },
    system: { resources: vi.fn(), pruneImages: vi.fn(), exportUrl: vi.fn(), updateCheck: vi.fn(), updateStatus: vi.fn(), updateStart: vi.fn(), dockerEvents: vi.fn() },
    networks: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), attach: vi.fn(), detach: vi.fn() },
    // G1.5: Settings → Security outgoing IP card; no rules on the iptables driver by default.
    egress: { list: vi.fn().mockResolvedValue({ drivers: [{ name: 'iptables', rules: [] }] }), set: vi.fn(), clear: vi.fn() },
    tunnels: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    activity: { list: vi.fn() },
    alerts: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    users: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), resetPassword: vi.fn(), resetLink: vi.fn(), setOperator: vi.fn() },
    settings: {
      get: vi.fn(),
      setAllowRegistration: vi.fn(),
      setAcmeEmail: vi.fn(),
      setPanelDomain: vi.fn(),
      setTemplatesSource: vi.fn(),
      setDns: vi.fn(),
      dnsRecords: { get: vi.fn(), set: vi.fn(), test: vi.fn() },
      namecheap: { get: vi.fn(), set: vi.fn() },
      dnsProvider: {
        get: vi.fn().mockResolvedValue({ providers: ['route53', 'ovh', 'porkbun', 'hetzner'], provider: null, configured: null, fields: {} }),
        set: vi.fn(), clear: vi.fn(), test: vi.fn(),
      },
      vault: { get: vi.fn(), set: vi.fn(), test: vi.fn(), setAllowlist: vi.fn() },
      autoUrl: {
        get: vi.fn().mockResolvedValue({
          effective: { mode: 'off', domain: null, ip: null, source: 'setting' },
          stored: { mode: 'off', domain: null, ip: null },
          envWildcard: null,
          suggestedIp: null,
        }),
        set: vi.fn(),
        detectIp: vi.fn(),
      },
    },
    // null = no checklist rendered; Dashboard/GettingStarted tests stub it.
    onboarding: { get: vi.fn().mockResolvedValue(null), setDismissed: vi.fn() },
    about: { get: vi.fn() },
    branding: {
      get: vi.fn().mockResolvedValue({ logoUrl: null, primaryColor: null, supportEmail: null, footerHtml: null }),
      set: vi.fn(),
    },
    notifications: {
      listChannels: vi.fn(),
      createChannel: vi.fn(),
      updateChannel: vi.fn(),
      removeChannel: vi.fn(),
      testChannel: vi.fn(),
      log: vi.fn(),
    },
    sources: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    // 0.13: GitHub App registration (Sources page panel, setup redirect pages).
    githubApps: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      manifest: vi.fn(),
      completeManifest: vi.fn(),
      patch: vi.fn(),
      rotateKey: vi.fn(),
      webhookSync: vi.fn(),
      rotateWebhookSecret: vi.fn(),
      remove: vi.fn(),
      syncInstallations: vi.fn(),
      installations: vi.fn().mockResolvedValue([]),
      runners: vi.fn(),
      setRunners: vi.fn(),
      stopRunner: vi.fn().mockResolvedValue(undefined),
    },
    insights: { analyze: vi.fn(), get: vi.fn().mockResolvedValue(null), refresh: vi.fn() },
    projects: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    labels: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    serviceTags: { get: vi.fn().mockResolvedValue({ serviceId: 0, projects: [], workspaces: [], labels: [] }), set: vi.fn() },
    webhooks: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    databases: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      logs: vi.fn(),
      credentials: vi.fn(),
      setLimits: vi.fn(),
      startStudio: vi.fn(),
      stopStudio: vi.fn(),
      // 0.14: an unconfigured public endpoint and an empty import history.
      publicAccess: {
        get: vi.fn().mockResolvedValue({
          supported: true, configured: false, enabled: false, port: null, tlsMode: 'none', tlsHostname: null,
          ipAllowlist: [], status: 'off', lastError: null, appliedAt: null, publicHost: null,
        }),
        set: vi.fn(),
        disable: vi.fn(),
      },
      imports: {
        create: vi.fn(), uploadChunk: vi.fn(), start: vi.fn(), list: vi.fn().mockResolvedValue([]),
        get: vi.fn(), cancel: vi.fn(), wait: vi.fn(),
      },
      importFile: vi.fn(),
      // G1.5: PgBouncer and backup drills got web controls; an off sidecar and no drills by default.
      pgbouncerStatus: vi.fn().mockResolvedValue({ enabled: false, containerName: null, port: 6432, running: false, poolMode: null, pooledConnectionString: null }),
      enablePgbouncer: vi.fn(),
      disablePgbouncer: vi.fn(),
      drills: vi.fn().mockResolvedValue([]),
      drillBackup: vi.fn(),
    },
    attachments: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    env: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    projectEnv: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    // Usage and cost (Monitoring, operators): an empty report by default.
    usage: {
      report: vi.fn().mockResolvedValue({
        from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', days: 30, currency: 'USD', historyDays: 30, trafficAnalytics: true,
        services: [], projects: [], workspaces: [], servers: [],
        totals: { cpuCoreHours: 0, memoryGbHours: 0, egressGb: 0, requests: 0, cost: null },
      }),
      costs: vi.fn(), setCosts: vi.fn(),
    },
    stats: {
      observability: {
        get: vi.fn().mockResolvedValue({ settings: { retentionDays: 1, prometheusEnabled: false, otlpEndpoint: '', logQueueMaxMb: 16, hasOtlpAuthorization: false }, exportStatus: { lastAttemptAt: null, lastSuccessAt: null, result: null } }),
        update: vi.fn(), test: vi.fn(),
      },
      // Defaults keep react-query v5 happy ("query data cannot be undefined")
      // for every page that renders live stats without an explicit mock.
      snapshot: vi.fn().mockResolvedValue({
        host: { cpuCores: 4, load1: 0.5, memUsedBytes: 1, memTotalBytes: 2, diskUsedBytes: 1, diskTotalBytes: 2 },
        containers: [],
      }),
      metrics: vi.fn().mockResolvedValue({ points: [] }),
    },
    dashboard: { get: vi.fn() },
    topology: { get: vi.fn() },
    templates: { list: vi.fn(), get: vi.fn(), deploy: vi.fn() },
    backups: {
      storage: vi.fn(),
      backupNow: vi.fn(),
      listForDb: vi.fn(),
      restore: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      downloadUrl: vi.fn(),
      // 0.12: a database with no saved policy (the built-in schedule).
      getPolicy: vi.fn(async (databaseId: number) => ({
        databaseId, configured: false, enabled: true, cron: null, retainCount: 7,
        retainRemoteCount: null, destinationId: null, localOnly: false, nextRunAt: null, updatedAt: null,
      })),
      setPolicy: vi.fn(),
      replicas: { get: vi.fn(async (databaseId: number) => ({ databaseId, replicas: [] })), set: vi.fn() },
    },
    limits: { setService: vi.fn(), setDatabase: vi.fn() },
    backupDestinations: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn(), objects: vi.fn().mockResolvedValue([]) },
    jobs: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), run: vi.fn(), runs: vi.fn() },
    servers: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      sshTest: vi.fn(),
      sshBootstrap: vi.fn(),
      bootstrapLogs: vi.fn(),
      // Multi-node: the build-server role and Swarm membership.
      update: vi.fn(),
      swarmJoin: vi.fn(),
      swarmLeave: vi.fn(),
    },
    // Multi-node: Swarm on the panel host (Settings → Swarm).
    swarm: { get: vi.fn(), init: vi.fn(), settings: vi.fn() },
    osUpdates: { get: vi.fn(), setAuto: vi.fn() },
    cloud: { digitalocean: { status: vi.fn(), setToken: vi.fn(), deleteToken: vi.fn(), options: vi.fn(), servers: vi.fn().mockResolvedValue([]), createServer: vi.fn(), deleteServer: vi.fn() }, hetzner: { status: vi.fn(), setToken: vi.fn(), deleteToken: vi.fn(), options: vi.fn(), servers: vi.fn().mockResolvedValue([]), createServer: vi.fn(), deleteServer: vi.fn() }, vultr: { status: vi.fn(), setToken: vi.fn(), deleteToken: vi.fn(), options: vi.fn(), servers: vi.fn().mockResolvedValue([]), createServer: vi.fn(), deleteServer: vi.fn() } },
    deployFreezes: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), lift: vi.fn() },
    imageScans: { policy: vi.fn(), setPolicy: vi.fn(), get: vi.fn().mockResolvedValue({ result: null, scanning: false }), scan: vi.fn() },
    traefik: {
      sharedCertificates: { get: vi.fn().mockResolvedValue({ enabled: false }), set: vi.fn() },
      get: vi.fn(),
      status: vi.fn(),
      certificates: vi.fn(),
      logs: vi.fn(),
      restart: vi.fn(),
      backupCerts: vi.fn(),
      http3: { get: vi.fn().mockResolvedValue({ enabled: false }), set: vi.fn() },
    },
    config: { list: vi.fn(), get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    plugins: { list: vi.fn(), marketplace: vi.fn(), install: vi.fn(), enable: vi.fn(), disable: vi.fn(), reload: vi.fn(), inspect: vi.fn(), uninstall: vi.fn() },
    menus: { list: vi.fn() },
    logDrains: {
      // G1.5: shipped-log search on the service Activity tab.
      search: vi.fn(),
      queue: vi.fn().mockResolvedValue({ pendingBatches: 0, pendingEntries: 0, payloadBytes: 0, blockedBatches: 0, pausedSources: 0, oldestAt: null }),
      retryQueue: vi.fn(), discardQueue: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
    },
    housekeeping: {
      getAutoPrune: vi.fn(),
      updateAutoPrune: vi.fn(),
      runPrune: vi.fn(),
    },
    doctor: {
      scan: vi.fn(),
      fix: vi.fn(),
    },
    demo: { seed: vi.fn() },
    health: vi.fn(),
    hostIps: {
      list: vi.fn().mockResolvedValue({ detected: true, addresses: [] }),
      primary: vi.fn().mockResolvedValue({ ip: null }),
      set: vi.fn(),
      remove: vi.fn(),
    },
    firewall: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        active: true,
        supported: true,
        rules: [],
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      }),
      toggle: vi.fn(),
      addRule: vi.fn(),
      deleteRule: vi.fn(),
      applyRecommended: vi.fn(),
    },
    // 0.15 T6: terminals, traffic analytics, access grants
    terminals: {
      create: vi.fn(),
      list: vi.fn().mockResolvedValue({ items: [], nextBefore: null }),
      get: vi.fn(),
      terminate: vi.fn(),
      settings: {
        get: vi.fn().mockResolvedValue({ hostTerminalEnabled: false, hostTerminalForbiddenByEnv: false, idleTimeoutMinutes: 15, maxSessionMinutes: 240, maxConcurrent: 10, retentionDays: 180 }),
        set: vi.fn(),
      },
      attachInfo: vi.fn(),
      connect: vi.fn(),
    },
    traffic: {
      settings: { get: vi.fn(), set: vi.fn() },
      summary: vi.fn(),
      service: vi.fn().mockResolvedValue({ enabled: false, range: '24h', granularity: 60, totals: { requests: 0, status1xx: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0, bytesOut: 0, durationSumMs: 0, durationMaxMs: 0, p50Ms: null, p95Ms: null, p99Ms: null }, series: [], domains: [] }),
    },
    // G1.5: the Workspaces email templates card; built-in text for every template by default.
    emailTemplates: {
      list: vi.fn().mockResolvedValue({ workspaceId: 1, templates: [] }),
      preview: vi.fn(), set: vi.fn(), reset: vi.fn(),
    },
    accessGrants: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    access: { me: vi.fn().mockResolvedValue({ grants: [], guestWorkspaces: [] }), project: vi.fn().mockResolvedValue([]) },
  };
  const getToken = vi.fn((): string | null => 'test-token');
  return {
    api,
    getToken,
    setToken: vi.fn(),
    setSessionTokens: vi.fn(),
    clearTokens: vi.fn(),
    deployLogsWsUrl: vi.fn(() => 'ws://localhost/v1/logs'),
    websocketAuthProtocols: vi.fn(() => ['nd-auth', 'test-token']),
    // Mirrors the real authedFetch: bearer header from getToken + plain fetch.
    authedFetch: (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const token = getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    },
  };
}

/**
 * The `uptimeApi` object of `src/lib/uptimeApi.js` (0.16.8), every call a
 * `vi.fn()`; listings resolve empty. Mock the module with the real query
 * keys kept:
 *
 *     vi.mock('../src/lib/uptimeApi.js', async (importOriginal) => ({
 *       ...(await importOriginal<typeof import('../src/lib/uptimeApi.js')>()),
 *       uptimeApi: (await import('./apiMock.js')).createUptimeApiMock(),
 *     }));
 */
export function createUptimeApiMock() {
  return {
    monitors: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      checks: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      check: vi.fn(),
    },
    statusPages: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  };
}

/**
 * The `canaryApi` object of `src/lib/canaryApi.js` (0.16.9). `status` resolves
 * to no canary, so a page that polls it renders nothing extra. Mock the module
 * with the real query keys kept:
 *
 *     vi.mock('../src/lib/canaryApi.js', async (importOriginal) => ({
 *       ...(await importOriginal<typeof import('../src/lib/canaryApi.js')>()),
 *       canaryApi: (await import('./apiMock.js')).createCanaryApiMock(),
 *     }));
 */
export function createCanaryApiMock() {
  return {
    status: vi.fn().mockResolvedValue({ active: false }),
    promote: vi.fn().mockResolvedValue({ ok: true }),
  };
}

/**
 * The `autoscaleApi` object of `src/lib/autoscaleApi.js` (0.16.10). `status`
 * resolves to autoscaling off, so a page that polls it renders nothing extra.
 * Mock the module with the real query keys kept:
 *
 *     vi.mock('../src/lib/autoscaleApi.js', async (importOriginal) => ({
 *       ...(await importOriginal<typeof import('../src/lib/autoscaleApi.js')>()),
 *       autoscaleApi: (await import('./apiMock.js')).createAutoscaleApiMock(),
 *     }));
 */
export function createAutoscaleApiMock() {
  return {
    status: vi.fn().mockResolvedValue({ enabled: false, replicas: 1 }),
  };
}

/**
 * The `sleepApi` object of `src/lib/sleepApi.js` (0.16.11): sleep and wake
 * resolve as the server answers them. Mock the module:
 *
 *     vi.mock('../src/lib/sleepApi.js', async () => ({
 *       sleepApi: (await import('./apiMock.js')).createSleepApiMock(),
 *     }));
 */
export function createSleepApiMock() {
  return {
    sleep: vi.fn().mockResolvedValue({ ok: true, asleep: true }),
    wake: vi.fn().mockResolvedValue({ ok: true, status: 'running' }),
  };
}

/** Mock module for `src/lib/auth.js`: `useAuth` is a controllable spy. */
export function createAuthMock() {
  // `useAuth` resolves to a signed-out session by default. It used to be a bare
  // vi.fn() returning undefined, which is fine for a component that ignores the
  // result but crashes anything doing `const { user } = useAuth()` — including
  // WorkspaceProvider, which every rendered route sits inside.
  return {
    AuthProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useAuth: vi.fn(() => ({ user: null, loading: false })),
  };
}

/** Mock module for `src/lib/theme.js`. */
export function createThemeMock() {
  const theme = {
    theme: 'dark' as const,
    accent: 'phosphor' as const,
    setTheme: vi.fn(),
    setAccent: vi.fn(),
    toggleTheme: vi.fn(),
  };
  const ACCENTS = [
    { id: 'phosphor', label: 'Phosphor', color: '#4ecdc4' },
    { id: 'indigo', label: 'Indigo', color: '#6366f1' },
    { id: 'blue', label: 'Blue', color: '#3b82f6' },
    { id: 'emerald', label: 'Emerald', color: '#10b981' },
    { id: 'rose', label: 'Rose', color: '#f43f5e' },
    { id: 'amber', label: 'Amber', color: '#f59e0b' },
    { id: 'violet', label: 'Violet', color: '#8b5cf6' },
  ];
  return {
    ThemeProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useTheme: vi.fn(() => theme),
    ACCENTS,
    __theme: theme,
  };
}

/** Mock module for `src/lib/workspace.js`. */
export function createWorkspaceMock() {
  return {
    WorkspaceProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
    rememberWorkspace: vi.fn(),
    useWorkspace: vi.fn(() => ({
      workspaces: [],
      currentWorkspace: null,
      isLoading: false,
      switchWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      refreshWorkspaces: vi.fn(),
    })),
  };
}

/** Mock module for `src/lib/mode.js`. The mode is parameterized per render
 * so the menu smoke test can flip between Simple and Advanced for the
 * `advancedOnly` items (Networks, Tunnels, Docker, Servers). The factory
 * returns a stub; individual tests override `useExperienceMode` with
 * `mockOf(...).mockReturnValue(...)` to flip the mode. */
export function createModeMock() {
  return {
    ModeProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
    ModeToggle: () => null,
    useExperienceMode: vi.fn(() => ({
      mode: 'simple' as 'simple' | 'advanced',
      isAdvanced: false,
      isSimple: true,
      setMode: vi.fn(),
      toggleMode: vi.fn(),
    })),
  };
}
