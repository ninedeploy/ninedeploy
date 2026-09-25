import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../src/components/Toast.js';
import { ModeProvider } from '../src/lib/mode.js';
import { deferred } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    sources: { list: vi.fn(), repos: vi.fn(), branches: vi.fn() },
    servers: { list: vi.fn() },
    services: { create: vi.fn(), composePreview: vi.fn() },
    env: { create: vi.fn() },
    deploys: { trigger: vi.fn() },
    databases: { create: vi.fn(), get: vi.fn() },
    attachments: { create: vi.fn() },
    templates: { prepare: vi.fn(), deploy: vi.fn() },
    insights: { analyze: vi.fn() },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

// H-3: Compose and PM2 run on the host, so the API admits admins only and the
// wizard must not offer them to a member. Role is mutable per test.
const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

import { DeployWizard } from '../src/components/DeployWizard.js';

const TEMPLATE = {
  id: 'n8n',
  name: 'n8n',
  tagline: 'Workflow automation',
  description: 'd',
  category: 'automation',
  emoji: '🤖',
  image: 'n8nio/n8n',
  port: 5678,
  volumeMount: '/home/node/.n8n',
  env: [
    { key: 'N8N_BASIC_AUTH_ACTIVE', value: 'true', secret: true },
    { key: 'N8N_EXTRA', value: 'y' },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderWizard(props: { template?: typeof TEMPLATE & { dockerSocket?: boolean; composeContent?: string }; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = renderTree(
    <DeployWizard template={props.template} onClose={onClose} />,
    queryClient,
  );
  return { ...utils, onClose };
}

function renderTree(ui: React.ReactElement, queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/new']}>
        <ModeProvider>
          <ToastProvider>
            {ui}
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </ToastProvider>
        </ModeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DeployWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    localStorage.setItem('ninedeploy:experience_mode', 'advanced');
    apiMock.api.sources.list.mockResolvedValue([
      { id: 3, name: 'github-app', type: 'github' },
    ]);
    apiMock.api.servers.list.mockResolvedValue([]);
    apiMock.api.services.create.mockResolvedValue({ id: 42, name: 'app' });
    apiMock.api.services.composePreview.mockResolvedValue({
      ok: true, reasons: [], warnings: [], services: ['web'], suggestedService: 'web',
      magicTokens: [], openPlaceholders: [], configurableEnv: [],
    });
    apiMock.api.env.create.mockResolvedValue({ id: 1, key: 'K', value: 'v', isSecret: false });
    apiMock.api.databases.create.mockResolvedValue({ id: 7, name: 'db', engine: 'postgres', status: 'creating' });
    apiMock.api.databases.get.mockResolvedValue({ id: 7, name: 'db', engine: 'postgres', status: 'running' });
    apiMock.api.attachments.create.mockResolvedValue({ id: 9, databaseId: 7, envAlias: 'DATABASE_URL' });
    apiMock.api.deploys.trigger.mockResolvedValue({ deploymentId: 7 });
    apiMock.api.templates.prepare.mockResolvedValue({
      serviceId: 42,
      serviceName: 'app',
      serviceSlug: 'app',
      deploymentId: 6,
      generatedSecrets: [],
      stages: [],
    });
    apiMock.api.templates.deploy.mockResolvedValue({
      serviceId: 42,
      serviceName: 'app',
      serviceSlug: 'app',
      deploymentId: 7,
      databaseId: null,
      generatedSecrets: [],
      stages: [],
      alreadyInProgress: false,
    });
  });

  it('offers Compose and PM2 to an admin', () => {
    renderWizard();
    expect(screen.getByRole('option', { name: 'Compose' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'PM2' })).toBeInTheDocument();
  });

  it('hides Compose and PM2 from a member — the API returns 403 for both', () => {
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    renderWizard();
    expect(screen.queryByRole('option', { name: 'Compose' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'PM2' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Docker / Nixpacks' })).toBeInTheDocument();
  });

  it('blocks a member from deploying a Docker-socket template, with the reason', () => {
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    renderWizard({ template: { ...TEMPLATE, dockerSocket: true } });
    expect(screen.getByText(/mounts the Docker socket/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  it('blocks a member from deploying a Compose-stack template, with its own reason', () => {
    // A compose file can bind-mount host paths or request a privileged
    // container, so the server refuses it to a non-operator exactly like a
    // Docker-socket template — say so up front rather than after five steps.
    authMock.user = { id: 5, isOperator: false, email: 'm@test', name: 'M' };
    renderWizard({ template: { ...TEMPLATE, composeContent: 'services: { app: { image: x } }' } });
    expect(screen.getByText(/installs a Compose stack/)).toBeInTheDocument();
    expect(screen.queryByText(/mounts the Docker socket/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  it('lets an admin deploy the same Docker-socket template', () => {
    renderWizard({ template: { ...TEMPLATE, dockerSocket: true } });
    expect(screen.queryByText(/mounts the Docker socket/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled();
  });

  it('renders the repo flow by default with a "New service" title', async () => {
    renderWizard();
    expect(screen.getByText('New service')).toBeInTheDocument();
    expect(screen.getByText('Git repo')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://github.com/you/repo')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/github-app/)).toBeInTheDocument());
  });

  it('renders the image flow when a template is provided', () => {
    renderWizard({ template: TEMPLATE });
    expect(screen.getByText('Deploy n8n')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('n8nio/n8n')).toHaveValue('n8nio/n8n');
  });

  it('requires name and repo URL before continuing (repo mode)', async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByPlaceholderText('my-app'), 'my-app');
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('requires an image in image mode', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.click(screen.getByText('Image'));
    expect(screen.getByPlaceholderText('n8nio/n8n')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByPlaceholderText('n8nio/n8n'), 'myimg');
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('walks through every step and deploys', async () => {
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Runtime
    await user.clear(screen.getByPlaceholderText('3000'));
    await user.type(screen.getByPlaceholderText('3000'), '8080');
    await user.type(screen.getByPlaceholderText('/app/data'), '/data');
    await user.clear(screen.getByPlaceholderText('/'));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Environment
    expect(screen.getByText('No environment variables.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add variable/i }));
    await user.type(screen.getAllByPlaceholderText('KEY')[0]!, 'FOO');
    await user.type(screen.getAllByPlaceholderText('value')[0]!, 'bar');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Resources
    await user.type(screen.getByPlaceholderText('512'), '512');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Review
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('app')).toBeInTheDocument();
    expect(screen.getByText(':8080')).toBeInTheDocument();
    expect(screen.getByText('/data')).toBeInTheDocument();
    expect(screen.getByText('512 shares · — MB')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() =>
      expect(apiMock.api.services.create).toHaveBeenCalledWith({
        name: 'app',
        type: 'docker',
        repoUrl: 'https://github.com/x/y',
        image: undefined,
        branch: 'main',
        sourceId: undefined,
        port: 8080,
        volumeMount: '/data',
        healthPath: undefined,
        cpuShares: 512,
        memLimitMb: undefined,
      }),
    );
    await waitFor(() =>
      expect(apiMock.api.env.create).toHaveBeenCalledWith(42, {
        key: 'FOO',
        value: 'bar',
        isSecret: false,
      }),
    );
    await waitFor(() => expect(apiMock.api.deploys.trigger).toHaveBeenCalledWith(42));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/services/42'));
    expect(screen.getByText('Deploy started — building…')).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the default limits label when no limits are set', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('shows an em dash for unset CPU shares when only a memory limit is given', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('256'), '256');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('— shares · 256 MB')).toBeInTheDocument();
  });

  it('skips env rows with empty keys during deploy', async () => {
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /add variable/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(apiMock.api.env.create).not.toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('deploys from a template with prefilled env and image mode', async () => {
    const { onClose } = renderWizard({ template: TEMPLATE });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Step 2 (env): template row is prefilled
    expect(screen.getAllByDisplayValue('N8N_BASIC_AUTH_ACTIVE')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('n8n')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(apiMock.api.templates.prepare).toHaveBeenCalledWith('n8n', expect.objectContaining({ name: 'n8n', reuseExisting: true })));
    expect(apiMock.api.templates.deploy).not.toHaveBeenCalled();
    expect(apiMock.api.services.create).not.toHaveBeenCalled();
    // An untouched registry secret is omitted so the server can generate it
    // once and preserve it across interrupted-install retries.
    await waitFor(() => {
      const input = apiMock.api.templates.prepare.mock.calls[0]?.[1];
      const rows = Object.fromEntries(input.env.map((row: { key: string }) => [row.key, row]));
      expect(rows['N8N_EXTRA']!).toEqual(expect.objectContaining({ key: 'N8N_EXTRA', value: 'y', isSecret: false }));
      expect(rows['N8N_BASIC_AUTH_ACTIVE']).toBeUndefined();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('delegates the complete required-database pipeline to the durable prepare route', async () => {
    const tpl = { ...TEMPLATE, dbEngine: 'postgres' as const, requires: 'Umami needs a PostgreSQL database — one is provisioned automatically' };
    const { onClose } = renderWizard({ template: tpl });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // The required database cannot be disabled in the Hub wizard.
    expect(screen.getByText(tpl.requires)).toBeInTheDocument();
    expect(screen.getByText('Required managed postgres database')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));

    await waitFor(() => expect(apiMock.api.templates.prepare).toHaveBeenCalledWith('n8n', expect.objectContaining({ reuseExisting: true })));
    expect(apiMock.api.templates.deploy).not.toHaveBeenCalled();
    expect(apiMock.api.databases.create).not.toHaveBeenCalled();
    expect(apiMock.api.databases.get).not.toHaveBeenCalled();
    expect(apiMock.api.attachments.create).not.toHaveBeenCalled();
    expect(apiMock.api.deploys.trigger).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('closes and navigates after the durable worker job is queued', async () => {
    const tpl = { ...TEMPLATE, dbEngine: 'postgres' as const };
    const { onClose } = renderWizard({ template: tpl });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/services/42?tab=deploys'));
    expect(apiMock.api.templates.prepare).toHaveBeenCalledOnce();
    expect(apiMock.api.templates.deploy).not.toHaveBeenCalled();
  });

  it('keeps the wizard open when durable queue creation fails', async () => {
    const toastMod = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
    void toastMod;
    const tpl = { ...TEMPLATE, dbEngine: 'postgres' as const };
    apiMock.api.templates.prepare.mockRejectedValue(new Error('Could not queue template deployment'));
    const { onClose } = renderWizard({ template: tpl });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(screen.getByText('Could not queue template deployment')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).not.toHaveTextContent('/services/42?tab=deploys');
    expect(apiMock.api.deploys.trigger).not.toHaveBeenCalled();
  });

  it('toggles env row secret mode and removes rows', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /add variable/i }));
    const sec = screen.getByTitle('Toggle secret');
    await user.click(sec);
    expect(sec.className).toContain('bg-amber-500/20');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.queryByText('No environment variables.')).not.toBeInTheDocument();
    const back = screen.getByRole('button', { name: /back/i });
    await user.click(back);
    const removeBtn = screen.getByTitle('Remove');
    await user.click(removeBtn);
    expect(screen.getByText('No environment variables.')).toBeInTheDocument();
  });

  it('shows Deploying… and disables submit while pending', async () => {
    const d = deferred();
    apiMock.api.services.create.mockReturnValue(d.promise);
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole('button', { name: /continue/i }));
    }
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    expect(screen.getByText('Deploying…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deploying/i })).toBeDisabled();
    d.resolve({ id: 42 });
  });

  it('shows a failure message and toasts on deploy error', async () => {
    apiMock.api.services.create.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole('button', { name: /continue/i }));
    }
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(screen.getByText('Failed — try again')).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('r208: a retry after a failed trigger resumes instead of re-creating the service', async () => {
    apiMock.api.services.create.mockResolvedValue({ id: 9 } as never);
    apiMock.api.deploys.trigger.mockRejectedValueOnce(new Error('queue down')).mockResolvedValueOnce({ deploymentId: 4 } as never);
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole('button', { name: /continue/i }));
    }
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(screen.getByText('Failed — try again')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /try again|deploy/i }));
    await waitFor(() => expect(apiMock.api.deploys.trigger).toHaveBeenCalledTimes(2));
    expect(apiMock.api.services.create).toHaveBeenCalledTimes(1);
    expect(apiMock.api.deploys.trigger).toHaveBeenLastCalledWith(9);
  });

  it('toasts a generic message when the error is not an Error', async () => {
    apiMock.api.services.create.mockRejectedValue('nope');
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole('button', { name: /continue/i }));
    }
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(screen.getByText('Deploy failed')).toBeInTheDocument());
  });

  it('closes on Escape and locks body scroll while open', async () => {
    const { onClose, unmount } = renderWizard();
    await waitFor(() => expect(screen.getByPlaceholderText('my-app')).toBeInTheDocument());
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    // Scroll lock is released when the dialog unmounts.
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('auto-focuses the name input when opened', async () => {
    renderWizard();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText('my-app')));
  });

  it('hides the back button on the first step and closes via X', async () => {
    const user = userEvent.setup();
    const { container, onClose } = renderWizard();
    const back = screen.getByRole('button', { name: /back/i });
    expect(back.className).toContain('invisible');
    const closeBtn = container.querySelector('h2 + button') as HTMLButtonElement;
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();
    await user.click(screen.getByText('New service').closest('.fixed')!.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('selects a private source in repo mode', async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(screen.getByText(/github-app/)).toBeInTheDocument());
    await user.selectOptions(screen.getAllByRole('combobox')[1]!, '3');
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() =>
      expect(apiMock.api.services.create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 3 }),
      ),
    );
  });

  it('supports the pm2 type, custom branch, health path and memory limit', async () => {
    const user = userEvent.setup();
    renderWizard();
    // Type pm2 via the <Select> onChange handler.
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'pm2');
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    // The branch input lives in the Source step (step 0); edit it before continuing.
    const branchInput = screen.getByPlaceholderText('main');
    await user.clear(branchInput);
    await user.type(branchInput, 'develop');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Runtime step: health path input is rendered with placeholder "/".
    const healthInput = screen.getByPlaceholderText('/') as HTMLInputElement;
    expect(healthInput).toBeInTheDocument();
    await user.type(healthInput, '/healthz');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Resources step: fill the cpuShares (placeholder "512") and memory
    // limit (placeholder "256") so the Limits row uses the conditional
    // branch (not 'none').
    await user.type(screen.getByPlaceholderText('512'), '256');
    await user.type(screen.getByPlaceholderText('256'), '512');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Review row: pm2 type appears. The Limits row value is the
    // `${cpuShares || '—'} shares · ${memLimitMb || '—'} MB` template.
    expect(screen.getAllByText('pm2').length).toBeGreaterThan(0);
    const limitsRow = Array.from(document.querySelectorAll('span.font-medium.text-slate-200')).find(
      (el) => /shares.*MB/.test(el.textContent ?? ''),
    ) as HTMLElement | undefined;
    expect(limitsRow).not.toBeUndefined();
    expect(limitsRow?.textContent).toContain('shares');
    expect(limitsRow?.textContent).toContain('MB');
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() =>
      expect(apiMock.api.services.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pm2',
          branch: 'develop',
          healthPath: '//healthz',
          cpuShares: 256,
          memLimitMb: 512,
        }),
      ),
    );
  });

  it('supports direct host port input and displays Host Port in review', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.type(screen.getByPlaceholderText('my-app'), 'port-app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/port-app');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Runtime step: fill container port and direct host port
    await user.clear(screen.getByPlaceholderText('3000'));
    await user.type(screen.getByPlaceholderText('3000'), '3000');
    await user.type(screen.getByPlaceholderText('e.g. 8080'), '8080');
    await user.click(screen.getByRole('button', { name: /continue/i })); // Env
    await user.click(screen.getByRole('button', { name: /continue/i })); // Resources
    await user.click(screen.getByRole('button', { name: /continue/i })); // Review

    expect(screen.getByText(':8080')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() =>
      expect(apiMock.api.services.create).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 3000,
          publishedPort: 8080,
        }),
      ),
    );
  });
});

describe('DeployWizard — repository analysis & Git credential guidance', () => {
  const analysis = {
    framework: {
      id: 'next',
      name: 'Next.js',
      emoji: '▲',
      category: 'ssr',
      port: 3000,
      installCmd: 'pnpm install',
      buildCmd: 'pnpm build',
      startCmd: 'pnpm start',
      env: [
        { key: 'NODE_ENV', value: 'production' },
        { key: 'PORT', value: '3000' },
      ],
      notes: [],
    },
    language: 'TypeScript',
    packageManager: 'pnpm',
    nodeVersion: '22',
    frameworkVersion: '15.1.0',
    scripts: {},
    dependencyCount: 40,
    devDependencyCount: 9,
    hasDockerfile: true,
    hasComposeFile: false,
    monorepo: true,
    detectedFiles: ['package.json'],
    workspacePackages: [{ dir: 'apps/web', name: 'web', framework: 'Next.js', frameworkVersion: '15.1.0' }],
    baseDir: '/',
    commitSha: null,
    analyzedAt: '2026-01-02T03:04:05Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    localStorage.setItem('ninedeploy:experience_mode', 'advanced');
    apiMock.api.sources.list.mockResolvedValue([{ id: 3, name: 'github-app', type: 'github' }]);
    apiMock.api.sources.repos.mockResolvedValue([]);
    apiMock.api.servers.list.mockResolvedValue([]);
    apiMock.api.services.create.mockResolvedValue({ id: 42, name: 'app' });
    apiMock.api.services.composePreview.mockResolvedValue({
      ok: true, reasons: [], warnings: [], services: ['web'], suggestedService: 'web',
      magicTokens: [], openPlaceholders: [], configurableEnv: [],
    });
    apiMock.api.env.create.mockResolvedValue({ id: 1, key: 'K', value: 'v', isSecret: false });
    apiMock.api.deploys.trigger.mockResolvedValue({ deploymentId: 7 });
  });

  /** Fill step 0 in repo mode: name + repository URL (single change events). */
  async function fillRepo(user: ReturnType<typeof userEvent.setup>, repoUrl = 'https://github.com/x/y') {
    const name = screen.getByPlaceholderText('my-app');
    await user.clear(name);
    await user.type(name, 'app');
    const repo = screen.getByPlaceholderText('https://github.com/you/repo');
    await user.clear(repo);
    await user.type(repo, repoUrl);
  }

  it('explains the Git credential situation before deploying', async () => {
    const user = userEvent.setup();
    renderWizard();

    // No repo URL yet: generic hint pointing at System → Sources.
    expect(screen.getByText(/Select a Git credential first/)).toBeInTheDocument();
    expect(screen.getByText(/System → Sources/)).toBeInTheDocument();

    // Repo URL without a credential: warn that private repos will fail.
    await fillRepo(user);
    expect(await screen.findByText(/No Git credential selected/)).toBeInTheDocument();

    // Credential selected: the source's repositories become a dropdown whose
    // choice fills the URL, name and default branch automatically.
    apiMock.api.sources.repos.mockResolvedValue([
      { name: 'y', fullName: 'x/y', url: 'https://github.com/x/y', defaultBranch: 'dev', isPrivate: true },
    ]);
    apiMock.api.sources.branches.mockResolvedValue(['main', 'dev']);
    const sourceSelect = screen.getAllByRole('combobox')[1]!;
    await user.selectOptions(sourceSelect, '3');
    expect(await screen.findByText(/run with credential/)).toBeInTheDocument();
    expect(screen.getByText('github-app')).toBeInTheDocument();
    expect(screen.getByText(/this repository is/)).toBeInTheDocument();

    // Pick the repo from the credential's list…
    const repoDropdown = (await screen.findByRole('option', { name: /Choose a repo/ })).closest('select')!;
    await user.selectOptions(repoDropdown, 'https://github.com/x/y');
    // …the URL fills in and the empty name adopts the repo name.
    await waitFor(() =>
      expect((screen.getByPlaceholderText('https://github.com/you/repo') as HTMLInputElement).value)
        .toBe('https://github.com/x/y'));

    // The repo's default branch is preselected; switching retargets analysis.
    const branchSelect = await screen.findByDisplayValue('dev');
    await user.selectOptions(branchSelect, 'main');
  });

  it('auto-analyzes the repository and renders the deploy plan', async () => {
    const user = userEvent.setup();
    apiMock.api.insights.analyze.mockResolvedValue(analysis);
    renderWizard();

    expect(screen.getByText(/Framework detection runs automatically/)).toBeInTheDocument();
    await fillRepo(user);

    // Debounced: fires ~900ms after the URL settles.
    await waitFor(() => expect(apiMock.api.insights.analyze).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/x/y',
      branch: 'main',
    }), { timeout: 4000 });

    expect(await screen.findByText('Next.js', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('15.1.0')).toBeInTheDocument();
    expect(screen.getByText('ssr')).toBeInTheDocument();
    expect(screen.getByText('pnpm')).toBeInTheDocument();
    expect(screen.getByText('Node 22')).toBeInTheDocument();
    expect(screen.getByText('Dockerfile')).toBeInTheDocument();
    expect(screen.getByText('monorepo')).toBeInTheDocument();
    expect(screen.getByText('Deploy pipeline for this repository')).toBeInTheDocument();
    expect(screen.getByText(/49 packages/)).toBeInTheDocument();
    expect(screen.getByText('Suggested env:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-analyze/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply suggestions/ })).toBeInTheDocument();
    // Monorepo picker is powered by the root analysis.
    expect(screen.getByText(/Monorepo packages — deploy each as its own service/)).toBeInTheDocument();
    expect(screen.getByText('/ (repo root)')).toBeInTheDocument();
  });

  it('degrades to a hint when the analysis fails', async () => {
    const user = userEvent.setup();
    apiMock.api.insights.analyze.mockRejectedValue(new Error('needs credentials') as never);
    renderWizard();

    await fillRepo(user);
    expect(await screen.findByText('needs credentials', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/Private repositories need a Git credential/)).toBeInTheDocument();
  });

  it('applies framework suggestions to the form', async () => {
    const user = userEvent.setup();
    apiMock.api.insights.analyze.mockResolvedValue(analysis);
    renderWizard();

    await fillRepo(user);
    await screen.findByText('Next.js', {}, { timeout: 4000 });

    await user.click(screen.getByRole('button', { name: /Apply suggestions/ }));
    expect(await screen.findByText('Suggestions applied')).toBeInTheDocument();

    // Port is prefilled from the preset on the runtime step.
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect((screen.getByPlaceholderText('3000') as HTMLInputElement).value).toBe('3000');

    // Suggested env rows appear on the environment step.
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByDisplayValue('NODE_ENV')).toBeInTheDocument();
    expect(screen.getByDisplayValue('PORT')).toBeInTheDocument();
  });

  it('quick deploy merges the detected preset into the request', async () => {
    const user = userEvent.setup();
    localStorage.setItem('ninedeploy:experience_mode', 'simple');
    apiMock.api.insights.analyze.mockResolvedValue(analysis);
    renderWizard();

    await fillRepo(user);
    await screen.findByText('Next.js', {}, { timeout: 4000 });

    await user.click(screen.getByRole('button', { name: 'Quick Deploy' }));
    await waitFor(() =>
      expect(apiMock.api.services.create).toHaveBeenCalledWith(expect.objectContaining({
        port: 3000,
        build: { installCmd: 'pnpm install', buildCmd: 'pnpm build', startCmd: 'pnpm start' },
      })));
    // The suggested env vars are created and the deployment is triggered.
    await waitFor(() => expect(apiMock.api.env.create).toHaveBeenCalledTimes(2));
    expect(apiMock.api.env.create).toHaveBeenCalledWith(42, { key: 'NODE_ENV', value: 'production', isSecret: false });
    await waitFor(() => expect(apiMock.api.deploys.trigger).toHaveBeenCalledWith(42));
  });

  it('cannot target a remote server node — deploying to one is not implemented', async () => {
    // Every builder shells out locally, so a service pinned to a node would
    // deploy on THIS host while the panel claimed otherwise. The API refuses
    // such a deployment, and the wizard must not create one to begin with.
    const user = userEvent.setup();
    apiMock.api.servers.list.mockResolvedValue([
      { id: 2, name: 'node-a', host: '10.0.0.2', port: 2375, status: 'online' },
    ]);
    renderWizard();

    await fillRepo(user);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText(/not implemented yet/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /node-a/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));

    await waitFor(() => expect(apiMock.api.services.create).toHaveBeenCalled());
    expect(apiMock.api.services.create.mock.calls[0]![0]).not.toHaveProperty('serverId');
  });

  it('scopes a monorepo sub-app via the package picker and re-analyzes', async () => {    const user = userEvent.setup();
    apiMock.api.insights.analyze.mockResolvedValue(analysis);
    renderWizard();

    await fillRepo(user);
    await screen.findByText('Next.js', {}, { timeout: 4000 });

    // Pick the sub-app; the analysis re-runs scoped to that base directory.
    await user.click(screen.getByRole('button', { name: /apps\/web/ }));
    await waitFor(() =>
      expect(apiMock.api.insights.analyze).toHaveBeenCalledWith({
        repoUrl: 'https://github.com/x/y',
        branch: 'main',
        baseDir: '/apps/web',
      }), { timeout: 4000 });

    expect(await screen.findByText(/This service builds/)).toBeInTheDocument();
    expect(screen.getByText('/apps/web/**')).toBeInTheDocument();

    // The root pill resets the scope; the base-directory input overrides it manually.
    await user.click(screen.getByRole('button', { name: '/ (repo root)' }));
    await waitFor(() => expect(screen.queryByText(/This service builds/)).not.toBeInTheDocument());
    const baseDirInput = screen.getByPlaceholderText('/ — repo root, or /apps/web for a monorepo sub-app');
    await user.clear(baseDirInput);
    await user.type(baseDirInput, '/apps/worker');

    // Deploying sends the manually-typed base directory in the build config.
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() =>
      expect(apiMock.api.services.create).toHaveBeenCalledWith(expect.objectContaining({
        build: expect.objectContaining({ baseDir: '/apps/worker' }),
      })));
  });
});

describe('DeployWizard — advanced review and repository-picker variants', () => {
  // The minimal-analysis preset: no build commands, no env, five detected
  // files and a framework version — exercises every optional branch of the
  // review step and apply-suggestions.
  const bareAnalysis = {
    framework: {
      id: 'node',
      name: 'Node.js',
      emoji: '⬢',
      category: 'runtime',
      port: 4000,
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      env: [],
      notes: [],
    },
    language: 'JavaScript',
    packageManager: null,
    nodeVersion: null,
    frameworkVersion: '22.1.0',
    scripts: {},
    dependencyCount: 3,
    devDependencyCount: 1,
    hasDockerfile: false,
    hasComposeFile: false,
    monorepo: false,
    detectedFiles: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'],
    workspacePackages: [],
    baseDir: '/',
    commitSha: null,
    analyzedAt: '2026-01-02T03:04:05Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    // The REAL storage key (mode.tsx) — renders the wizard in advanced mode.
    localStorage.setItem('ninedeploy_experience_mode', 'advanced');
    apiMock.api.sources.list.mockResolvedValue([{ id: 3, name: 'github-app', type: 'github' }]);
    apiMock.api.sources.repos.mockResolvedValue([]);
    apiMock.api.servers.list.mockResolvedValue([]);
    apiMock.api.services.create.mockResolvedValue({ id: 42, name: 'app' });
    apiMock.api.services.composePreview.mockResolvedValue({
      ok: true, reasons: [], warnings: [], services: ['web'], suggestedService: 'web',
      magicTokens: [], openPlaceholders: [], configurableEnv: [],
    });
    apiMock.api.env.create.mockResolvedValue({ id: 1, key: 'K', value: 'v', isSecret: false });
    apiMock.api.deploys.trigger.mockResolvedValue({ deploymentId: 7 });
  });

  afterEach(() => {
    localStorage.removeItem('ninedeploy_experience_mode');
  });

  async function fillRepo(user: ReturnType<typeof userEvent.setup>, repoUrl = 'https://github.com/x/y') {
    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), repoUrl);
  }

  it('renders the DevOps Pro badge and a complete review for a bare analysis', async () => {
    const user = userEvent.setup();
    apiMock.api.insights.analyze.mockResolvedValue(bareAnalysis);
    renderWizard();

    expect(screen.getByText('DevOps Pro')).toBeInTheDocument();
    await fillRepo(user);
    expect(await screen.findByText('Node.js', {}, { timeout: 4000 })).toBeInTheDocument();
    // A start command is missing — the plan shows the em-dash placeholder.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // Five detected files: the first four are listed, the rest elided.
    expect(screen.getByText(/a\.txt, b\.txt, c\.txt, d\.txt…/)).toBeInTheDocument();
    // No suggested env vars at all — the block is absent.
    expect(screen.queryByText('Suggested env:')).not.toBeInTheDocument();

    // Applying a preset without commands only takes the port.
    await user.click(screen.getByRole('button', { name: /Apply suggestions/ }));
    expect(await screen.findByText('Suggestions applied')).toBeInTheDocument();

    // Walk to review with host port, volume, health path and both limits.
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('/app/data'), '/data');
    await user.clear(screen.getByPlaceholderText('/'));
    await user.type(screen.getByPlaceholderText('/'), '/health');
    await user.type(screen.getByPlaceholderText('e.g. 8080'), '8080');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('512'), '512');
    await user.type(screen.getByPlaceholderText('256'), '256');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Review rows: detected framework (version, no package manager), host
    // port, volume and both limits. No build-commands row (none set).
    expect(screen.getByText('⬢ Node.js 22.1.0')).toBeInTheDocument();
    expect(screen.getByText(':4000')).toBeInTheDocument();
    expect(screen.getByText(':8080')).toBeInTheDocument();
    expect(screen.getByText('/data')).toBeInTheDocument();
    expect(screen.getByText('512 shares · 256 MB')).toBeInTheDocument();
  });

  it('hints at a typed base directory when a monorepo exposes no packages', async () => {
    const user = userEvent.setup();
    apiMock.api.insights.analyze.mockResolvedValue({
      ...bareAnalysis,
      monorepo: true,
      workspacePackages: [{ dir: 'apps/web', name: null, framework: null }],
    });
    const first = renderWizard();

    await fillRepo(user);
    expect(await screen.findByText(/Monorepo packages/, {}, { timeout: 4000 })).toBeInTheDocument();
    // A nameless package falls back to its directory; clicking it scopes the build.
    await user.click(screen.getByRole('button', { name: /apps\/web/ }));
    expect(await screen.findByText(/This service builds/, {}, { timeout: 4000 })).toBeInTheDocument();
    first.unmount();

    // A root analysis that finds no workspace packages shows the manual hint.
    apiMock.api.insights.analyze.mockResolvedValue({
      ...bareAnalysis,
      monorepo: true,
      // The field is entirely absent — the picker falls back to an empty list.
      workspacePackages: undefined,
    });
    renderWizard();
    await fillRepo(user);
    expect(await screen.findByText(
      /workspace config found — type a base directory below/,
      {},
      { timeout: 4000 },
    )).toBeInTheDocument();
  }, 15000);

  it('lists whichever build commands the applied preset carried', async () => {
    const user = userEvent.setup();
    /** Walk from step 0 straight to the review after applying a preset. */
    const walkToReview = async () => {
      await fillRepo(user);
      await screen.findByText('Node.js', {}, { timeout: 4000 });
      await user.click(screen.getByRole('button', { name: /Apply suggestions/ }));
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));
    };

    const withCmds = (cmd: Partial<{ installCmd: string; buildCmd: string; startCmd: string }>) => ({
      ...bareAnalysis,
      framework: {
        ...bareAnalysis.framework,
        installCmd: null,
        buildCmd: null,
        startCmd: null,
        ...cmd,
      },
    });

    // Install only.
    apiMock.api.insights.analyze.mockResolvedValue(withCmds({ installCmd: 'npm i' }));
    let view = renderWizard();
    await walkToReview();
    expect(screen.getByText('Build commands')).toBeInTheDocument();
    expect(screen.getByText('npm i')).toBeInTheDocument();
    view.unmount();

    // Build only.
    apiMock.api.insights.analyze.mockResolvedValue(withCmds({ buildCmd: 'vite build' }));
    view = renderWizard();
    await walkToReview();
    expect(screen.getByText('vite build')).toBeInTheDocument();
    view.unmount();

    // Start only.
    apiMock.api.insights.analyze.mockResolvedValue(withCmds({ startCmd: 'node server.js' }));
    view = renderWizard();
    await walkToReview();
    expect(screen.getByText('node server.js')).toBeInTheDocument();
  }, 30000);

  it('offers branch dropdowns and manual branch entry in every repo-list state', async () => {
    const user = userEvent.setup();
    // State 1: no credential repos, but the credential knows branches → a
    // plain branch Select appears next to the credential picker.
    apiMock.api.sources.branches.mockResolvedValue(['main', 'dev']);
    const first = renderWizard();

    await fillRepo(user);
    const sourceSelect = screen.getAllByRole('combobox')[1]!;
    await user.selectOptions(sourceSelect, '3');
    const branchSelect = await screen.findByDisplayValue('main');
    await user.selectOptions(branchSelect, 'dev');
    first.unmount();

    // State 2: credential repos listed and NO branches → repo dropdown fills
    // URL/branch, and branch entry degrades to a plain input.
    apiMock.api.sources.repos.mockResolvedValue([
      { name: 'y', fullName: 'x/y', url: 'https://github.com/x/y', defaultBranch: 'trunk', isPrivate: false },
    ]);
    apiMock.api.sources.branches.mockResolvedValue([]);
    renderWizard();

    await fillRepo(user);
    const source = screen.getAllByRole('combobox')[1]!;
    await user.selectOptions(source, '3');
    const repoDropdown = (await screen.findByRole('option', { name: /Choose a repo/ })).closest('select')!;
    await user.selectOptions(repoDropdown, 'https://github.com/x/y');
    // The name is already filled, so the repo pick only retargets branch+URL.
    expect((screen.getByPlaceholderText('https://github.com/you/repo') as HTMLInputElement).value)
      .toBe('https://github.com/x/y');
    expect(await screen.findByDisplayValue('trunk')).toBeInTheDocument();
    const manualBranch = screen.getByPlaceholderText('main');
    await user.clear(manualBranch);
    await user.type(manualBranch, 'feature/x');
  });

  it('tells a member to ask an admin when no credential is available', async () => {
    const user = userEvent.setup();
    authMock.user = { id: 2, isOperator: false, email: 'm@test', name: 'M' };
    renderWizard();

    await fillRepo(user);
    expect(await screen.findByText(/No Git credential selected/)).toBeInTheDocument();
    expect(screen.getByText(/\(ask an administrator if none is listed\)/)).toBeInTheDocument();
  });

  it('re-runs the analysis on demand and degrades non-Error failures', async () => {
    const user = userEvent.setup();
    apiMock.api.insights.analyze
      .mockResolvedValueOnce(bareAnalysis)
      .mockRejectedValueOnce('boom' as never);
    renderWizard();

    await fillRepo(user);
    expect(await screen.findByText('Node.js', {}, { timeout: 4000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Re-analyze' }));
    expect(await screen.findByText('Could not analyze the repository', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('discards an in-flight analysis of the previous URL once the URL changes (r298)', async () => {
    const user = userEvent.setup();
    const first = deferred<typeof bareAnalysis>();
    const oldRepo = { ...bareAnalysis, framework: { ...bareAnalysis.framework, id: 'django', name: 'Django', port: 8000 } };
    apiMock.api.insights.analyze.mockReturnValueOnce(first.promise).mockResolvedValue(bareAnalysis);
    renderWizard();

    await fillRepo(user, 'https://github.com/x/old');
    await waitFor(() => expect(apiMock.api.insights.analyze).toHaveBeenCalledTimes(1), { timeout: 4000 });
    // The user moves on to another repository while the old clone runs…
    fireEvent.change(screen.getByPlaceholderText('https://github.com/you/repo'), {
      target: { value: 'https://github.com/x/new' },
    });
    // …and the old repository's result lands inside the new URL's debounce.
    await act(async () => first.resolve(oldRepo));
    expect(screen.queryByText('Django')).not.toBeInTheDocument();
    // The new URL's own analysis still arrives.
    expect(await screen.findByText('Node.js', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(apiMock.api.insights.analyze).toHaveBeenLastCalledWith({ repoUrl: 'https://github.com/x/new', branch: 'main' });
    expect(screen.queryByText('Django')).not.toBeInTheDocument();
  });

  it('skips re-analysis when only the credential changed', async () => {
    const user = userEvent.setup();
    apiMock.api.insights.analyze.mockResolvedValue(bareAnalysis);
    renderWizard();

    await fillRepo(user);
    expect(await screen.findByText('Node.js', {}, { timeout: 4000 })).toBeInTheDocument();
    const calls = apiMock.api.insights.analyze.mock.calls.length;
    // Changing the source re-runs the effect, but repo/branch/baseDir (the
    // analysis key) are unchanged — no second request fires.
    const sourceSelect = screen.getAllByRole('combobox')[1]!;
    await user.selectOptions(sourceSelect, '3');
    await new Promise((r) => setTimeout(r, 1200));
    expect(apiMock.api.insights.analyze.mock.calls.length).toBe(calls);
  });

  it('handles repo picks with no name, no default branch and a cleared selection', async () => {
    const user = userEvent.setup();
    apiMock.api.sources.repos.mockResolvedValue([
      { name: 'noname', fullName: 'x/noname', url: 'https://github.com/x/noname', defaultBranch: null, isPrivate: false },
    ]);
    apiMock.api.sources.branches.mockResolvedValue([]);
    renderWizard();

    // Leave the name empty: picking the repo adopts its name.
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    const sourceSelect = screen.getAllByRole('combobox')[1]!;
    await user.selectOptions(sourceSelect, '3');
    const repoDropdown = (await screen.findByRole('option', { name: /Choose a repo/ })).closest('select')!;
    await user.selectOptions(repoDropdown, 'https://github.com/x/noname');
    // No defaultBranch in the listing → the branch falls back to main.
    expect(await screen.findByDisplayValue('main')).toBeInTheDocument();
    expect((screen.getByPlaceholderText('my-app') as HTMLInputElement).value).toBe('noname');
    // Clearing the selection clears the URL with it.
    await user.selectOptions(repoDropdown, '');
    expect((screen.getByPlaceholderText('https://github.com/you/repo') as HTMLInputElement).value).toBe('');
  });

  it('edits the second env row without touching the first', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.type(screen.getByPlaceholderText('my-app'), 'app');
    await user.type(screen.getByPlaceholderText('https://github.com/you/repo'), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /add variable/i }));
    await user.click(screen.getByRole('button', { name: /add variable/i }));
    await user.type(screen.getAllByPlaceholderText('KEY')[0]!, 'FIRST');
    await user.type(screen.getAllByPlaceholderText('KEY')[1]!, 'SECOND');
    expect((screen.getAllByPlaceholderText('KEY')[0]! as HTMLInputElement).value).toBe('FIRST');
  });

  it('deploys a template without a health path, and never pins it to a node', async () => {
    const user = userEvent.setup();
    apiMock.api.servers.list.mockResolvedValue([
      { id: 2, name: 'node-a', host: '10.0.0.2', port: 2375, status: 'online' },
    ]);
    renderWizard({ template: TEMPLATE });

    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Drop the prefilled health path so the create request omits it.
    await user.clear(screen.getByPlaceholderText('/'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() =>
      expect(apiMock.api.templates.prepare).toHaveBeenCalledWith('n8n', expect.objectContaining({
        healthPath: undefined,
      })));
    expect(apiMock.api.templates.prepare.mock.calls[0]![1]).not.toHaveProperty('serverId');
  });

  /**
   * Inline compose stacks: Type = Compose swaps the Image source for "Paste
   * YAML". The wizard refuses to move on until the SERVER has said the file
   * can run, because the create route re-runs exactly the same analysis.
   */
  describe('paste a compose stack', () => {
    const STACK = 'services:\n  web:\n    image: nginx:alpine\n';

    const okPreview = {
      ok: true,
      reasons: [],
      warnings: [],
      services: ['web', 'db'],
      suggestedService: 'web',
      magicTokens: ['SERVICE_PASSWORD_32'],
      openPlaceholders: [],
      configurableEnv: [{ key: 'TZ', value: 'UTC' }],
    };

    const pasteStack = async (user: ReturnType<typeof userEvent.setup>, yaml = STACK) => {
      // The Type select is the first combobox on the Source step.
      await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'compose');
      await user.click(screen.getByRole('button', { name: 'Paste YAML' }));
      fireEvent.change(screen.getByLabelText('Compose file'), { target: { value: yaml } });
    };

    it('offers Paste YAML only for a compose deploy', async () => {
      renderWizard();
      const user = userEvent.setup();
      expect(screen.queryByRole('button', { name: 'Paste YAML' })).not.toBeInTheDocument();

      await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'compose');
      expect(screen.getByRole('button', { name: 'Paste YAML' })).toBeInTheDocument();
      // Image mode has no meaning for a stack — the file names the images.
      expect(screen.queryByRole('button', { name: 'Image' })).not.toBeInTheDocument();
    });

    it('blocks Continue until the server says the stack can run', async () => {
      apiMock.api.services.composePreview.mockResolvedValue({
        ...okPreview,
        ok: false,
        reasons: ['env_file is not supported — inline the values or list them as template env entries'],
        services: [],
        suggestedService: null,
      });
      renderWizard();
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText('my-app'), 'stack');
      await pasteStack(user);

      expect(await screen.findByText(/env_file is not supported/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    });

    it('surfaces warnings without blocking', async () => {
      apiMock.api.services.composePreview.mockResolvedValue({
        ...okPreview,
        warnings: ['declares external resources — they must exist before first deploy'],
      });
      renderWizard();
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText('my-app'), 'stack');
      await pasteStack(user);

      expect(await screen.findByText(/declares external resources/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled());
    });

    it('sends the YAML and the chosen main service, and prefills the file’s own variables', async () => {
      apiMock.api.services.composePreview.mockResolvedValue(okPreview);
      renderWizard();
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText('my-app'), 'stack');
      await pasteStack(user);

      // The routed service defaults to the server's suggestion; override it.
      // The select only appears once the (debounced) preview comes back, so
      // wait for one of its options rather than for a combobox count.
      const dbOption = await screen.findByRole('option', { name: 'db' });
      await user.selectOptions(dbOption.closest('select')!, 'db');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      // Runtime → Environment: `${TZ:-UTC}` arrived as an editable row.
      await user.click(screen.getByRole('button', { name: /continue/i }));
      expect(screen.getAllByPlaceholderText('KEY')[0]).toHaveValue('TZ');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /deploy/i }));

      await waitFor(() =>
        expect(apiMock.api.services.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'compose',
            composeContent: STACK,
            composeService: 'db',
            // No repository: the stack IS the source.
            repoUrl: undefined,
            image: undefined,
          }),
        ),
      );
      await waitFor(() => expect(apiMock.api.deploys.trigger).toHaveBeenCalledWith(42));
    });

    it('shows the failure when the analysis request itself fails', async () => {
      // Network/permission failure: without this the box would sit silently
      // empty and Continue would stay disabled with no explanation.
      apiMock.api.services.composePreview.mockRejectedValue(new Error('Operator access required'));
      renderWizard();
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText('my-app'), 'stack');
      await pasteStack(user);

      expect(await screen.findByText('Operator access required')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    });

    it('names the variables the stack needs from the user', async () => {
      apiMock.api.services.composePreview.mockResolvedValue({
        ...okPreview,
        openPlaceholders: ['ADMIN_EMAIL'],
        configurableEnv: [],
      });
      renderWizard();
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText('my-app'), 'stack');
      await pasteStack(user);

      expect(await screen.findByText('ADMIN_EMAIL')).toBeInTheDocument();
      expect(screen.getByText(/Generated for you:/)).toBeInTheDocument();
    });

    it('drops back to Git repo when the type moves away from compose', async () => {
      renderWizard();
      const user = userEvent.setup();
      await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'compose');
      await user.click(screen.getByRole('button', { name: 'Paste YAML' }));
      expect(screen.getByLabelText('Compose file')).toBeInTheDocument();

      await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'pm2');
      expect(screen.queryByLabelText('Compose file')).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText('https://github.com/you/repo')).toBeInTheDocument();
    });
  });

});
