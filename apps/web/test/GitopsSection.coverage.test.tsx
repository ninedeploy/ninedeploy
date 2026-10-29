import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitopsSection } from '../src/routes/settings/GitopsSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const CONFIG = { enabled: true, repoUrl: 'https://github.com/acme/instance', branch: 'main', path: 'ninedeploy-instance.yaml', sourceId: null, intervalMinutes: 15 };
const DRIFTED = { at: '2026-10-28T10:00:00Z', commit: 'abcdef123', error: null, drift: [{ kind: 'service', key: 'shop/api', change: 'missing' }] };

describe('GitopsSection (coverage)', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.gitops)) mockOf(fn as never).mockReset();
    mockOf(api.sources.list).mockReset().mockResolvedValue([{ id: 7, name: 'acme-github' }] as never);
  });

  it('saves every edited field: branch, path, private source, interval and the schedule switch', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: null, lastCheck: null } as never);
    mockOf(api.gitops.configure).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    renderWithProviders(<GitopsSection />);
    await userEvent.type(await screen.findByPlaceholderText('https://github.com/acme/infrastructure'), '  https://github.com/acme/infra  ');
    const branch = screen.getByLabelText('Branch');
    await userEvent.clear(branch);
    await userEvent.type(branch, 'release');
    const path = screen.getByLabelText('File path');
    await userEvent.clear(path);
    await userEvent.type(path, 'ops/instance.yaml');
    await screen.findByRole('option', { name: 'acme-github' });
    await userEvent.selectOptions(screen.getByLabelText('Git source (private repositories)'), '7');
    const interval = screen.getByLabelText('Check every (minutes, 0 = on request)');
    await userEvent.clear(interval);
    await userEvent.type(interval, '60');
    await userEvent.click(screen.getByRole('switch', { name: 'Scheduled checks' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.gitops.configure).toHaveBeenCalledWith({
        enabled: false,
        repoUrl: 'https://github.com/acme/infra',
        branch: 'release',
        path: 'ops/instance.yaml',
        sourceId: 7,
        intervalMinutes: 60,
      }),
    );
  });

  it('falls back to the default branch and path when they are cleared', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    mockOf(api.gitops.configure).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    renderWithProviders(<GitopsSection />);
    await screen.findByDisplayValue(CONFIG.repoUrl);
    await userEvent.clear(screen.getByLabelText('Branch'));
    await userEvent.clear(screen.getByLabelText('File path'));
    await userEvent.clear(screen.getByLabelText('Check every (minutes, 0 = on request)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.gitops.configure).toHaveBeenCalledWith({ ...CONFIG, intervalMinutes: 0 }));
  });

  it('shows a failed check as an error toast', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    mockOf(api.gitops.check).mockRejectedValue(new Error('clone failed'));
    renderWithProviders(<GitopsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('clone failed')).toBeInTheDocument();
    expect(api.gitops.check).toHaveBeenCalledOnce();
  });

  it('reports a clean apply with a success toast and a failed apply with its error', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: DRIFTED } as never);
    mockOf(api.gitops.apply)
      .mockRejectedValueOnce('apply exploded')
      .mockResolvedValueOnce({ check: { ...DRIFTED, drift: [] }, steps: [{ item: 'create shop/api', ok: true }] } as never);
    renderWithProviders(<GitopsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apply the file' }));
    // A non-Error rejection is shown as its string form.
    expect(await screen.findByText('apply exploded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Apply the file' }));
    expect(await screen.findByText('The file was applied')).toBeInTheDocument();
    expect(screen.getByText(/✓ create shop\/api/)).toBeInTheDocument();
    expect(screen.getByText('In sync')).toBeInTheDocument();
  });

  it('shows a failed export as an error toast without starting a download', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    mockOf(api.gitops.export).mockRejectedValue(new Error('export forbidden'));
    const create = vi.spyOn(URL, 'createObjectURL');
    try {
      renderWithProviders(<GitopsSection />);
      await userEvent.click(await screen.findByRole('button', { name: 'Export the panel as the file' }));
      expect(await screen.findByText('export forbidden')).toBeInTheDocument();
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
    }
  });

  it('retries loading after the view fails', async () => {
    mockOf(api.gitops.get).mockRejectedValueOnce(new Error('panel offline')).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    renderWithProviders(<GitopsSection />);
    expect(await screen.findByText('panel offline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByDisplayValue(CONFIG.repoUrl)).toBeInTheDocument();
    expect(api.gitops.get).toHaveBeenCalledTimes(2);
  });
});
