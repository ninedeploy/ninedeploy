import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * 0.16.1: the Container options card (operator-edited, read-only for
 * everyone else) and the per-service healthcheck timeout field. Neither is
 * shown — nor sent — when the panel does not report the field.
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
import { describeRuntimeOptions } from '../src/routes/service/ContainerOptionsCard.js';

const TIMEOUT = 60_000;

function serviceWith(over: Record<string, unknown>) {
  return {
    id: 1, name: 'ollama', slug: 'ollama', type: 'docker', branch: 'main', port: 11434, image: 'ollama/ollama', repoUrl: null,
    status: 'running', healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, replicas: 1,
    build: { buildPack: 'auto', baseDir: '/', installCmd: null, buildCmd: null, startCmd: null, dockerfilePath: null, restartPolicy: 'unless-stopped', stopGraceSeconds: 5 },
    ...over,
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

async function lastPatch(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalled(), { timeout: 30_000 });
  return apiMock.api.services.update.mock.calls.at(-1)![1] as Record<string, unknown>;
}

describe('describeRuntimeOptions', () => {
  it('reads each option in words', () => {
    expect(describeRuntimeOptions({ gpus: 'all', shmSizeMb: 1024, init: true, ulimitNofile: 65536, capAdd: ['NET_ADMIN'] })).toEqual([
      'All GPUs', '1024 MiB shared memory', 'init process', '65536 open files', 'NET_ADMIN',
    ]);
    expect(describeRuntimeOptions({ gpus: 1 })).toEqual(['1 GPU']);
    expect(describeRuntimeOptions({ gpus: 2 })).toEqual(['2 GPUs']);
    expect(describeRuntimeOptions(null)).toEqual([]);
  });
});

describe('Container options card', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    apiMock.api.environments.list.mockResolvedValue([]);
    apiMock.api.sources.list.mockResolvedValue([]);
    apiMock.api.env.list.mockResolvedValue([]);
  });

  it('an operator sets GPUs, shared memory, init, the open-file limit and a capability', async () => {
    renderTab(serviceWith({ runtimeOptions: null, healthTimeoutSeconds: null }));
    fireEvent.change(await screen.findByLabelText('GPUs'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Shared memory (MiB)'), { target: { value: '2048' } });
    fireEvent.change(screen.getByLabelText('Open files limit'), { target: { value: '65536' } });
    fireEvent.click(screen.getByLabelText(/Run an init process/));
    fireEvent.click(screen.getByLabelText(/IPC_LOCK/));
    fireEvent.click(screen.getByRole('button', { name: 'Save container options' }));
    expect(await lastPatch()).toEqual({ runtimeOptions: { gpus: 'all', shmSizeMb: 2048, init: true, ulimitNofile: 65536, capAdd: ['IPC_LOCK'] } });
    expect(await screen.findByText(/Container options saved/)).toBeInTheDocument();
  }, TIMEOUT);

  it('prefills what is stored; clearing everything sends empty options', async () => {
    renderTab(serviceWith({ runtimeOptions: { gpus: 2, capAdd: ['NET_ADMIN'] }, healthTimeoutSeconds: null }));
    const gpus = await screen.findByLabelText('GPUs');
    expect(gpus).toHaveValue('2');
    expect(screen.getByLabelText(/NET_ADMIN/)).toBeChecked();
    fireEvent.change(gpus, { target: { value: '' } });
    fireEvent.click(screen.getByLabelText(/NET_ADMIN/));
    fireEvent.click(screen.getByRole('button', { name: 'Save container options' }));
    expect(await lastPatch()).toEqual({ runtimeOptions: { gpus: null, shmSizeMb: null, init: false, ulimitNofile: null, capAdd: [] } });
  }, TIMEOUT);

  it("shows the server's refusal", async () => {
    renderTab(serviceWith({ runtimeOptions: null, healthTimeoutSeconds: null }));
    apiMock.api.services.update.mockRejectedValueOnce(new Error('Operator access required: advanced container options'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save container options' }));
    expect(await screen.findByText(/Operator access required/)).toBeInTheDocument();
  }, TIMEOUT);

  it('a member sees what is set, read only', async () => {
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    renderTab(serviceWith({ runtimeOptions: { gpus: 'all', init: true }, healthTimeoutSeconds: null }));
    expect(await screen.findByText('All GPUs · init process')).toBeInTheDocument();
    expect(screen.queryByLabelText('GPUs')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save container options' })).not.toBeInTheDocument();
  }, TIMEOUT);

  it('a member with nothing set reads Docker defaults', async () => {
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    renderTab(serviceWith({ runtimeOptions: null, healthTimeoutSeconds: null }));
    expect(await screen.findByText('Docker defaults.')).toBeInTheDocument();
  }, TIMEOUT);

  it('is absent for a compose service and on a panel that does not report the field', async () => {
    renderTab(serviceWith({ type: 'compose', runtimeOptions: null }));
    await screen.findByText('Service settings');
    expect(screen.queryByText('Container options')).not.toBeInTheDocument();
    cleanup();
    renderTab(serviceWith({}));
    await screen.findByText('Service settings');
    expect(screen.queryByText('Container options')).not.toBeInTheDocument();
  }, TIMEOUT);
});

describe('Healthcheck timeout field', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    apiMock.api.environments.list.mockResolvedValue([]);
    apiMock.api.env.list.mockResolvedValue([]);
  });

  it('sends the typed seconds; blank sends null (the 300 s default)', async () => {
    renderTab(serviceWith({ runtimeOptions: null, healthTimeoutSeconds: 600 }));
    const field = await screen.findByLabelText('Healthcheck timeout (seconds)');
    expect(field).toHaveValue('600');
    fireEvent.change(field, { target: { value: '1200' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).healthTimeoutSeconds).toBe(1200);

    vi.clearAllMocks();
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).healthTimeoutSeconds).toBeNull();
  }, TIMEOUT);

  it('is neither shown nor sent on a panel that does not report it', async () => {
    renderTab(serviceWith({}));
    await screen.findByText('Service settings');
    expect(screen.queryByLabelText('Healthcheck timeout (seconds)')).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).healthTimeoutSeconds).toBeUndefined();
  }, TIMEOUT);
});

describe('Healthcheck mode field (0.16.1)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    apiMock.api.environments.list.mockResolvedValue([]);
    apiMock.api.env.list.mockResolvedValue([]);
  });

  it('switches a docker service to "container running" and back, sending only a change', async () => {
    renderTab(serviceWith({ healthCheck: 'http' }));
    const select = await screen.findByLabelText('Healthcheck');
    expect(select).toHaveValue('http');
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).healthCheck).toBeUndefined();

    vi.clearAllMocks();
    fireEvent.change(select, { target: { value: 'running' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).healthCheck).toBe('running');
  }, TIMEOUT);

  it('is not offered on a panel that does not report it', async () => {
    renderTab(serviceWith({}));
    await screen.findByText('Service settings');
    expect(screen.queryByLabelText('Healthcheck')).not.toBeInTheDocument();
  }, TIMEOUT);

  it('0.16.3: the command mode needs a command, sends it trimmed, and blank clears it', async () => {
    renderTab(serviceWith({ healthCheck: 'http', healthCommand: null }));
    const select = await screen.findByLabelText('Healthcheck');
    expect(screen.queryByLabelText('Healthcheck command')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'command' } });
    const save = screen.getByRole('button', { name: /Save settings/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Healthcheck command'), { target: { value: '  pg_isready -U app ' } });
    expect(save).not.toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    expect(await lastPatch()).toMatchObject({ healthCheck: 'command', healthCommand: 'pg_isready -U app' });

    cleanup();
    vi.clearAllMocks();
    renderTab(serviceWith({ healthCheck: 'command', healthCommand: 'pg_isready' }));
    fireEvent.change(await screen.findByLabelText('Healthcheck'), { target: { value: 'http' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    const patch = await lastPatch();
    expect(patch.healthCheck).toBe('http');
    expect(patch.healthCommand).toBeUndefined();
  }, TIMEOUT);

  it('0.16.3: Docker labels are edited as key=value lines, sent only when changed, and a bad line blocks saving', async () => {
    renderTab(serviceWith({ healthCheck: 'http', dockerLabels: { 'com.example.team': 'payments' } }));
    const field = await screen.findByLabelText('Docker labels');
    expect(field).toHaveValue('com.example.team=payments');
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).dockerLabels).toBeUndefined();

    vi.clearAllMocks();
    fireEvent.change(field, { target: { value: 'traefik.enable=true' } });
    expect(screen.getByText(/Not a label: traefik.enable=true/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save settings/ })).toBeDisabled();
    fireEvent.change(field, { target: { value: '# team\ncom.example.team = billing\nprometheus.io/scrape=true' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).dockerLabels).toEqual({ 'com.example.team': 'billing', 'prometheus.io/scrape': 'true' });

    vi.clearAllMocks();
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: /Save settings/ }).closest('form')!);
    expect((await lastPatch()).dockerLabels).toEqual({});
  }, TIMEOUT);

  it('0.16.3: Docker labels are not offered on a node service without any, nor by an older panel', async () => {
    renderTab(serviceWith({ healthCheck: 'http', dockerLabels: {}, serverId: 4 }));
    await screen.findByLabelText('Healthcheck');
    expect(screen.queryByLabelText('Docker labels')).not.toBeInTheDocument();
    cleanup();
    renderTab(serviceWith({ healthCheck: 'http' }));
    await screen.findByLabelText('Healthcheck');
    expect(screen.queryByLabelText('Docker labels')).not.toBeInTheDocument();
  }, TIMEOUT);

  it('0.16.3: not offered on a node service, nor by a panel that does not report the command', async () => {
    renderTab(serviceWith({ healthCheck: 'http', healthCommand: null, serverId: 4 }));
    const select = await screen.findByLabelText('Healthcheck');
    expect(select.querySelector('option[value="command"]')).toBeNull();
    cleanup();
    renderTab(serviceWith({ healthCheck: 'http' }));
    expect((await screen.findByLabelText('Healthcheck')).querySelector('option[value="command"]')).toBeNull();
  }, TIMEOUT);
});
