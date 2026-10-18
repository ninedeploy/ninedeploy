import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * 0.16.1 Dockerfile build arguments in Service → Settings → Build: the
 * names are typed or picked from the service's variables, sent as a
 * de-duplicated list, never sent to a server that does not report the field,
 * and offered only where a Dockerfile build can happen.
 *
 * Self-contained like SettingsTabPrivilege.test.tsx (no `./helpers.js`).
 */

const apiMock = vi.hoisted(() => ({
  api: {
    services: { get: vi.fn(), update: vi.fn() },
    limits: { setService: vi.fn() },
    environments: { list: vi.fn() },
    sources: { list: vi.fn() },
    env: { list: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

import { SettingsTab } from '../src/routes/service/SettingsTab.js';
import { parseBuildArgNames } from '../src/routes/service/BuildArgsField.js';

const TIMEOUT = 60_000;

function serviceWith(build: Record<string, unknown>) {
  return {
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
      buildPack: 'dockerfile',
      baseDir: '/',
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      dockerfilePath: null,
      preDeployCmd: null,
      postDeployCmd: null,
      preStopCmd: null,
      restartPolicy: 'unless-stopped',
      stopGraceSeconds: 5,
      ...build,
    },
  };
}

function renderTab(service: ReturnType<typeof serviceWith>) {
  apiMock.api.services.get.mockResolvedValue(service);
  apiMock.api.services.update.mockResolvedValue(service);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SettingsTab serviceId={1} svc={service as never} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function savedBuild(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalled(), { timeout: 30_000 });
  const [, patch] = apiMock.api.services.update.mock.calls[0] as [number, { build: Record<string, unknown> }];
  return patch.build;
}

describe('parseBuildArgNames', () => {
  it('splits on commas and whitespace, keeps order, drops repeats, reports non-names', () => {
    expect(parseBuildArgNames(' A, B\nC  A,, 1X, a-b ')).toEqual({ names: ['A', 'B', 'C'], invalid: ['1X', 'a-b'] });
    expect(parseBuildArgNames('')).toEqual({ names: [], invalid: [] });
  });
});

describe('Build arguments field', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.environments.list.mockResolvedValue([]);
    apiMock.api.sources.list.mockResolvedValue([]);
    apiMock.api.limits.setService.mockResolvedValue({ cpuShares: 0, memLimitMb: 0 });
    apiMock.api.env.list.mockResolvedValue([
      { id: 1, key: 'NEXT_PUBLIC_API', value: 'https://api', isSecret: false },
      { id: 2, key: 'NODE_VERSION', value: '22', isSecret: false },
      { id: 3, key: 'STRIPE_KEY', value: '', isSecret: true },
    ]);
  });

  it('prefills the stored names and sends the edited list de-duplicated', async () => {
    renderTab(serviceWith({ buildArgs: ['NEXT_PUBLIC_API'] }));
    const input = await screen.findByLabelText('Build arguments');
    expect(input).toHaveValue('NEXT_PUBLIC_API');
    fireEvent.change(input, { target: { value: 'NEXT_PUBLIC_API, NODE_VERSION NEXT_PUBLIC_API' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await savedBuild()).buildArgs).toEqual(['NEXT_PUBLIC_API', 'NODE_VERSION']);
  }, TIMEOUT);

  it("offers the service's variables as chips; a click adds one", async () => {
    renderTab(serviceWith({ buildArgs: [] }));
    const chip = await screen.findByRole('button', { name: /NODE_VERSION/ });
    fireEvent.click(chip);
    expect(screen.getByLabelText('Build arguments')).toHaveValue('NODE_VERSION');
    expect(screen.queryByRole('button', { name: /^NODE_VERSION$/ })).not.toBeInTheDocument();
  }, TIMEOUT);

  it('warns when a secret is listed, and blocks saving a name that is not one', async () => {
    renderTab(serviceWith({ buildArgs: ['STRIPE_KEY'] }));
    expect(await screen.findByText(/STRIPE_KEY is a secret/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Build arguments'), { target: { value: 'STRIPE-KEY' } });
    expect(screen.getByText(/Not a variable name: STRIPE-KEY/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save settings/ })).toBeDisabled();
  }, TIMEOUT);

  it('is not offered for a Nixpacks build, and never sent to a server without the field', async () => {
    renderTab(serviceWith({ buildPack: 'nixpacks', buildArgs: [] }));
    await screen.findByText('Service settings');
    expect(screen.queryByLabelText('Build arguments')).not.toBeInTheDocument();
    cleanup();
    vi.clearAllMocks();
    renderTab(serviceWith({}));
    await screen.findByText('Service settings');
    expect(screen.queryByLabelText('Build arguments')).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await savedBuild()).buildArgs).toBeUndefined();
  }, TIMEOUT);
});

describe('Build stage field (0.16.2)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.environments.list.mockResolvedValue([]);
    apiMock.api.sources.list.mockResolvedValue([]);
    apiMock.api.limits.setService.mockResolvedValue({ cpuShares: 0, memLimitMb: 0 });
    apiMock.api.env.list.mockResolvedValue([]);
  });

  it('prefills the stored stage and sends the edited one trimmed; blank clears', async () => {
    renderTab(serviceWith({ buildTarget: 'runtime' }));
    const input = await screen.findByLabelText('Build stage');
    expect(input).toHaveValue('runtime');
    fireEvent.change(input, { target: { value: ' prod ' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await savedBuild()).buildTarget).toBe('prod');
    cleanup();
    vi.clearAllMocks();
    renderTab(serviceWith({ buildTarget: 'runtime' }));
    fireEvent.change(await screen.findByLabelText('Build stage'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await savedBuild()).buildTarget).toBe('');
  }, TIMEOUT);

  it('blocks saving a name Docker would not take', async () => {
    renderTab(serviceWith({ buildTarget: null }));
    fireEvent.change(await screen.findByLabelText('Build stage'), { target: { value: '--push' } });
    expect(screen.getByText(/A stage name starts with a letter/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save settings/ })).toBeDisabled();
  }, TIMEOUT);

  it('is not offered for a Nixpacks build, and never sent to a server without the field', async () => {
    renderTab(serviceWith({ buildPack: 'nixpacks', buildTarget: null }));
    await screen.findByText('Service settings');
    expect(screen.queryByLabelText('Build stage')).not.toBeInTheDocument();
    cleanup();
    vi.clearAllMocks();
    renderTab(serviceWith({}));
    await screen.findByText('Service settings');
    expect(screen.queryByLabelText('Build stage')).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await savedBuild()).buildTarget).toBeUndefined();
  }, TIMEOUT);
});
