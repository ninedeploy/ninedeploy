import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Hub } from '../src/routes/Hub.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

vi.mock('../src/components/DeployWizard.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => children,
  DeployWizard: ({ template, onClose }: { template: { name: string }; onClose: () => void }) => (
    <div data-testid="deploy-wizard">
      wizard-{template?.name}
      <button type="button" onClick={onClose}>close wizard</button>
    </div>
  ),
}));

const templates = [
  {
    id: 'n8n',
    name: 'n8n',
    emoji: '⚡',
    category: 'Automation',
    tagline: 'Workflow automation',
    featured: true,
    runtimeVerified: true,
  },
  {
    id: 'ghost',
    name: 'Ghost',
    emoji: '👻',
    category: 'Blogging',
    tagline: 'Publishing platform',
    featured: false,
    runtimeVerified: false,
  },
];

const templateDetail = {
  id: 'n8n',
  name: 'n8n',
  emoji: '⚡',
  category: 'Automation',
  tagline: 'Workflow automation',
  description: 'A workflow tool',
  image: 'docker.io/n8nio/n8n',
  port: 5678,
  volumeMount: '/home/node/.n8n',
  website: 'https://n8n.io',
  env: [
    { key: 'N8N_HOST', value: 'localhost' },
    { key: 'N8N_KEY', value: '', secret: true },
  ],
  runtimeVerified: true,
};

const marketplaceCatalog = [
  {
    id: 's3-backups',
    name: 'S3 Sync',
    version: '1.0.0',
    description: 'Amazon S3 backup extension',
    author: 'NineDeploy Official',
    category: 'storage',
    isOfficial: true,
    isInstalled: false,
    configSchema: [{ key: 'bucket_name', type: 'string', isSecret: false, label: 'Bucket' }],
  },
  {
    id: 'discord-alerts',
    name: 'Discord Bot',
    version: '2.0.0',
    description: 'Discord notification extension',
    author: 'Community',
    category: 'notifications',
    isOfficial: false,
    isInstalled: true,
    configSchema: [],
  },
  // A catalog entry without a name/description/category still renders and
  // filters without crashing. (isInstalled keeps the install-button count
  // stable for the exact-match queries in the tests below.)
  {
    id: 'mystery-plugin',
    name: null,
    version: '0.1.0',
    description: null,
    author: 'Anonymous',
    category: null,
    isOfficial: false,
    isInstalled: true,
    configSchema: [],
  },
];

describe('Hub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'admin@test.com', name: 'Admin', isOperator: true },
      loading: false,
    } as never);
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    mockOf(api.plugins.marketplace).mockResolvedValue({ catalog: marketplaceCatalog } as never);
  });

  it('shows skeleton while loading', () => {
    mockOf(api.templates.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Hub />);
    expect(document.querySelectorAll('.animate-pulse').length).toBe(4);
  });

  it('shows an error card with retry when the templates query fails', async () => {
    mockOf(api.templates.list).mockRejectedValue(new Error('registry down') as never);
    renderWithProviders(<Hub />);
    expect(await screen.findByText("Couldn't load templates")).toBeInTheDocument();
    expect(screen.getByText('registry down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.templates.list).toHaveBeenCalledTimes(2));
  });

  it('shows a zero-results empty state for unmatched search and empty categories', async () => {
    const user = userEvent.setup();
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    const { unmount } = renderWithProviders(<Hub />);
    await screen.findByText('n8n');
    await user.type(screen.getByPlaceholderText('Search templates…'), 'nothing-matches');
    expect(await screen.findByText('No templates match')).toBeInTheDocument();
    expect(screen.getByText(/Nothing matches "nothing-matches" in any category/)).toBeInTheDocument();
    unmount();

    // A registry with no templates at all shows the category-only hint branch.
    mockOf(api.templates.list).mockResolvedValue([] as never);
    renderWithProviders(<Hub />);
    expect(await screen.findByText('No templates match')).toBeInTheDocument();
    expect(screen.getByText(/No templates in All/)).toBeInTheDocument();
  });

  it('renders templates with categories and filters by search + category', async () => {
    const user = userEvent.setup();
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    renderWithProviders(<Hub />);
    await screen.findByText('n8n');
    // featured badge only for featured template
    expect(screen.getByText('featured')).toBeInTheDocument();
    // category chips: All + both categories
    expect(screen.getByRole('button', { name: 'Automation' })).toBeInTheDocument();
    // filter by category
    await user.click(screen.getByRole('button', { name: 'Blogging' }));
    expect(screen.queryByText('Workflow automation')).not.toBeInTheDocument();
    expect(screen.getByText('Publishing platform')).toBeInTheDocument();
    // filter by search
    await user.type(screen.getByPlaceholderText('Search templates…'), 'n8n');
    expect(screen.queryByText('Publishing platform')).not.toBeInTheDocument();
  });

  it('separates runtime-verified and community templates without hiding either tier', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Hub />);
    await screen.findByText('n8n');

    expect(screen.getByRole('button', { name: 'All 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verified 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Community 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Community 1' }));
    expect(screen.queryByText('Workflow automation')).not.toBeInTheDocument();
    expect(screen.getByText('Publishing platform')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Verified 1' }));
    expect(screen.getByText('Workflow automation')).toBeInTheDocument();
    expect(screen.queryByText('Publishing platform')).not.toBeInTheDocument();
  });

  it('warns before configuring a community template', async () => {
    mockOf(api.templates.get).mockResolvedValue({
      ...templateDetail,
      id: 'ghost',
      name: 'Ghost',
      runtimeVerified: false,
    } as never);
    renderWithProviders(<Hub />);
    fireEvent.click(await screen.findByRole('button', { name: /Ghost/ }));
    expect(await screen.findByText(/Community template: its manifest is validated/)).toBeInTheDocument();
  });

  it('shows the requires hint for templates that need extra setup', async () => {
    mockOf(api.templates.get).mockResolvedValue({
      ...templateDetail,
      requires: 'Umami needs a PostgreSQL database — one is provisioned automatically',
      dbEngine: 'postgres',
    } as never);
    renderWithProviders(<Hub />);
    fireEvent.click(await screen.findByText('n8n'));
    expect(await screen.findByText(/provisioned automatically/)).toBeInTheDocument();
  });

  it('shows a custom-registry badge when a source is configured', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null, templatesSource: 'https://registry.example.com/r.json', dnsProvider: null, hasDnsToken: false, wildcardApex: null } as never);
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    renderWithProviders(<Hub />);
    expect(await screen.findByText('custom registry')).toBeInTheDocument();
  });

  it('shows the template detail modal and deploys', async () => {
    const user = userEvent.setup();
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    mockOf(api.templates.get).mockResolvedValue(templateDetail as never);
    renderWithProviders(<Hub />);
    // click the n8n template card
    fireEvent.click(await screen.findByRole('button', { name: /n8n/ }));
    await screen.findByText('A workflow tool');
    // image.split('/').pop() -> 'n8n'
    expect(screen.getAllByText('n8n').length).toBeGreaterThan(0);
    expect(screen.getByText(':5678')).toBeInTheDocument();
    expect(screen.getByText('Volume')).toBeInTheDocument();
    expect(screen.getByText('N8N_HOST')).toBeInTheDocument();
    expect(screen.getByText('localhost')).toBeInTheDocument();
    expect(screen.getByText('••• secret')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'n8n.io' })).toHaveAttribute('href', 'https://n8n.io');
    // deploy opens the wizard with the template
    await user.click(screen.getByRole('button', { name: /Configure & deploy/ }));
    expect(screen.getByTestId('deploy-wizard')).toHaveTextContent('wizard-n8n');
    await user.click(screen.getByRole('button', { name: 'close wizard' }));
    expect(screen.queryByTestId('deploy-wizard')).not.toBeInTheDocument();
  });

  it('shows the ephemeral spec when a template has no volume mount', async () => {
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    mockOf(api.templates.get).mockResolvedValue({ ...templateDetail, volumeMount: null } as never);
    renderWithProviders(<Hub />);
    fireEvent.click(await screen.findByRole('button', { name: /n8n/ }));
    await screen.findByText('A workflow tool');
    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
  });

  it('opens a template card from the keyboard with Enter or Space (r292)', async () => {
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    mockOf(api.templates.get).mockResolvedValue(templateDetail as never);
    const user = userEvent.setup();
    renderWithProviders(<Hub />);
    const card = await screen.findByRole('button', { name: /n8n/ });
    card.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('A workflow tool')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button').find((b) => b.querySelector('.lucide-x'))!);
    expect(screen.queryByText('A workflow tool')).not.toBeInTheDocument();
    card.focus();
    await user.keyboard(' ');
    expect(await screen.findByText('A workflow tool')).toBeInTheDocument();
  });

  it('announces the template detail as a labelled modal dialog and closes it on Escape (r294)', async () => {
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    mockOf(api.templates.get).mockResolvedValue(templateDetail as never);
    const user = userEvent.setup();
    renderWithProviders(<Hub />);
    fireEvent.click(await screen.findByRole('button', { name: /n8n/ }));
    await screen.findByText('A workflow tool');
    const dialog = screen.getByRole('dialog', { name: 'n8n' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the template detail modal via the close button', async () => {
    mockOf(api.templates.list).mockResolvedValue(templates as never);
    mockOf(api.templates.get).mockResolvedValue(templateDetail as never);
    renderWithProviders(<Hub />);
    fireEvent.click(await screen.findByRole('button', { name: /n8n/ }));
    await screen.findByText('A workflow tool');
    const closeButton = screen.getAllByRole('button').find((b) => b.querySelector('.lucide-x'))!;
    fireEvent.click(closeButton);
    expect(screen.queryByText('A workflow tool')).not.toBeInTheDocument();
  });

  it('switches to Compose YAML subtab and copies docker compose to clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    mockOf(api.templates.list).mockResolvedValue(templates as never);
    mockOf(api.templates.get).mockResolvedValue(templateDetail as never);
    renderWithProviders(<Hub />);

    fireEvent.click(await screen.findByRole('button', { name: /n8n/ }));
    await screen.findByText('A workflow tool');

    // Switch to Compose YAML subtab
    await user.click(screen.getByRole('button', { name: 'Compose YAML' }));
    expect(screen.getByText('docker-compose.yml preview')).toBeInTheDocument();
    expect(screen.getByText(/image: docker\.io\/n8nio\/n8n/)).toBeInTheDocument();

    // Click Copy YAML
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole('button', { name: 'Copy YAML' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('services:'));
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
    vi.advanceTimersByTime(2100);
    vi.useRealTimers();

    // Switch back to Overview
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('A workflow tool')).toBeInTheDocument();
  });

  it('generateComposeYaml handles minimal and full template configurations', async () => {
    const { generateComposeYaml } = await import('../src/routes/Hub.js');
    const minimalYaml = generateComposeYaml({
      id: 'simple-app',
      name: 'Simple App',
      emoji: '🚀',
      category: 'Tools',
      tagline: 'Simple test app',
      description: 'A test app without env or port or volume',
      image: 'alpine:latest',
      port: 0,
      env: [],
      volumeMount: null,
      featured: false,
    });
    expect(minimalYaml).toContain('services:');
    expect(minimalYaml).toContain('simple-app:');
    expect(minimalYaml).toContain('image: alpine:latest');
    expect(minimalYaml).not.toContain('ports:');
    expect(minimalYaml).not.toContain('volumes:');
  });

  describe('Extension Marketplace Tab', () => {
    it('switches to marketplace tab and renders extension cards and installs', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.install).mockResolvedValue({ ok: true, id: 's3-backups', status: 'active' });

      const { queryClient } = renderWithProviders(<Hub />);
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));

      await waitFor(() => {
        expect(screen.getByText('S3 Sync')).toBeInTheDocument();
        expect(screen.getByText('Discord Bot')).toBeInTheDocument();
        expect(screen.getByText('Official')).toBeInTheDocument();
        // Two non-official cards (Discord Bot + the unnamed catalog entry).
        expect(screen.getAllByText('Community').length).toBe(2);
        expect(screen.getAllByText('Installed').length).toBe(2);
      });

      // Filter marketplace items
      await user.type(screen.getByPlaceholderText('Search extensions…'), 'Amazon');
      expect(screen.getByText('S3 Sync')).toBeInTheDocument();
      expect(screen.queryByText('Discord Bot')).not.toBeInTheDocument();

      // Click install
      await user.click(screen.getByRole('button', { name: /Install/ }));
      await waitFor(() => {
        expect(mockOf(api.plugins.install)).toHaveBeenCalledWith({
          source: 'marketplace',
          target: 's3-backups',
        });
      });
      // r342: Settings → Plugins caches the list under ['plugins-list'].
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plugins-list'] }));
    });

    it('switches back to templates tab and tests non-admin disabled install', async () => {
      const user = userEvent.setup();
      mockOf(useAuth).mockReturnValue({
        user: { id: 2, email: 'member@test.com', name: 'Member', isOperator: false },
        loading: false,
      } as never);

      renderWithProviders(<Hub />);
      // Switch to marketplace
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));
      await waitFor(() => expect(screen.getByText('S3 Sync')).toBeInTheDocument());

      // Install button is disabled for non-admin
      const installBtn = screen.getByRole('button', { name: /Install/ });
      expect(installBtn).toBeDisabled();

      // Switch back to App Templates
      await user.click(screen.getByRole('button', { name: /App Templates/ }));
      await waitFor(() => expect(screen.getByText('n8n')).toBeInTheDocument());
    });

    it('shows installing spinner while install is in flight', async () => {
      const user = userEvent.setup();
      let resolveInstall!: (val: unknown) => void;
      mockOf(api.plugins.install).mockReturnValue(
        new Promise((res) => {
          resolveInstall = res;
        }) as never,
      );

      renderWithProviders(<Hub />);
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));
      await waitFor(() => expect(screen.getByText('S3 Sync')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /Install/ }));
      expect(await screen.findByText('Installing…')).toBeInTheDocument();

      resolveInstall({ ok: true, id: 's3-backups', status: 'active' });
      await waitFor(() => expect(screen.queryByText('Installing…')).not.toBeInTheDocument());
    });

    it('shows loading state in marketplace tab', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.marketplace).mockReturnValue(new Promise(() => {}));

      renderWithProviders(<Hub />);
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));
      expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    });

    it('shows error state with retry in marketplace tab', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.marketplace).mockRejectedValue(new Error('Marketplace offline'));

      renderWithProviders(<Hub />);
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));
      expect(await screen.findByText("Couldn't load marketplace")).toBeInTheDocument();
      expect(screen.getByText('Marketplace offline')).toBeInTheDocument();

      mockOf(api.plugins.marketplace).mockResolvedValue({ catalog: marketplaceCatalog } as never);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.getByText('S3 Sync')).toBeInTheDocument());
    });

    it('shows empty state when catalog is empty in marketplace tab', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.marketplace).mockResolvedValue({ catalog: [] } as never);

      renderWithProviders(<Hub />);
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));
      expect(await screen.findByText('No extensions match')).toBeInTheDocument();
      expect(screen.getByText('No extensions found.')).toBeInTheDocument();
    });

    it('shows query empty state in marketplace tab when search returns no match', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Hub />);
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));
      await waitFor(() => expect(screen.getByText('S3 Sync')).toBeInTheDocument());

      await user.type(screen.getByPlaceholderText('Search extensions…'), 'xyznonexistent');
      expect(await screen.findByText('No extensions match')).toBeInTheDocument();
      expect(screen.getByText('Nothing matches "xyznonexistent" in extensions.')).toBeInTheDocument();
    });

    it('handles install failure gracefully in marketplace tab', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.install).mockRejectedValue(new Error('Install failed'));

      renderWithProviders(<Hub />);
      await user.click(screen.getByRole('button', { name: /Extension Marketplace/ }));
      await waitFor(() => expect(screen.getByText('S3 Sync')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /Install/ }));
      await waitFor(() => expect(mockOf(api.plugins.install)).toHaveBeenCalled());
    });
  });
});
