import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelBackupSection } from '../src/routes/settings/PanelBackupSection.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';

// The shared fake api has no panelBackup group yet — add it here.
vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  const mod = createFakeApiModule();
  (mod.api.system as Record<string, unknown>).panelBackup = {
    get: vi.fn(),
    update: vi.fn(),
    run: vi.fn(),
    list: vi.fn(),
    restore: vi.fn(),
  };
  return mod;
});
vi.mock('../src/lib/auth.js', async () => (await import('./apiMock.js')).createAuthMock());
vi.mock('../src/lib/workspace.js', async () => (await import('./apiMock.js')).createWorkspaceMock());
vi.mock('../src/lib/theme.js', async () => (await import('./apiMock.js')).createThemeMock());
vi.mock('../src/lib/mode.js', async () => (await import('./apiMock.js')).createModeMock());
const toast = vi.hoisted(() => vi.fn());
vi.mock('../src/components/Toast.js', async () => {
  const React = await import('react');
  return {
    useToast: () => ({ toast }),
    ToastProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

type Pb = { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn> };
const pb = () => (api.system as unknown as { panelBackup: Pb }).panelBackup;

const status = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
  settings: { enabled: false, cron: '0 3 * * *', destinationId: null, retain: 7, hasPassphrase: false, ...settings },
  running: false,
  lastRun: null,
  lastSuccessAt: null,
  nextRunAt: null,
  masterKeyFromEnv: false,
  ...over,
});

const NAME = 'ninedeploy-panel-20261008T030000Z-abcdef.ndpb';

describe('PanelBackupSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'op@example.com', name: 'Op', isOperator: true },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
    mockOf(api.backupDestinations.list).mockResolvedValue([
      { id: 4, name: 'minio', endpoint: 'https://s3', region: 'us-east-1', bucket: 'b', prefix: 'nd', active: true, createdAt: '' },
    ]);
    pb().list.mockResolvedValue({ destinationId: 4, items: [] });
  });

  it('a fresh install shows it off, never run, and explains the recovery passphrase', async () => {
    pb().get.mockResolvedValue(status());
    renderWithProviders(<PanelBackupSection />);
    expect(await screen.findByText(/Keep the recovery passphrase somewhere other than this server/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Enable scheduled panel backups/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /Back up now/ })).toBeDisabled();
    expect(screen.getByText(/Last success: never/)).toBeInTheDocument();
  });

  it('will not enable without a destination and a passphrase, then saves both', async () => {
    pb().get.mockResolvedValue(status());
    pb().update.mockResolvedValue(status({}, { enabled: true, destinationId: 4, hasPassphrase: true }));
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<PanelBackupSection />);
    const save = await screen.findByRole('button', { name: /Save panel backup settings/ });
    await user.click(screen.getByRole('switch', { name: /Enable scheduled panel backups/ }));
    expect(save).toBeDisabled();
    expect(screen.getByText('Pick a destination to enable scheduled backups')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Destination'), '4');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Recovery passphrase'), 'short');
    expect(screen.getByText(/At least 12 characters/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Recovery passphrase'));
    await user.type(screen.getByLabelText('Recovery passphrase'), 'a long recovery phrase');
    await user.type(screen.getByLabelText('Repeat passphrase'), 'a long recovery phrasX');
    expect(screen.getByText(/do not match/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText('Repeat passphrase'));
    await user.type(screen.getByLabelText('Repeat passphrase'), 'a long recovery phrase');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(save);
    await waitFor(() =>
      expect(pb().update).toHaveBeenCalledWith({ enabled: true, cron: '0 3 * * *', destinationId: 4, retain: 7, passphrase: 'a long recovery phrase' }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['panel-backup-remote'] });
    expect(screen.getByLabelText('Recovery passphrase')).toHaveValue('');
  });

  it('rejects a 6-field cron before it reaches the API', async () => {
    pb().get.mockResolvedValue(status({}, { destinationId: 4, hasPassphrase: true }));
    const user = userEvent.setup();
    renderWithProviders(<PanelBackupSection />);
    const cron = await screen.findByLabelText('Schedule (cron)');
    await user.clear(cron);
    await user.type(cron, '* * * * * *');
    expect(screen.getByText(/Expected 5 fields/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save panel backup settings/ })).toBeDisabled();
  });

  it('shows a failed last run, warns about an env-supplied master key, and starts a run', async () => {
    pb().get.mockResolvedValue(
      status(
        { lastRun: { status: 'failed', trigger: 'schedule', startedAt: '2026-10-08T03:00:00Z', finishedAt: '2026-10-08T03:00:05Z', key: null, sizeBytes: null, error: 'S3 upload failed (403): AccessDenied', warning: null }, masterKeyFromEnv: true },
        { enabled: true, destinationId: 4, hasPassphrase: true },
      ),
    );
    pb().run.mockResolvedValue({ ok: true, started: true });
    const user = userEvent.setup();
    renderWithProviders(<PanelBackupSection />);
    expect(await screen.findByText(/AccessDenied/)).toBeInTheDocument();
    expect(screen.getByText(/NINEDEPLOY_MASTER_KEY\(S\), so backups do NOT contain it/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Back up now/ }));
    await waitFor(() => expect(pb().run).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Panel backup started', 'info');
  });

  it('lists remote backups and restores only with the passphrase and the typed file name', async () => {
    pb().get.mockResolvedValue(status({}, { enabled: true, destinationId: 4, hasPassphrase: true }));
    pb().list.mockResolvedValue({
      destinationId: 4,
      items: [{ key: `nd/panel-backups/${NAME}`, name: NAME, sizeBytes: 2048, lastModified: '2026-10-08T03:00:10Z' }],
    });
    pb().restore.mockResolvedValue({ ok: true, message: 'System state imported. Restart NineDeploy for changes to take effect.', meta: {}, backupPath: '/x' });
    const user = userEvent.setup();
    renderWithProviders(<PanelBackupSection />);
    expect(await screen.findByText(NAME)).toBeInTheDocument();
    expect(screen.getByText(/2(\.0)? KB/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Restore ${NAME}` }));
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: /Restore and replace this panel/ });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Backup recovery passphrase'), 'a long recovery phrase');
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Confirm backup name'), NAME);
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() =>
      expect(pb().restore).toHaveBeenCalledWith({ destinationId: 4, key: `nd/panel-backups/${NAME}`, passphrase: 'a long recovery phrase', confirm: NAME }),
    );
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Restart NineDeploy/), 'success');
    expect(pb().list).toHaveBeenCalledWith(4);
  });
});
