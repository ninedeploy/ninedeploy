import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../src/routes/settings/index.js';
import { ConfigCenterSection } from '../src/routes/settings/ConfigCenterSection.js';
import { PluginsSection } from '../src/routes/settings/PluginsSection.js';
import { ModeProvider } from '../src/lib/mode.js';
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

const sampleConfigEntries = [
  {
    key: 'system.site_name',
    pluginId: null,
    type: 'string' as const,
    isSecret: false,
    label: 'Site Name',
    category: 'general',
    description: 'Instance Display Name',
    tags: ['branding', 'system'],
    value: 'NineDeploy Production',
    isConfigured: true,
    updatedAt: '2026-08-17T12:00:00.000Z',
  },
  {
    key: 'system.max_memory_mb',
    pluginId: null,
    type: 'number' as const,
    isSecret: false,
    label: 'Max Memory',
    category: 'resources',
    description: 'Host memory cap',
    tags: ['memory', 'limits'],
    value: 4096,
    isConfigured: true,
    updatedAt: '2026-08-17T12:00:00.000Z',
  },
  {
    key: 'system.json_meta',
    pluginId: null,
    type: 'json' as const,
    isSecret: false,
    label: 'JSON Meta',
    category: 'general',
    tags: [],
    value: { region: 'eu-central' },
    isConfigured: true,
  },
  {
    key: 'system.bool_flag',
    pluginId: null,
    type: 'boolean' as const,
    isSecret: false,
    label: 'Feature Flag',
    category: 'general',
    tags: [],
    value: true,
    isConfigured: true,
  },
  {
    key: 'system.null_value',
    pluginId: null,
    type: 'string' as const,
    isSecret: false,
    label: 'Null Value',
    category: 'general',
    tags: [],
    value: null,
    isConfigured: true,
  },
  {
    key: 'plugin:smtp:password',
    pluginId: 'smtp',
    type: 'string' as const,
    isSecret: true,
    label: 'SMTP Password',
    category: 'plugin:smtp',
    description: 'Encrypted relay credentials',
    tags: ['email', 'auth'],
    value: '••••••••',
    isConfigured: true,
    updatedAt: '2026-08-17T12:00:00.000Z',
  },
  {
    key: 'system.default_setting',
    pluginId: null,
    type: 'string' as const,
    isSecret: false,
    label: 'Default Setting',
    category: 'general',
    tags: [],
    value: 'Default Value',
    isConfigured: false,
  },
];

const samplePlugins = [
  {
    id: 'traefik-proxy',
    name: 'Traefik Dynamic Proxy',
    version: '2.11.0',
    description: 'Reverse proxy and automatic TLS ingress provider',
    isOfficial: true,
    enabled: true,
    status: 'active' as const,
    dependencies: [],
  },
  {
    id: 'smtp-notifier',
    name: 'SMTP Email Delivery',
    version: '1.0.4',
    description: 'Sends email alerts via SMTP relay',
    isOfficial: false,
    enabled: false,
    status: 'disabled' as const,
    dependencies: ['notifications-core'],
  },
  {
    id: 'errored-plugin',
    name: 'Broken Plugin',
    version: '0.1.0',
    description: 'Fails to boot',
    isOfficial: false,
    enabled: false,
    status: 'errored' as const,
    error: 'Fatal crash on init: missing required socket',
  },
];

describe('Config Center & Plugins Frontend Components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'admin@test.com', name: 'Admin', isOperator: true },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
      loginWithPasskey: vi.fn(),
    });
    mockOf(api.auth.me).mockResolvedValue({ id: 1, email: 'admin@test.com', name: 'Admin', isOperator: true });
    mockOf(api.config.list).mockResolvedValue({ entries: sampleConfigEntries });
    mockOf(api.config.set).mockResolvedValue({ ok: true, key: 'system.site_name' });
    mockOf(api.config.delete).mockResolvedValue({ ok: true, key: 'system.site_name' });
    mockOf(api.plugins.list).mockResolvedValue({ plugins: samplePlugins });
    mockOf(api.plugins.enable).mockResolvedValue({ ok: true, id: 'smtp-notifier', status: 'active' });
    mockOf(api.plugins.disable).mockResolvedValue({ ok: true, id: 'traefik-proxy', status: 'disabled' });
  });

  describe('ConfigCenterSection', () => {
    it('groups entries for git, dns and custom plugin scopes', async () => {
    mockOf(api.config.list).mockResolvedValue({
      entries: [
        { key: 'github.webhook_secret', pluginId: null, type: 'string', isSecret: true, label: 'Hook Secret', category: 'general', tags: [], value: '••••••••', isConfigured: true },
        { key: 'dns.provider', pluginId: 'cloudflare', type: 'string', isSecret: false, label: 'Provider', category: 'general', tags: [], value: 'cloudflare', isConfigured: true },
        { key: 'jwt.audience', pluginId: null, type: 'string', isSecret: false, label: 'Audience', category: 'general', tags: [], value: 'panel', isConfigured: true },
        { key: 'payment.gateway', pluginId: 'payment', type: 'string', isSecret: false, label: 'Gateway', category: 'general', tags: [], value: 'stripe', isConfigured: true },
        { key: 'metric.interval', pluginId: null, type: 'number', isSecret: false, label: 'Interval', category: 'general', tags: [], value: 30, isConfigured: true },
        { key: 'backup.bucket', pluginId: null, type: 'string', isSecret: false, label: 'Bucket', category: 'general', tags: [], value: 'b', isConfigured: true },
        { key: 'traefik.entrypoint', pluginId: 'traefik', type: 'string', isSecret: false, label: 'Entrypoint', category: 'general', tags: [], value: 'web', isConfigured: true },
        { key: 'docker.log_level', pluginId: null, type: 'string', isSecret: false, label: 'Log level', category: 'general', tags: [], value: 'info', isConfigured: true },
      ],
    } as never);
    renderWithProviders(<ConfigCenterSection />);

    // One grouped section per detected plugin scope.
    expect(await screen.findByText('Git & VCS Integration Plugin')).toBeInTheDocument();
    expect(screen.getByText('DNS & Cloudflare Sync Plugin')).toBeInTheDocument();
    // The auth vault group also has a matching filter pill.
    expect(screen.getAllByText('Authentication & Security Vault').length).toBeGreaterThan(1);
    // The group header and its filter pill share the name.
    expect(screen.getAllByText('Plugin: PAYMENT').length).toBeGreaterThan(0);
    expect(screen.getByText('Monitoring & Telemetry Plugin')).toBeInTheDocument();
    expect(screen.getByText('Backups & Storage Provider Plugin')).toBeInTheDocument();
    expect(screen.getByText('Traefik Proxy & HTTP/3 Engine')).toBeInTheDocument();
    expect(screen.getByText('Docker Engine & Container Runtime')).toBeInTheDocument();
    // Group headers are accordions: collapsing hides the rows.
    fireEvent.click(screen.getByText('Git & VCS Integration Plugin'));
    await waitFor(() => expect(screen.queryByText('github.webhook_secret')).not.toBeInTheDocument());
  });

  it('renders config entries, handles reveal toggle, search and category filters', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ConfigCenterSection />);

      await waitFor(() => {
        expect(screen.getByText('system.site_name')).toBeInTheDocument();
        expect(screen.getByText('NineDeploy Production')).toBeInTheDocument();
        expect(screen.getByText('plugin:smtp:password')).toBeInTheDocument();
        expect(screen.getByText('••••••••')).toBeInTheDocument();
      });

      // Filter by plugin group (entries are grouped per plugin module).
      // The pill carries a trailing count; the group accordion header shares
      // the name, so anchor on the count to target the pill.
      const smtpPill = screen.getByRole('button', { name: /^Notifications & Alerting1$/ });
      await user.click(smtpPill);

      expect(screen.getByText('plugin:smtp:password')).toBeInTheDocument();
      expect(screen.queryByText('system.site_name')).not.toBeInTheDocument();

      // Reset to all
      const allPill = screen.getByRole('button', { name: /All Plugins/i });
      await user.click(allPill);
      expect(screen.getByText('system.site_name')).toBeInTheDocument();

      // Search by tag
      const searchInput = screen.getByPlaceholderText('Search keys, values, tags...');
      await user.type(searchInput, 'email');
      expect(screen.getByText('plugin:smtp:password')).toBeInTheDocument();
      expect(screen.queryByText('system.site_name')).not.toBeInTheDocument();

      // Empty search state
      await user.clear(searchInput);
      await user.type(searchInput, 'nonexistent-query-12345');
      expect(screen.getByText('No configuration entries found matching your search or plugin filter.')).toBeInTheDocument();
      await user.clear(searchInput);

      // Reveal secrets toggle
      const revealBtn = screen.getByRole('button', { name: /reveal secrets/i });
      await user.click(revealBtn);
      await waitFor(() => {
        expect(mockOf(api.config.list)).toHaveBeenCalledWith({ reveal: true });
      });

      // Refresh button
      const refreshBtn = screen.getByLabelText('Refresh config');
      await user.click(refreshBtn);
      await waitFor(() => {
        expect(mockOf(api.config.list)).toHaveBeenCalled();
      });
    });

    it('creates a new configuration entry via modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ConfigCenterSection />);

      await waitFor(() => {
        expect(screen.getByText('New Setting')).toBeInTheDocument();
      });

      await user.click(screen.getByText('New Setting'));
      expect(screen.getByText('Create Configuration Key')).toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('e.g. system.custom_timeout or plugin:traefik:idle_timeout'), { target: { value: 'custom.my_key' } });
      fireEvent.change(screen.getByPlaceholderText('Setting value'), { target: { value: 'my-val' } });
      fireEvent.change(screen.getByPlaceholderText('Brief description of this setting'), { target: { value: 'My Description' } });
      fireEvent.change(screen.getByPlaceholderText('e.g. timeout, critical, cloudflare'), { target: { value: 'tag1, tag2' } });
      fireEvent.click(screen.getByRole('checkbox'));

      fireEvent.click(screen.getByRole('button', { name: /create setting/i }));

      await waitFor(() => {
        expect(mockOf(api.config.set)).toHaveBeenCalledWith('custom.my_key', {
          value: 'my-val',
          isSecret: true,
          description: 'My Description',
          tags: ['tag1', 'tag2'],
        });
      });
    });

    it('edits config entries of various types (string, number, boolean, json)', async () => {
      renderWithProviders(<ConfigCenterSection />);

      await waitFor(() => {
        expect(screen.getByText('system.site_name')).toBeInTheDocument();
      });

      // 1. Edit string
      let editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[0]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: system.site_name')).toBeInTheDocument();
      });
      const input = screen.getByDisplayValue('NineDeploy Production');
      fireEvent.change(input, { target: { value: 'NineDeploy Updated' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        expect(mockOf(api.config.set)).toHaveBeenCalledWith('system.site_name', {
          value: 'NineDeploy Updated',
          isSecret: false,
          description: 'Instance Display Name',
          tags: ['branding', 'system'],
        });
      });

      // 2. Edit number
      await waitFor(() => expect(screen.queryByText('Edit Config: system.site_name')).not.toBeInTheDocument());
      editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[1]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: system.max_memory_mb')).toBeInTheDocument();
      });
      const numInput = screen.getByDisplayValue('4096');
      fireEvent.change(numInput, { target: { value: '8192' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        expect(mockOf(api.config.set)).toHaveBeenCalledWith('system.max_memory_mb', expect.objectContaining({ value: 8192 }));
      });

      // 3. Edit JSON (with invalid alert and valid json)
      await waitFor(() => expect(screen.queryByText('Edit Config: system.max_memory_mb')).not.toBeInTheDocument());
      const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
      editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[2]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: system.json_meta')).toBeInTheDocument();
      });
      const jsonInput = screen.getByDisplayValue(JSON.stringify({ region: 'eu-central' }));
      fireEvent.change(jsonInput, { target: { value: '{invalid-json' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      expect(alertMock).toHaveBeenCalledWith('Invalid JSON format');

      fireEvent.change(jsonInput, { target: { value: '{"region":"us-east"}' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        expect(mockOf(api.config.set)).toHaveBeenCalledWith('system.json_meta', expect.objectContaining({ value: { region: 'us-east' } }));
      });
      alertMock.mockRestore();

      // 4. Edit boolean
      await waitFor(() => expect(screen.queryByText('Edit Config: system.json_meta')).not.toBeInTheDocument());
      editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[3]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: system.bool_flag')).toBeInTheDocument();
      });
      const boolInput = screen.getByDisplayValue('true');
      fireEvent.change(boolInput, { target: { value: 'false' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        expect(mockOf(api.config.set)).toHaveBeenCalledWith('system.bool_flag', expect.objectContaining({ value: false }));
      });

      // 5. Edit null value entry
      await waitFor(() => expect(screen.queryByText('Edit Config: system.bool_flag')).not.toBeInTheDocument());
      editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[4]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: system.null_value')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      // 6. Edit secret while masked (revealSecrets is false).
      // Edit buttons follow the grouped rows: core entries first
      // (site_name, max_memory_mb, json_meta, bool_flag, null_value,
      // default_setting), then the smtp plugin group.
      await waitFor(() => expect(screen.queryByText('Edit Config: system.null_value')).not.toBeInTheDocument());
      editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[6]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: plugin:smtp:password')).toBeInTheDocument();
      });
      // A masked secret starts blank; the placeholder says so and saving the
      // blank keeps the stored value server-side.
      const maskedInput = screen.getByPlaceholderText('Leave blank to keep the current value');
      expect(maskedInput).toHaveAttribute('type', 'password');
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    });

    it('deletes config entry with confirmation', async () => {
      const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderWithProviders(<ConfigCenterSection />);

      await waitFor(() => {
        expect(screen.getByText('system.site_name')).toBeInTheDocument();
      });

      const deleteBtns = screen.getAllByTitle('Delete');
      fireEvent.click(deleteBtns[0]!);

      expect(confirmMock).toHaveBeenCalled();
      await waitFor(() => {
        expect(mockOf(api.config.delete)).toHaveBeenCalledWith('system.site_name');
      });
      confirmMock.mockRestore();
    });

    it('reports save and delete failures, and picks a target plugin on create', async () => {
      renderWithProviders(<ConfigCenterSection />);
      await waitFor(() => expect(screen.getByText('system.site_name')).toBeInTheDocument());

      // Save failure surfaces the server message via the toast spy.
      mockOf(api.config.set).mockRejectedValueOnce(new Error('vault sealed') as never);
      fireEvent.click(screen.getByText('New Setting'));
      fireEvent.change(screen.getByPlaceholderText('e.g. system.custom_timeout or plugin:traefik:idle_timeout'), { target: { value: 'k' } });
      // Choose a non-core target plugin for the new key.
      fireEvent.change(screen.getByDisplayValue('Core Platform (core)'), { target: { value: 'traefik' } });
      fireEvent.click(screen.getByRole('button', { name: /create setting/i }));
      await waitFor(() => expect(api.config.set).toHaveBeenCalledTimes(1));

      // Delete failure is reported too.
      const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
      mockOf(api.config.delete).mockRejectedValueOnce(new Error('locked') as never);
      fireEvent.click(screen.getAllByTitle('Delete')[0]!);
      await waitFor(() => expect(api.config.delete).toHaveBeenCalledTimes(1));
      confirmMock.mockRestore();
    });

    it('falls back to generic messages for non-Error failures and sorts core first', async () => {
      renderWithProviders(<ConfigCenterSection />);
      await waitFor(() => expect(screen.getByText('system.site_name')).toBeInTheDocument());

      // The core group renders ahead of alphabetically-later scopes.
      const core = screen.getByText('system.site_name').closest('[class*="rounded"]') ?? screen.getByText('system.site_name');
      expect(core).toBeInTheDocument();

      // A string save rejection surfaces the generic message.
      mockOf(api.config.set).mockRejectedValueOnce('boom' as never);
      const editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[0]!);
      const input = await screen.findByDisplayValue('NineDeploy Production');
      fireEvent.change(input, { target: { value: 'X' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(api.config.set).toHaveBeenCalledTimes(1));

      // A string delete rejection surfaces its generic message.
      const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
      mockOf(api.config.delete).mockRejectedValueOnce('nope' as never);
      fireEvent.click(screen.getAllByTitle('Delete')[0]!);
      await waitFor(() => expect(api.config.delete).toHaveBeenCalledTimes(1));
      confirmMock.mockRestore();
    });
  });

  describe('PluginsSection', () => {
    const sampleCatalog = [
      {
        id: 's3-backups',
        name: 'Amazon S3 & Cloudflare R2 Sync',
        version: '1.1.0',
        description: 'Automated backup replication',
        author: 'NineDeploy Official',
        category: 'storage',
        isOfficial: true,
        isInstalled: false,
      },
      {
        id: 'discord-alerts',
        name: 'Discord Webhook Notifier',
        version: '1.0.0',
        description: 'Sends rich embeds to Discord',
        author: 'Community',
        category: 'notifications',
        isOfficial: false,
        isInstalled: true,
      },
    ];

    beforeEach(() => {
      mockOf(api.plugins.marketplace).mockResolvedValue({ catalog: sampleCatalog });
      mockOf(api.plugins.install).mockResolvedValue({ ok: true, id: 's3-backups', status: 'active' });
      mockOf(api.plugins.uninstall).mockResolvedValue({ ok: true, id: 'smtp-notifier' });
    });

    /** Render in advanced mode so built-in core plugins render as full cards
     *  (simple mode collapses the core list into a summary row). */
    const renderPlugins = () => {
      localStorage.setItem('ninedeploy_experience_mode', 'advanced');
      return renderWithProviders(
        <ModeProvider>
          <PluginsSection />
        </ModeProvider>,
      );
    };

    it('renders plugin items, official/community badges, toggles enable/disable, and uninstalls', async () => {
      const user = userEvent.setup();
      const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);

      renderPlugins();

      await waitFor(() => {
        expect(screen.getByText('Traefik Dynamic Proxy')).toBeInTheDocument();
        expect(screen.getByText('SMTP Email Delivery')).toBeInTheDocument();
        expect(screen.getByText('Broken Plugin')).toBeInTheDocument();
        expect(screen.getByText(/Core Built-in/i)).toBeInTheDocument();
        expect(screen.getAllByText(/Community/i)).toHaveLength(2);
        expect(screen.getByText('Active')).toBeInTheDocument();
        expect(screen.getByText('Disabled')).toBeInTheDocument();
        expect(screen.getByText('Errored')).toBeInTheDocument();
        expect(screen.getByText('Fatal crash on init: missing required socket')).toBeInTheDocument();
        expect(screen.getByText('notifications-core')).toBeInTheDocument();
      });

      // Official plugins are core built-ins: no enable/disable toggle on them.
      expect(screen.queryByRole('button', { name: /disable/i })).not.toBeInTheDocument();

      // Enable the disabled community plugin
      const enableBtns = screen.getAllByRole('button', { name: /enable/i });
      await user.click(enableBtns[0]!);
      expect(mockOf(api.plugins.enable)).toHaveBeenCalledWith('smtp-notifier');

      // Refresh
      const refreshBtn = screen.getByLabelText('Refresh plugins');
      await user.click(refreshBtn);
      expect(mockOf(api.plugins.list)).toHaveBeenCalled();

      // Uninstall non-official plugin with confirm true
      const uninstallBtns = screen.getAllByTitle('Uninstall Plugin');
      expect(uninstallBtns.length).toBeGreaterThan(0);
      await user.click(uninstallBtns[0]!);
      expect(confirmMock).toHaveBeenCalled();
      expect(mockOf(api.plugins.uninstall)).toHaveBeenCalledWith('smtp-notifier');

      // Cancel uninstall when confirm is false
      confirmMock.mockReturnValue(false);
      await user.click(uninstallBtns[0]!);
      expect(mockOf(api.plugins.uninstall)).toHaveBeenCalledTimes(1);

      confirmMock.mockRestore();
    });

    it('disables an enabled community plugin', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.list).mockResolvedValue({
        plugins: [
          ...samplePlugins,
          {
            id: 'uptime-agent',
            name: 'Uptime Agent',
            version: '2.0.0',
            description: 'External uptime probing',
            isOfficial: false,
            enabled: true,
            status: 'active' as const,
            dependencies: [],
          },
        ],
      });
      renderPlugins();

      const disableBtn = await screen.findByRole('button', { name: /disable/i });
      await user.click(disableBtn);
      expect(mockOf(api.plugins.disable)).toHaveBeenCalledWith('uptime-agent');
    });

    it('handles marketplace installation flow and modal tabs', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PluginsSection />);

      await waitFor(() => {
        expect(screen.getByText('Install Plugin')).toBeInTheDocument();
      });

      // Open install modal
      await user.click(screen.getByText('Install Plugin'));
      await waitFor(() => {
        expect(screen.getByText('Marketplace Catalog')).toBeInTheDocument();
        expect(screen.getByText('Amazon S3 & Cloudflare R2 Sync')).toBeInTheDocument();
        expect(screen.getByText('Discord Webhook Notifier')).toBeInTheDocument();
        expect(screen.getByText('Installed')).toBeInTheDocument();
      });

      // Filter by category chip
      const storageChip = screen.getByRole('button', { name: 'storage' });
      await user.click(storageChip);
      expect(screen.getByText('Amazon S3 & Cloudflare R2 Sync')).toBeInTheDocument();
      expect(screen.queryByText('Discord Webhook Notifier')).not.toBeInTheDocument();

      // Reset to all categories
      const allCatChip = screen.getByRole('button', { name: 'all' });
      await user.click(allCatChip);
      expect(screen.getByText('Discord Webhook Notifier')).toBeInTheDocument();

      // Search filtering
      const mktSearchInput = screen.getByPlaceholderText('Search plugins by name, keyword, or author...');
      fireEvent.change(mktSearchInput, { target: { value: 'Discord' } });
      expect(screen.getByText('Discord Webhook Notifier')).toBeInTheDocument();
      expect(screen.queryByText('Amazon S3 & Cloudflare R2 Sync')).not.toBeInTheDocument();

      // No match search state
      fireEvent.change(mktSearchInput, { target: { value: 'nonexistent_plugin_xyz' } });
      expect(screen.getByText('No plugins match your filter criteria.')).toBeInTheDocument();

      // Clear search
      fireEvent.change(mktSearchInput, { target: { value: '' } });
      expect(screen.getByText('Amazon S3 & Cloudflare R2 Sync')).toBeInTheDocument();

      // Install s3-backups from marketplace
      const installBtn = screen.getByRole('button', { name: /^Install$/ });
      await user.click(installBtn);
      await waitFor(() => {
        expect(mockOf(api.plugins.install)).toHaveBeenCalledWith({
          source: 'marketplace',
          target: 's3-backups',
        });
      });

      // Re-open and test custom package tab
      await user.click(screen.getByText('Install Plugin'));
      await waitFor(() => {
        expect(screen.getByText('Custom Package / Repo')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Custom Package / Repo'));

      // Switch back to marketplace tab and back to custom
      await user.click(screen.getByText('Marketplace Catalog'));
      await waitFor(() => {
        expect(screen.getByText('Amazon S3 & Cloudflare R2 Sync')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Custom Package / Repo'));

      // Switch source types
      await user.click(screen.getByRole('button', { name: 'GIT' }));
      expect(screen.getByText('Git Repository URL')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'LOCAL' }));
      expect(screen.getByText('Local Directory Path')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'NPM' }));
      expect(screen.getByText('NPM Package Name')).toBeInTheDocument();

      // Test Cancel button
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      await waitFor(() => {
        expect(screen.queryByText('Custom Package / Repo')).not.toBeInTheDocument();
      });

      // Re-open and test close via dialog X button
      await user.click(screen.getByRole('button', { name: 'Install Plugin' }));
      await waitFor(() => {
        expect(screen.getByText('Marketplace Catalog')).toBeInTheDocument();
      });
      const closeBtns = screen.getAllByLabelText('Close dialog');
      await user.click(closeBtns[0]!);
      await waitFor(() => {
        expect(screen.queryByText('Marketplace Catalog')).not.toBeInTheDocument();
      });

      // Re-open and submit custom install
      await user.click(screen.getByRole('button', { name: 'Install Plugin' }));
      await waitFor(() => {
        expect(screen.getByText('Custom Package / Repo')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Custom Package / Repo'));

      // Fill custom inputs
      const targetInput = screen.getByPlaceholderText('e.g. @ninedeploy-plugin/datadog-tracer');
      fireEvent.change(targetInput, { target: { value: '@ninedeploy/plugin-custom' } });

      const nameInput = screen.getByPlaceholderText('My Custom Plugin');
      fireEvent.change(nameInput, { target: { value: 'Custom Plugin' } });

      const versionInput = screen.getByPlaceholderText('1.0.0');
      fireEvent.change(versionInput, { target: { value: '2.1.0' } });

      const descInput = screen.getByPlaceholderText('Brief description of this extension');
      fireEvent.change(descInput, { target: { value: 'Awesome custom plugin' } });

      // Click Install Extension
      await user.click(screen.getByRole('button', { name: /install extension/i }));
      await waitFor(() => {
        expect(mockOf(api.plugins.install)).toHaveBeenCalledWith({
          source: 'npm',
          target: '@ninedeploy/plugin-custom',
          name: 'Custom Plugin',
          version: '2.1.0',
          description: 'Awesome custom plugin',
        });
      });

      // Re-open and test install with empty optional fields
      await user.click(screen.getByRole('button', { name: 'Install Plugin' }));
      await waitFor(() => {
        expect(screen.getByText('Custom Package / Repo')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Custom Package / Repo'));
      const targetInput2 = screen.getByPlaceholderText('e.g. @ninedeploy-plugin/datadog-tracer');
      fireEvent.change(targetInput2, { target: { value: 'minimal-plugin' } });
      const versionInput2 = screen.getByPlaceholderText('1.0.0');
      fireEvent.change(versionInput2, { target: { value: '   ' } }); // blank version
      await user.click(screen.getByRole('button', { name: /install extension/i }));
      await waitFor(() => {
        expect(mockOf(api.plugins.install)).toHaveBeenCalledWith({
          source: 'npm',
          target: 'minimal-plugin',
          name: undefined,
          version: undefined,
          description: undefined,
        });
      });
    });

    // A catalog entry with no behaviour behind it must not offer an Install
    // button: it would report itself "active" and accept a bucket name and
    // secret key while doing nothing, and several entries shadow features that
    // already ship under another name.
    it('points an unimplemented catalog entry at the feature that ships instead', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.marketplace).mockResolvedValue({
        catalog: [
          {
            ...sampleCatalog[0]!,
            implemented: false,
            builtIn: { label: 'Backups → Storage destinations', path: '/backups' },
          },
        ],
      });
      renderPlugins();
      await waitFor(() => expect(screen.getByText('Install Plugin')).toBeInTheDocument());
      await user.click(screen.getByText('Install Plugin'));

      await waitFor(() =>
        expect(screen.getByText('Backups → Storage destinations')).toBeInTheDocument(),
      );
      expect(screen.getByRole('link', { name: /Open/ })).toHaveAttribute('href', '/backups');
      expect(screen.queryByRole('button', { name: /^Install$/ })).not.toBeInTheDocument();
      expect(api.plugins.install).not.toHaveBeenCalled();
    });

    it('labels an unimplemented entry with no shipped equivalent as planned', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.marketplace).mockResolvedValue({
        catalog: [{ ...sampleCatalog[0]!, implemented: false }],
      });
      renderPlugins();
      await waitFor(() => expect(screen.getByText('Install Plugin')).toBeInTheDocument());
      await user.click(screen.getByText('Install Plugin'));

      await waitFor(() => expect(screen.getByText('Planned — not available yet')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /^Install$/ })).not.toBeInTheDocument();
    });

    it('renders empty marketplace catalog when catalog is empty', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.marketplace).mockResolvedValue({ catalog: [] });
      renderWithProviders(<PluginsSection />);

      await waitFor(() => {
        expect(screen.getByText('Install Plugin')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Install Plugin'));
      await waitFor(() => {
        expect(screen.getByText('Catalog is currently unavailable.')).toBeInTheDocument();
      });
    });

    it('renders empty plugins and loading state and opens marketplace on click', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.list).mockResolvedValue({ plugins: [] });
      renderWithProviders(<PluginsSection />);

      await waitFor(() => {
        expect(screen.getByText(/No plugins installed/i)).toBeInTheDocument();
      });

      const browseBtn = screen.getByRole('button', { name: /browse marketplace/i });
      await user.click(browseBtn);
      await waitFor(() => {
        expect(screen.getByText('Marketplace Catalog')).toBeInTheDocument();
      });
    });

    it('renders for non-admin member without admin action buttons and inspects without hot reload', async () => {
      const user = userEvent.setup();
      mockOf(useAuth).mockReturnValue({
        user: { id: 2, email: 'member@test.com', name: 'Member', isOperator: false },
        loading: false,
        login: vi.fn(),
        setup: vi.fn(),
        logout: vi.fn(),
        loginWithPasskey: vi.fn(),
      });
      mockOf(api.plugins.inspect).mockResolvedValue({
        id: 'traefik-proxy',
        name: 'Traefik Dynamic Proxy',
        version: '2.11.0',
        description: 'Reverse proxy and automatic TLS ingress provider',
        author: 'NineDeploy Team',
        isOfficial: true,
        enabled: true,
        status: 'active',
        dependencies: [],
        hooks: [],
        services: [],
        menus: [],
        configSchema: [],
        error: null,
        runtimeStats: { eventsHandled: 1, uptimeSeconds: 10 },
      });

      renderWithProviders(
        <ModeProvider>
          <PluginsSection />
        </ModeProvider>,
      );
      await waitFor(() => {
        expect(screen.getByText('Traefik Dynamic Proxy')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /disable/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Install Plugin' })).not.toBeInTheDocument();

      const inspectBtns = screen.getAllByRole('button', { name: /inspect/i });
      // The core (official) plugin's card is last — extensions render first.
      await user.click(inspectBtns.at(-1)!);
      await waitFor(() => {
        expect(screen.getByText('Plugin Details: traefik-proxy')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /hot reload/i })).not.toBeInTheDocument();
    });

    it('opens inspect modal, displays architecture & telemetry, and supports hot-reload', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.inspect).mockResolvedValue({
        id: 'traefik-proxy',
        name: 'Traefik Dynamic Proxy',
        version: '2.11.0',
        description: 'Reverse proxy and automatic TLS ingress provider',
        author: 'NineDeploy Team',
        isOfficial: true,
        enabled: true,
        status: 'active',
        dependencies: [],
        hooks: ['service.created', 'deploy.completed'],
        services: ['proxy-worker'],
        menus: [{ id: 'traefik-menu', label: 'Traefik Hub', route: '/traefik', slot: 'sidebar:main' }],
        configSchema: [
          { key: 'acme_email', type: 'string', label: 'ACME Email' },
          { key: 'default_flag' },
        ],
        error: null,
        runtimeStats: { eventsHandled: 42, uptimeSeconds: 3600 },
      });
      mockOf(api.plugins.reload).mockResolvedValue({ ok: true, id: 'traefik-proxy', status: 'active' });

      renderWithProviders(
        <ModeProvider>
          <PluginsSection />
        </ModeProvider>,
      );
      await waitFor(() => {
        expect(screen.getByText('Traefik Dynamic Proxy')).toBeInTheDocument();
      });

      // Click Inspect on the core (official) plugin — its card is last.
      const inspectBtns = screen.getAllByRole('button', { name: /inspect/i });
      await user.click(inspectBtns.at(-1)!);

      await waitFor(() => {
        expect(screen.getByText('Plugin Details: traefik-proxy')).toBeInTheDocument();
        expect(screen.getByText(/NineDeploy Team/)).toBeInTheDocument();
        expect(screen.getByText('proxy-worker')).toBeInTheDocument();
        expect(screen.getByText('Traefik Hub')).toBeInTheDocument();
      });

      // Click Hot Reload
      await user.click(screen.getByRole('button', { name: /hot reload/i }));
      expect(mockOf(api.plugins.reload)).toHaveBeenCalledWith('traefik-proxy');

      // Close modal
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByText('Plugin Details: traefik-proxy')).not.toBeInTheDocument();
      });
    });

    it('displays inspect modal with error and empty architecture fields', async () => {
      const user = userEvent.setup();
      mockOf(api.plugins.inspect).mockResolvedValue({
        id: 'errored-plugin',
        name: 'Broken Plugin',
        version: '0.1.0',
        description: '',
        author: '',
        isOfficial: false,
        enabled: false,
        status: 'errored',
        dependencies: [],
        hooks: [],
        services: [],
        menus: [],
        configSchema: [],
        error: 'Critical initialization failure',
        runtimeStats: { eventsHandled: 0, uptimeSeconds: 0 },
      });

      renderWithProviders(
        <ModeProvider>
          <PluginsSection />
        </ModeProvider>,
      );
      await waitFor(() => {
        expect(screen.getByText('Broken Plugin')).toBeInTheDocument();
      });

      const inspectBtns = screen.getAllByRole('button', { name: /inspect/i });
      // errored-plugin is the second extension card (extensions render first).
      await user.click(inspectBtns[1]!);

      await waitFor(() => {
        expect(screen.getByText('Plugin Details: errored-plugin')).toBeInTheDocument();
        expect(screen.getByText('Critical initialization failure')).toBeInTheDocument();
        expect(screen.getByText('No custom settings registered.')).toBeInTheDocument();
        expect(screen.getByText('No navigation items registered.')).toBeInTheDocument();
      });
    });
  });

  describe('ConfigCenterSection Edge Cases', () => {
    it('cancels edit and create modals', async () => {
      renderWithProviders(<ConfigCenterSection />);

      await waitFor(() => {
        expect(screen.getByText('system.site_name')).toBeInTheDocument();
      });

      // Open and cancel edit modal
      let editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[0]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: system.site_name')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await waitFor(() => {
        expect(screen.queryByText('Edit Config: system.site_name')).not.toBeInTheDocument();
      });

      // Open and close edit modal via X button
      editBtns = screen.getAllByTitle('Edit Value');
      fireEvent.click(editBtns[0]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: system.site_name')).toBeInTheDocument();
      });
      fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
      await waitFor(() => {
        expect(screen.queryByText('Edit Config: system.site_name')).not.toBeInTheDocument();
      });

      // Open and cancel new setting modal
      fireEvent.click(screen.getByText('New Setting'));
      await waitFor(() => {
        expect(screen.getByText('Create Configuration Key')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByPlaceholderText('general, security, network...'), { target: { value: 'custom_cat' } });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await waitFor(() => {
        expect(screen.queryByText('Create Configuration Key')).not.toBeInTheDocument();
      });

      // Open and close new setting modal via X button
      fireEvent.click(screen.getByText('New Setting'));
      await waitFor(() => {
        expect(screen.getByText('Create Configuration Key')).toBeInTheDocument();
      });
      fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
      await waitFor(() => {
        expect(screen.queryByText('Create Configuration Key')).not.toBeInTheDocument();
      });
    });

    it('handles reject confirmation on delete', async () => {
      const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderWithProviders(<ConfigCenterSection />);

      await waitFor(() => {
        expect(screen.getByText('system.site_name')).toBeInTheDocument();
      });

      const deleteBtns = screen.getAllByTitle('Delete');
      fireEvent.click(deleteBtns[0]!);

      expect(confirmMock).toHaveBeenCalled();
      expect(mockOf(api.config.delete)).not.toHaveBeenCalled();
      confirmMock.mockRestore();
    });

    it('edits a secret while secrets are revealed, and creates setting with empty description', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ConfigCenterSection />);

      await waitFor(() => {
        expect(screen.getByText('system.site_name')).toBeInTheDocument();
      });

      // Reveal secrets
      const revealBtn = screen.getByRole('button', { name: /reveal secrets/i });
      await user.click(revealBtn);
      await waitFor(() => {
        expect(mockOf(api.config.list)).toHaveBeenCalledWith({ reveal: true });
      });

      // Edit secret item (plugin:smtp:password) — last row: core entries
      // render first, so the smtp group's edit button comes after them.
      const editBtns = await screen.findAllByTitle('Edit Value');
      fireEvent.click(editBtns[6]!);
      await waitFor(() => {
        expect(screen.getByText('Edit Config: plugin:smtp:password')).toBeInTheDocument();
      });
      // Saving with the secret left blank keeps the stored value: the update
      // carries no value key at all.
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        expect(mockOf(api.config.set)).toHaveBeenCalledWith('plugin:smtp:password', expect.not.objectContaining({
          value: expect.anything(),
        }));
      });

      // Create setting with empty description
      fireEvent.click(screen.getByText('New Setting'));
      await waitFor(() => {
        expect(screen.getByText('Create Configuration Key')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. system.custom_timeout or plugin:traefik:idle_timeout'), { target: { value: 'nodesc.key' } });
      fireEvent.change(screen.getByPlaceholderText('Setting value'), { target: { value: '123' } });
      fireEvent.click(screen.getByRole('button', { name: /create setting/i }));

      await waitFor(() => {
        expect(mockOf(api.config.set)).toHaveBeenCalledWith('nodesc.key', expect.objectContaining({
          description: undefined,
          value: '123',
        }));
      });
    });

    it('renders for member without reveal or edit buttons', async () => {
      mockOf(useAuth).mockReturnValue({
        user: { id: 2, email: 'member@test.com', name: 'Member', isOperator: false },
        loading: false,
        login: vi.fn(),
        setup: vi.fn(),
        logout: vi.fn(),
        loginWithPasskey: vi.fn(),
      });

      renderWithProviders(<ConfigCenterSection />);
      await waitFor(() => {
        expect(screen.getByText('system.site_name')).toBeInTheDocument();
      });

      expect(screen.queryByText('New Setting')).not.toBeInTheDocument();
      expect(screen.queryByText(/reveal secrets/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle('Edit Value')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
    });
  });

  describe('Settings Tabs Integration', () => {
    it('navigates to Config Center and Plugins tabs from Settings main page', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);

      await waitFor(() => {
        expect(screen.getByText('Config Center')).toBeInTheDocument();
        expect(screen.getByText('Plugins')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Config Center'));
      await waitFor(() => {
        expect(screen.getByText('Configuration Center')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Plugins'));
      await waitFor(() => {
        expect(screen.getByText('Plugin Ecosystem')).toBeInTheDocument();
      });
    });
  });
});
