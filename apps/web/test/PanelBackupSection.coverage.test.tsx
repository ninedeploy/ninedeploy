import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelBackupSection } from '../src/routes/settings/PanelBackupSection.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';

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

type Fn = ReturnType<typeof vi.fn>;
type Pb = { get: Fn; update: Fn; run: Fn; list: Fn; restore: Fn };
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
const ITEM = { key: `nd/panel-backups/${NAME}`, name: NAME, sizeBytes: 2048, lastModified: '2026-10-08T03:00:10Z' };

describe('PanelBackupSection failure paths', () => {
  beforeEach(() => {
    toast.mockReset();
    for (const fn of Object.values(pb())) fn.mockReset();
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'op@example.com', name: 'Op', isOperator: true },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
    mockOf(api.backupDestinations.list).mockReset().mockResolvedValue([
      { id: 4, name: 'minio', endpoint: 'https://s3', region: 'us-east-1', bucket: 'b', prefix: 'nd', active: true, createdAt: '' },
      { id: 9, name: 'archive', endpoint: 'https://s3', region: 'us-east-1', bucket: 'c', prefix: 'x', active: true, createdAt: '' },
    ]);
    pb().list.mockResolvedValue({ destinationId: 4, items: [] });
  });

  it('shows a load error and recovers on retry', async () => {
    pb().get.mockRejectedValueOnce(new Error('panel db locked')).mockResolvedValue(status());
    const user = userEvent.setup();
    renderWithProviders(<PanelBackupSection />);
    expect(await screen.findByText('Could not load panel backup settings')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Save panel backup settings/ })).toBeInTheDocument();
    expect(pb().get).toHaveBeenCalledTimes(2);
  });

  it('saves a changed retention and surfaces the API error', async () => {
    pb().get.mockResolvedValue(status());
    pb().update.mockRejectedValue(new Error('destination unreachable'));
    const user = userEvent.setup();
    renderWithProviders(<PanelBackupSection />);
    const keep = await screen.findByLabelText('Keep');
    await user.clear(keep);
    await user.type(keep, '400');
    expect(screen.getByText('Between 1 and 365')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save panel backup settings/ })).toBeDisabled();
    await user.clear(keep);
    await user.type(keep, '14');
    await user.click(screen.getByRole('button', { name: /Save panel backup settings/ }));
    await waitFor(() => expect(pb().update).toHaveBeenCalledWith({ enabled: false, cron: '0 3 * * *', destinationId: null, retain: 14 }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('destination unreachable', 'error'));
  });

  it('falls back to a generic message when a run cannot start', async () => {
    pb().get.mockResolvedValue(status({}, { destinationId: 4, hasPassphrase: true }));
    pb().run.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    renderWithProviders(<PanelBackupSection />);
    await user.click(await screen.findByRole('button', { name: /Back up now/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Could not start the panel backup', 'error'));
  });

  it('lists another destination, retries a failed listing, and reports a failed restore', async () => {
    pb().get.mockResolvedValue(status());
    pb().list.mockRejectedValueOnce(new Error('403 AccessDenied')).mockResolvedValue({ destinationId: 9, items: [ITEM] });
    pb().restore.mockRejectedValue(new Error('wrong passphrase'));
    const user = userEvent.setup();
    renderWithProviders(<PanelBackupSection />);
    expect(await screen.findByText('Pick a destination to see its panel backups.')).toBeInTheDocument();
    expect(pb().list).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('List destination'), '9');
    expect(await screen.findByText('Could not list panel backups')).toBeInTheDocument();
    expect(pb().list).toHaveBeenCalledWith(9);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(NAME)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Restore ${NAME}` }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Backup recovery passphrase'), 'not the phrase');
    await user.type(within(dialog).getByLabelText('Confirm backup name'), NAME);
    await user.click(within(dialog).getByRole('button', { name: /Restore and replace this panel/ }));
    await waitFor(() =>
      expect(pb().restore).toHaveBeenCalledWith({ destinationId: 9, key: ITEM.key, passphrase: 'not the phrase', confirm: NAME }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('wrong passphrase', 'error'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
