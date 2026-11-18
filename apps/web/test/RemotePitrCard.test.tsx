import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDetail, PitrStatus, RemotePitrStatus } from '@ninedeploy/sdk';
import { createQueryClient, deferred, renderWithProviders } from './web-utils.js';

const h = vi.hoisted(() => ({
  operator: true,
  user: true,
  local: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  ship: vi.fn(),
  destinations: vi.fn(),
}));
vi.mock('../src/lib/auth.js', () => ({ useAuth: () => ({ user: h.user ? { id: 1, isOperator: h.operator } : null }) }));
vi.mock('../src/lib/api.js', () => ({
  api: {
    databases: { pitr: { get: h.local, remote: { get: h.get, set: h.set, checkpoint: h.ship } } },
    backupDestinations: { list: h.destinations },
  },
}));
import { RemotePitrCard } from '../src/routes/database/RemotePitrCard.js';
import { ToastProvider } from '../src/components/Toast.js';

const db = { id: 7, engine: 'postgres', serverId: 3 } as DatabaseDetail;
const local = {
  available: true,
  enabled: true,
  baseBackupRunning: false,
  baseBackups: [{ label: 'nd-20261117T090000000Z' }],
} as PitrStatus;
const empty: RemotePitrStatus = {
  settings: null,
  hasPassphrase: false,
  running: false,
  state: null,
  stream: null,
  archiveLagSeconds: null,
  retention: 'Remote checkpoints are not deleted automatically.',
};
const configured: RemotePitrStatus = {
  ...empty,
  settings: { enabled: true, mode: 'continuous', destinationId: 2, intervalMinutes: 15, remoteRetentionDays: 7, archiveId: 'archive-1' },
  hasPassphrase: true,
};
const verified: RemotePitrStatus = {
  ...configured,
  archiveLagSeconds: 0,
  stream: {
    archiveId: 'archive-1',
    status: 'completed',
    attemptedAt: '2026-11-17T09:00:00Z',
    error: null,
    missingSegment: null,
    gcPending: 4,
    protection: {
      sequence: 3,
      headKey: 'off-host/pitr-streams/archive-1/head.ndpi',
      catalogKey: 'catalog/3.ndcat',
      verifiedAt: '2026-11-17T09:00:00Z',
      headSha256: 'sha',
      headBytes: 100,
      baseLabel: 'base',
      lastSegment: '000000010000000000000004',
      from: '2026-11-17T08:00:00Z',
      through: '2026-11-17T09:00:00Z',
      ranges: [
        { from: '2026-11-17T08:00:00Z', through: '2026-11-17T08:30:00Z' },
        { from: '2026-11-17T08:20:00Z', through: '2026-11-17T09:00:00Z' },
      ],
    },
  },
};
const passphrase = 'operator-kept-recovery-passphrase';
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => screen.getByRole('button', { name: 'Save remote archive' });
function renderCard(row = db, qc = createQueryClient()) {
  return renderWithProviders(<RemotePitrCard db={row} />, { queryClient: qc, wrapper: c => <ToastProvider>{c}</ToastProvider> });
}
async function loaded(s = empty) {
  h.get.mockResolvedValue(s);
  const view = renderCard();
  await screen.findByLabelText('Archive destination');
  return view;
}
function secret(value = passphrase) {
  change('Recovery passphrase', value);
  change('Confirm recovery passphrase', value);
}

beforeEach(() => {
  h.operator = true;
  h.user = true;
  for (const fn of [h.local, h.get, h.set, h.ship, h.destinations]) fn.mockReset();
  h.local.mockResolvedValue(local);
  h.get.mockResolvedValue(empty);
  h.destinations.mockResolvedValue([
    { id: 2, name: 'Off-site', endpoint: 'https://s3.test', region: 'eu', bucket: 'recovery', prefix: 'nine' },
    { id: 3, name: 'Elsewhere', endpoint: 'https://other.test', region: 'us', bucket: 'other', prefix: '' },
    { id: 4, name: 'Insecure', endpoint: 'http://s3.test', region: 'eu', bucket: 'unsafe', prefix: '' },
  ]);
});
afterEach(() => vi.useRealTimers());

describe('RemotePitrCard', () => {
  it('keeps orphan discovery opt-in, sends it explicitly and clears it in checkpoint mode', async () => {
    await loaded(configured);
    const toggle = screen.getByRole('switch', { name: 'Collect abandoned uploads' });
    expect(toggle).toHaveAttribute('aria-checked', 'false'); fireEvent.click(toggle);
    h.set.mockResolvedValue({ ...configured, settings: { ...configured.settings!, collectOrphans: true } }); fireEvent.click(save());
    await waitFor(() => expect(h.set).toHaveBeenCalledWith(7, expect.objectContaining({ collectOrphans: true })));
    change('Archive mode', 'checkpoint');
    expect(screen.queryByRole('switch', { name: 'Collect abandoned uploads' })).not.toBeInTheDocument();
    fireEvent.click(save()); h.set.mockResolvedValue(empty); fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledTimes(2)); expect(h.set.mock.calls[1]![1]).not.toHaveProperty('collectOrphans');
  });
  it('discards the secret and draft across database navigation and operator-role changes', async () => {
    h.get.mockResolvedValue(configured);
    const qc = createQueryClient();
    const view = render(<RemotePitrCard db={db} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      ),
    });
    await screen.findByLabelText('Archive destination');
    secret();
    change('Remote retention (days)', '21');
    const other = { ...configured, settings: { ...configured.settings!, destinationId: 3 } };
    h.get.mockResolvedValue(other);
    view.rerender(<RemotePitrCard db={{ ...db, id: 8 }} />);
    await waitFor(() => expect(screen.getByLabelText('Archive destination')).toHaveValue('3'));
    expect(screen.getByLabelText('Recovery passphrase')).toHaveValue('');
    expect(screen.getByLabelText('Remote retention (days)')).toHaveValue('7');
    change('Remote retention (days)', '9');
    h.set.mockResolvedValue(other);
    fireEvent.click(save());
    await waitFor(() =>
      expect(h.set).toHaveBeenCalledWith(8, {
        enabled: true,
        destinationId: 3,
        mode: 'continuous',
        intervalMinutes: 15,
        remoteRetentionDays: 9,
      }),
    );
    secret();
    h.operator = false;
    view.rerender(<RemotePitrCard db={{ ...db, id: 8 }} />);
    expect(screen.queryByLabelText('Recovery passphrase')).not.toBeInTheDocument();
    h.operator = true;
    view.rerender(<RemotePitrCard db={{ ...db, id: 8 }} />);
    expect(await screen.findByLabelText('Recovery passphrase')).toHaveValue('');
  });
  it.each(['viewer', 'signed out', 'another engine'])('asks nothing and reveals nothing for %s, including cached data', async role => {
    h.operator = role !== 'viewer';
    h.user = role !== 'signed out';
    const qc = createQueryClient();
    qc.setQueryData(['database-pitr-remote', 7], verified);
    const view = renderCard({ ...db, engine: role === 'another engine' ? 'mysql' : 'postgres' }, qc);
    expect(view.container).toHaveTextContent('');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.local).not.toHaveBeenCalled();
    expect(h.destinations).not.toHaveBeenCalled();
  });
  it('shows loading and retries an explicit status refusal without rendering stale controls', async () => {
    const gate = deferred<RemotePitrStatus>();
    h.get.mockReturnValueOnce(gate.promise);
    renderCard();
    expect(screen.getByText('Remote PostgreSQL archive')).toBeInTheDocument();
    expect(screen.queryByLabelText('Recovery passphrase')).not.toBeInTheDocument();
    await act(async () => gate.reject(new Error('Database admin access required')));
    expect(await screen.findByText(/Could not load remote archive status/)).toHaveTextContent('Database admin access required');
    h.get.mockResolvedValue(empty);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Archive mode')).toHaveValue('continuous');
  });
  it('enables continuous shipment with bounded retention and matching passphrases; clears secrets on success', async () => {
    const view = await loaded();
    expect(screen.getByText('No verified remote archive yet')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    change('Archive destination', '2');
    fireEvent.click(screen.getByRole('switch', { name: 'Remote archiving' }));
    secret('short');
    expect(save()).toBeDisabled();
    expect(screen.getByText('Use 16–1024 characters.')).toBeInTheDocument();
    change('Recovery passphrase', passphrase);
    expect(save()).toBeDisabled();
    expect(screen.getByText('The passphrases must match.')).toBeInTheDocument();
    change('Confirm recovery passphrase', passphrase);
    change('Remote retention (days)', '36');
    expect(save()).toBeDisabled();
    change('Remote retention (days)', '0');
    expect(save()).toBeDisabled();
    change('Remote retention (days)', '14');
    h.set.mockResolvedValue({ ...configured, settings: { ...configured.settings!, remoteRetentionDays: 14 } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(h.set).toHaveBeenCalledWith(7, {
        enabled: true,
        destinationId: 2,
        mode: 'continuous',
        intervalMinutes: 15,
        remoteRetentionDays: 14,
        passphrase,
      }),
    );
    expect(await screen.findByText('Remote archive settings saved')).toBeInTheDocument();
    expect(screen.getByLabelText('Recovery passphrase')).toHaveValue('');
    expect(screen.getByLabelText('Confirm recovery passphrase')).toHaveValue('');
    expect(
      view.queryClient
        .getMutationCache()
        .getAll()
        .every(m => m.state.variables === undefined),
    ).toBe(true);
    expect(JSON.stringify(view.queryClient.getQueryData(['database-pitr-remote', 7]))).not.toContain(passphrase);
  });
  it('refuses non-HTTPS destinations and enables a valid destination', async () => {
    await loaded();
    change('Archive destination', '4');
    fireEvent.click(screen.getByRole('switch', { name: 'Remote archiving' }));
    secret();
    expect(screen.getByText('An HTTPS destination is required.')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    change('Archive destination', '2');
    expect(save()).toBeEnabled();
  });
  it('keeps legacy checkpoint mode and the stored secret; enforces its interval', async () => {
    await loaded({ ...configured, settings: { enabled: true, destinationId: 2, intervalMinutes: 30 } });
    expect(screen.getByLabelText('Archive mode')).toHaveValue('checkpoint');
    change('Checkpoint interval (minutes)', '14');
    expect(save()).toBeDisabled();
    change('Checkpoint interval (minutes)', '1441');
    expect(save()).toBeDisabled();
    change('Checkpoint interval (minutes)', '60');
    h.set.mockResolvedValue(empty);
    fireEvent.click(save());
    await waitFor(() =>
      expect(h.set).toHaveBeenCalledWith(7, {
        enabled: true,
        destinationId: 2,
        mode: 'checkpoint',
        intervalMinutes: 60,
        remoteRetentionDays: 7,
      }),
    );
  });
  it('preserves unsaved edits during background status updates and can discard them', async () => {
    const view = await loaded(configured);
    change('Remote retention (days)', '20');
    secret();
    await act(async () => {
      view.queryClient.setQueryData(['database-pitr-remote', 7], verified);
    });
    expect(screen.getByLabelText('Remote retention (days)')).toHaveValue('20');
    expect(screen.getByLabelText('Recovery passphrase')).toHaveValue(passphrase);
    expect(screen.getByRole('button', { name: 'Ship archive now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Remote retention (days)')).toHaveValue('7');
    expect(screen.getByLabelText('Recovery passphrase')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Ship archive now' })).toBeEnabled();
  });
  it.each(['destination', 'mode', 'passphrase'])('reviews changed %s before saving recovery details', async field => {
    await loaded(verified);
    if (field === 'destination') change('Archive destination', '3');
    if (field === 'mode') change('Archive mode', 'checkpoint');
    if (field === 'passphrase') secret();
    fireEvent.click(save());
    expect(await screen.findByText('Change remote archive recovery details?')).toBeInTheDocument();
    expect(h.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.set).not.toHaveBeenCalled();
    fireEvent.click(save());
    h.set.mockResolvedValue(configured);
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledTimes(1));
  });
  it('shows failed shipment details alongside the last verified ranges, exact key and zero archive age', async () => {
    await loaded({
      ...verified,
      stream: { ...verified.stream!, status: 'failed', error: 'Node disconnected', missingSegment: '000000010000000000000005' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Node disconnected');
    expect(screen.getByText(/Missing WAL segment/)).toHaveTextContent('000000010000000000000005');
    expect(screen.getByText(verified.stream!.protection!.headKey)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('Objects awaiting cleanup: 4')).toBeInTheDocument();
  });
  it('shows checkpoint recovery details with their original destination', async () => {
    const point = {
      key: 'checkpoints/main/old.ndpc',
      destinationId: 9,
      verifiedAt: '2026-11-17T09:00:00Z',
      from: '2026-11-17T08:00:00Z',
      through: '2026-11-17T09:00:00Z',
      sha256: 'sha',
      bytes: 2048,
    };
    await loaded({
      ...configured,
      settings: { ...configured.settings!, mode: 'checkpoint' },
      state: { status: 'completed', attemptedAt: point.verifiedAt, error: null, missingSegment: null, lastSuccess: point },
    });
    expect(screen.getByText(point.key)).toBeInTheDocument();
    expect(screen.getByText(/Checkpoint destination #9/)).toBeInTheDocument();
    expect(screen.queryByText(/Objects awaiting cleanup/)).not.toBeInTheDocument();
  });
  it('can pause when the source or saved destination is unavailable, retaining the stored destination id', async () => {
    h.local.mockResolvedValue({ ...local, available: false, unavailableReason: 'Agent disabled' });
    h.destinations.mockRejectedValue(new Error('Offline'));
    await loaded(configured);
    expect(screen.getByText('Agent disabled')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Remote archiving' }));
    expect(save()).toBeEnabled();
    h.set.mockResolvedValue({ ...configured, settings: { ...configured.settings!, enabled: false } });
    fireEvent.click(save());
    await waitFor(() => expect(h.set).toHaveBeenCalledWith(7, expect.objectContaining({ enabled: false, destinationId: 2 })));
    h.destinations.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry destinations' }));
    expect(await screen.findByText('Create an HTTPS S3 destination in Settings → Backup destinations.')).toBeInTheDocument();
  });
  it('shows a source status failure, and blocks enabling or shipping until a first base exists', async () => {
    h.local.mockRejectedValue(new Error('Node offline'));
    await loaded(configured);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not verify local archiving');
    expect(screen.getByRole('button', { name: 'Ship archive now' })).toBeDisabled();
  });
  it.each([true, false])('waits for the first usable base (backup running: %s)', async running => {
    h.local.mockResolvedValue({ ...local, baseBackupRunning: running, baseBackups: running ? local.baseBackups : [] });
    await loaded(configured);
    expect(screen.getByRole('button', { name: 'Ship archive now' })).toBeDisabled();
  });
  it('treats 202 as admission only, polls to a verified completion and keeps edits while polling', async () => {
    vi.useFakeTimers();
    h.get.mockResolvedValue(configured);
    const view = renderCard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    h.ship.mockResolvedValue({ started: true });
    h.get.mockResolvedValue({ ...configured, running: true });
    fireEvent.click(screen.getByRole('button', { name: 'Ship archive now' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('Shipment started; verification is pending.')).toBeInTheDocument();
    expect(screen.getByText('Shipping; not yet verified')).toBeInTheDocument();
    expect(screen.getByText('No verified remote archive yet')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ship archive now' })).toBeDisabled();
    h.get.mockResolvedValue(verified);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(screen.getByText(verified.stream!.protection!.headKey)).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledTimes(3);
    change('Remote retention (days)', '21');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(h.get).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText('Remote retention (days)')).toHaveValue('21');
    view.unmount();
  });
  it('does not let invalid hidden settings block a different archive mode', async () => {
    await loaded(configured);
    change('Remote retention (days)', '36');
    expect(save()).toBeDisabled();
    change('Archive mode', 'checkpoint');
    expect(save()).toBeEnabled();
    change('Checkpoint interval (minutes)', '14');
    expect(save()).toBeDisabled();
    change('Archive mode', 'continuous');
    change('Remote retention (days)', '8');
    expect(save()).toBeEnabled();
  });
  it('reports save and shipment failures without claiming a successful archive', async () => {
    await loaded(configured);
    h.ship.mockRejectedValue(new Error('Archive source is busy'));
    fireEvent.click(screen.getByRole('button', { name: 'Ship archive now' }));
    expect(await screen.findByText('Archive source is busy')).toBeInTheDocument();
    change('Remote retention (days)', '12');
    h.set.mockRejectedValue('unconfirmed');
    fireEvent.click(save());
    expect(await screen.findByText('The remote archive request failed.')).toBeInTheDocument();
    expect(screen.getByLabelText('Remote retention (days)')).toHaveValue('12');
  });
});
