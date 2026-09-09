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
      twoFactor: { setup: vi.fn(), enable: vi.fn(), disable: vi.fn() },
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
      tokens: { create: vi.fn(), list: vi.fn(), remove: vi.fn() },
      oidc: {
        list: vi.fn(),
        publicProviders: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    },
    workspaces: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      addMember: vi.fn(),
      updateMemberRole: vi.fn(),
      removeMember: vi.fn(),
      inviteMember: vi.fn(),
      listInvitations: vi.fn().mockResolvedValue([]),
      revokeInvitation: vi.fn(),
      previewInvitation: vi.fn(),
      acceptInvitation: vi.fn(),
    },
    services: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      clone: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      restart: vi.fn(),
      logs: vi.fn(),
      exportUrl: vi.fn(),
      importBundle: vi.fn(),
    },
    environments: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
    },
    deploys: {
      trigger: vi.fn(),
      list: vi.fn(),
      queue: vi.fn().mockResolvedValue({ items: [], count: 0, byStatus: { queued: 0, building: 0, deploying: 0 } }),
      rollback: vi.fn(),
      cancel: vi.fn(),
      remove: vi.fn(),
      configDiff: vi.fn(),
      promote: vi.fn(),
    },
    domains: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), all: vi.fn().mockResolvedValue([]), setSsl: vi.fn(), update: vi.fn() },
    volumes: { list: vi.fn(), remove: vi.fn(), prune: vi.fn(), listFiles: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), deleteFile: vi.fn() },
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
    system: { resources: vi.fn(), pruneImages: vi.fn(), exportUrl: vi.fn(), updateCheck: vi.fn(), updateStatus: vi.fn(), updateStart: vi.fn(), dockerEvents: vi.fn() },
    networks: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), attach: vi.fn(), detach: vi.fn() },
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
      vault: { get: vi.fn(), set: vi.fn(), test: vi.fn() },
    },
    about: { get: vi.fn() },
    notifications: {
      listChannels: vi.fn(),
      createChannel: vi.fn(),
      updateChannel: vi.fn(),
      removeChannel: vi.fn(),
      testChannel: vi.fn(),
      log: vi.fn(),
    },
    sources: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
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
    },
    attachments: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    env: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    stats: {
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
    },
    limits: { setService: vi.fn(), setDatabase: vi.fn() },
    backupDestinations: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn() },
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
    },
    traefik: { get: vi.fn(), status: vi.fn(), certificates: vi.fn(), logs: vi.fn(), restart: vi.fn(), backupCerts: vi.fn() },
    config: { list: vi.fn(), get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    plugins: { list: vi.fn(), marketplace: vi.fn(), install: vi.fn(), enable: vi.fn(), disable: vi.fn(), reload: vi.fn(), inspect: vi.fn(), uninstall: vi.fn() },
    menus: { list: vi.fn() },
    logDrains: {
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
  };
  const getToken = vi.fn((): string | null => 'test-token');
  return {
    api,
    getToken,
    setToken: vi.fn(),
    setSessionTokens: vi.fn(),
    clearTokens: vi.fn(),
    deployLogsWsUrl: vi.fn(() => 'ws://localhost/v1/logs'),
    // Mirrors the real authedFetch: bearer header from getToken + plain fetch.
    authedFetch: (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const token = getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    },
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
