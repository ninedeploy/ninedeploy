import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * H-3 (UI half): deployment lifecycle hooks execute binaries on the HOST, so
 * `assertMayUseHostPrivilege` restricts them to admins. The settings form must
 * not offer them to a member — otherwise every save comes back 403 — and, more
 * importantly, a member's save must OMIT the hook keys rather than send them
 * empty, or an ordinary rename would clear what an admin configured.
 *
 * Deliberately self-contained (no `./helpers.js`): every web test file that
 * pulls helpers in currently hangs vitest collection in this repo, which is a
 * pre-existing problem unrelated to this change.
 */

const apiMock = vi.hoisted(() => ({
  api: {
    services: { get: vi.fn(), update: vi.fn() },
    limits: { setService: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

import { SettingsTab } from '../src/routes/service/SettingsTab.js';

const service = {
  id: 1,
  name: 'api',
  slug: 'api',
  type: 'docker',
  branch: 'main',
  port: 3000,
  repoUrl: 'https://github.com/x/y',
  status: 'running',
  healthPath: '/',
  cpuShares: 0,
  memLimitMb: 0,
  build: {
    buildPack: 'auto',
    baseDir: '/',
    installCmd: 'npm ci',
    buildCmd: 'npm run build',
    startCmd: 'npm start',
    dockerfilePath: null,
    preDeployCmd: 'make migrate',
    postDeployCmd: null,
    preStopCmd: null,
  },
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SettingsTab serviceId={1} svc={service as never} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The `build` object the form sent on the first PATCH. */
async function savedBuild(): Promise<Record<string, unknown>> {
  // Generous timeout: on shared CI runners this whole suite can be starved of
  // CPU while dozens of sibling vitest processes boot, and the default 1 s has
  // been observed to expire before react-query dispatches the PATCH. 10 s was
  // enough for an isolated run but still false-failed under the full web
  // suite (other packages boot vitest workers in parallel). 30 s gives the
  // event loop enough headroom to dispatch the PATCH on a slow host without
  // hiding real regressions.
  await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalled(), { timeout: 30_000 });
  const [, patch] = apiMock.api.services.update.mock.calls[0] as [number, { build: Record<string, unknown> }];
  return patch.build;
}

describe('SettingsTab host-privilege gating', () => {
  afterEach(cleanup);

  // The admin-save path chains several react-query round-trips through
  // SettingsTab; on loaded CI runners it can exceed 15s, and under
  // coverage instrumentation (roughly 2× slower) even the 30s global
  // ceiling was observed to overflow when the suite runs fully parallel.
  const TIMEOUT = 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    apiMock.api.services.get.mockResolvedValue(service);
    apiMock.api.services.update.mockResolvedValue(service);
    apiMock.api.limits.setService.mockResolvedValue({ cpuShares: 0, memLimitMb: 0 });
  });

  it('shows the lifecycle hook fields to an admin', async () => {
    renderTab();
    await screen.findByText('Service settings');
    expect(screen.getByText('CI/CD Lifecycle Hooks')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('npm run db:migrate')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('npm run cleanup')).toBeInTheDocument();
  }, TIMEOUT);

  it('sends the hook values an admin has configured', async () => {
    renderTab();
    await screen.findByText('Service settings');
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }));
    expect((await savedBuild()).preDeployCmd).toBe('make migrate');
  }, TIMEOUT);

  it('hides the lifecycle hook fields from a member', async () => {
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    renderTab();
    await screen.findByText('Service settings');
    expect(screen.queryByText('CI/CD Lifecycle Hooks')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('npm run db:migrate')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('npm run cleanup')).not.toBeInTheDocument();
    // the rest of the build form is untouched
    expect(screen.getByPlaceholderText('npm run build')).toBeInTheDocument();
  }, TIMEOUT);

  it("omits the hook keys from a member's patch instead of clearing them", async () => {
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    renderTab();
    await screen.findByText('Service settings');
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }));
    const build = await savedBuild();
    // absent, not '' — an empty string would wipe the admin's `make migrate`
    expect(build.preDeployCmd).toBeUndefined();
    expect(build.postDeployCmd).toBeUndefined();
    expect(build.preStopCmd).toBeUndefined();
    // and the unprivileged fields still go through
    expect(build.buildCmd).toBe('npm run build');
  }, TIMEOUT);
});
