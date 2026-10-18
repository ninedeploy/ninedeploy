import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../src/components/Toast.js';
import { ModeProvider } from '../src/lib/mode.js';

/**
 * 0.16.1: the wizard as the /new picker opens it — a preset per source, the
 * build pack asked up front, and the project / environment / domain a new
 * service lands in.
 */

const apiMock = vi.hoisted(() => ({
  api: {
    sources: { list: vi.fn(), repos: vi.fn(), reposWithDiagnostics: vi.fn(), branches: vi.fn() },
    servers: { list: vi.fn() },
    services: { create: vi.fn(), composePreview: vi.fn(), github: { link: vi.fn() } },
    env: { create: vi.fn() },
    deploys: { trigger: vi.fn() },
    domains: { create: vi.fn() },
    projects: { list: vi.fn() },
    environments: { list: vi.fn() },
    insights: { analyze: vi.fn() },
    templates: { prepare: vi.fn() },
    hostIps: { primary: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

import { DeployWizard, type DeployPreset } from '../src/components/DeployWizard.js';

function renderWizard(preset?: DeployPreset) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/new']}>
        <ModeProvider>
          <ToastProvider>
            <DeployWizard preset={preset} onClose={vi.fn()} />
          </ToastProvider>
        </ModeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Continue through the remaining steps to Review, then Deploy. */
async function finish(user: ReturnType<typeof userEvent.setup>) {
  for (let i = 0; i < 4; i++) await user.click(screen.getByRole('button', { name: /continue/i }));
  await user.click(screen.getByRole('button', { name: /^deploy$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
  localStorage.setItem('ninedeploy:experience_mode', 'advanced');
  apiMock.api.sources.list.mockResolvedValue([]);
  apiMock.api.servers.list.mockResolvedValue([]);
  apiMock.api.insights.analyze.mockRejectedValue(new Error('no analysis in this test'));
  apiMock.api.projects.list.mockResolvedValue([{ id: 5, name: 'Shop' }]);
  apiMock.api.environments.list.mockResolvedValue([{ id: 2, name: 'staging' }]);
  apiMock.api.services.create.mockResolvedValue({ id: 42, name: 'app' });
  apiMock.api.deploys.trigger.mockResolvedValue({ deploymentId: 9 });
  apiMock.api.domains.create.mockResolvedValue({ id: 1, hostname: 'app.example.com', status: 'active' });
});

describe('presets', () => {
  it('image: opens on the Image source', () => {
    renderWizard({ type: 'docker', mode: 'image' });
    expect(screen.getByRole('button', { name: 'Image' })).toHaveClass('bg-indigo-500');
    expect(screen.getByPlaceholderText('n8nio/n8n')).toBeInTheDocument();
  });

  it('compose: opens the paste box for an operator, falls back to Docker for a member', () => {
    const { unmount } = renderWizard({ type: 'compose', mode: 'paste' });
    expect(screen.getByLabelText('Compose file')).toBeInTheDocument();
    unmount();
    authMock.user = { id: 2, isOperator: false, email: 'm@test', name: 'M' };
    renderWizard({ type: 'compose', mode: 'paste' });
    expect(screen.queryByLabelText('Compose file')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://github.com/you/repo')).toBeInTheDocument();
  });

  it('github-app: pre-selects the first GitHub App installation', async () => {
    apiMock.api.sources.list.mockResolvedValue([
      { id: 3, name: 'pat', type: 'github' },
      { id: 8, name: 'acme-app', type: 'github_app' },
    ]);
    apiMock.api.sources.reposWithDiagnostics.mockResolvedValue({ repos: [], warning: null });
    renderWizard({ mode: 'repo', source: 'github_app' });
    await waitFor(() => expect(screen.getByText(/acme-app/, { selector: 'span' })).toBeInTheDocument());
  });
});

describe('build pack, project, environment and domain', () => {
  it('sends the Dockerfile build pack with its path', async () => {
    const user = userEvent.setup();
    renderWizard({ type: 'docker', mode: 'repo', buildPack: 'dockerfile' });
    expect(screen.getByLabelText('Build pack')).toHaveValue('dockerfile');
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/acme/app');
    await user.type(screen.getByPlaceholderText(/Dockerfile \(relative/), 'docker/Dockerfile.prod');
    await finish(user);
    await waitFor(() => expect(apiMock.api.services.create).toHaveBeenCalled());
    expect(apiMock.api.services.create.mock.calls[0]![0]).toMatchObject({
      build: { buildPack: 'dockerfile', dockerfilePath: 'docker/Dockerfile.prod' },
    });
  });

  it('sends the static build pack with its output dir; auto sends no build pack', async () => {
    const user = userEvent.setup();
    renderWizard({ type: 'docker', mode: 'repo' });
    expect(screen.getByLabelText('Build pack')).toHaveValue('auto');
    await user.selectOptions(screen.getByLabelText('Build pack'), 'static');
    await user.type(screen.getByPlaceholderText('my-app'), 'site');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/acme/site');
    await user.type(screen.getByPlaceholderText(/dist \(default\)/), 'build');
    await finish(user);
    await waitFor(() => expect(apiMock.api.services.create).toHaveBeenCalled());
    expect(apiMock.api.services.create.mock.calls[0]![0].build).toMatchObject({ buildPack: 'static', outputDir: 'build' });
  });

  it('tags the project and lane, then adds the domain before the first deploy', async () => {
    const user = userEvent.setup();
    renderWizard({ mode: 'repo' });
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/acme/app');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Shop' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Project'), '5');
    await user.selectOptions(screen.getByLabelText('Environment'), '2');
    await user.type(screen.getByLabelText('Custom domain'), 'https://App.Example.com/path');
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('app.example.com')).toBeInTheDocument();
    expect(screen.getByText('Shop')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^deploy$/i }));
    await waitFor(() => expect(apiMock.api.deploys.trigger).toHaveBeenCalledWith(42));
    expect(apiMock.api.services.create.mock.calls[0]![0]).toMatchObject({ tagProjectIds: [5], environmentId: 2 });
    expect(apiMock.api.domains.create).toHaveBeenCalledWith(42, { hostname: 'app.example.com' });
    expect(apiMock.api.domains.create.mock.invocationCallOrder[0]!).toBeLessThan(apiMock.api.deploys.trigger.mock.invocationCallOrder[0]!);
  });

  it("names the primary IP in the DNS hint (AAAA for IPv6), or says 'this server' without one", async () => {
    apiMock.api.hostIps.primary.mockResolvedValue({ ip: '2001:db8::7' });
    const user = userEvent.setup();
    const { unmount } = renderWizard({ mode: 'repo' });
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/acme/app');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('2001:db8::7')).toBeInTheDocument();
    expect(screen.getByText(/Point its DNS AAAA record at/)).toBeInTheDocument();
    unmount();

    apiMock.api.hostIps.primary.mockResolvedValue({ ip: null });
    renderWizard({ mode: 'repo' });
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/acme/app');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/Point its DNS A record at this server/)).toBeInTheDocument();
  });

  it('a refused domain does not stop the deploy', async () => {
    apiMock.api.domains.create.mockRejectedValue(new Error('taken'));
    const user = userEvent.setup();
    renderWizard({ mode: 'repo' });
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/acme/app');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByLabelText('Custom domain'), 'app.example.com');
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /^deploy$/i }));
    await waitFor(() => expect(apiMock.api.deploys.trigger).toHaveBeenCalledWith(42));
    expect(await screen.findByText(/Domain app.example.com skipped: taken/)).toBeInTheDocument();
  });
});
