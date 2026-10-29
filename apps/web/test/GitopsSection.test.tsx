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

describe('GitopsSection (G5.3)', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.gitops)) mockOf(fn as never).mockReset();
    mockOf(api.sources.list).mockReset().mockResolvedValue([] as never);
  });
  it('shows the drift of the last check and applies the file', async () => {
    mockOf(api.sources.list).mockResolvedValue([] as never);
    mockOf(api.gitops.get).mockResolvedValue({
      config: CONFIG,
      lastCheck: {
        at: '2026-10-28T10:00:00Z',
        commit: 'abc1234def',
        error: null,
        drift: [
          { kind: 'service', key: 'shop/api', change: 'changed', fields: [{ field: 'image', desired: 'nginx:1.27', actual: 'nginx:1.26' }] },
          { kind: 'project', key: 'legacy', change: 'extra' },
        ],
      },
    } as never);
    mockOf(api.gitops.apply).mockResolvedValue({
      steps: [{ item: 'update service shop/api', ok: true }],
      check: { at: '2026-10-28T10:01:00Z', commit: 'abc1234def', error: null, drift: [{ kind: 'project', key: 'legacy', change: 'extra' }] },
    } as never);
    renderWithProviders(<GitopsSection />);
    expect(await screen.findByText('2 difference(s)')).toBeTruthy();
    expect(screen.getByText('image: nginx:1.26 → nginx:1.27')).toBeTruthy();
    expect((screen.getByDisplayValue(CONFIG.repoUrl) as HTMLInputElement).value).toBe(CONFIG.repoUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Apply the file' }));
    await waitFor(() => expect(api.gitops.apply).toHaveBeenCalled());
    expect(await screen.findByText(/update service shop\/api/)).toBeTruthy();
    // Only an extra item is left: there is nothing to apply.
    expect(screen.queryByRole('button', { name: 'Apply the file' })).toBeNull();
  });

  it('shows why the file could not be read', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: { at: '2026-10-28T10:00:00Z', commit: null, error: 'ninedeploy-instance.yaml is not in the repository on main', drift: [] } } as never);
    renderWithProviders(<GitopsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('not in the repository');
  });

  it('saves a public repository with default branch and path, and can check it immediately', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: null, lastCheck: null } as never);
    mockOf(api.gitops.configure).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    mockOf(api.gitops.check).mockResolvedValue({ at: '2026-10-28T10:00:00Z', commit: 'abcdef123', error: null, drift: [] } as never);
    renderWithProviders(<GitopsSection />);
    const url = await screen.findByPlaceholderText('https://github.com/acme/infrastructure');
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
    await userEvent.type(url, CONFIG.repoUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.gitops.configure).toHaveBeenCalledWith(CONFIG));
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('In sync')).toBeInTheDocument();
    expect(api.gitops.check).toHaveBeenCalledOnce();
  });

  it('shows a failed apply step and preserves the unresolved differences', async () => {
    const check = { at: '2026-10-28T10:00:00Z', commit: 'abcdef123', error: null,
      drift: [{ kind: 'service', key: 'shop/api', change: 'missing' }] };
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: check } as never);
    mockOf(api.gitops.apply).mockResolvedValue({ check, steps: [{ item: 'create shop/api', ok: false, error: 'access denied' }] } as never);
    renderWithProviders(<GitopsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apply the file' }));
    expect(await screen.findByText(/create shop\/api — access denied/)).toBeInTheDocument();
    expect(screen.getByText('1 step(s) failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply the file' })).toBeEnabled();
  });

  it('clears results from an earlier apply when a new check completes', async () => {
    const check = { at: '2026-10-28T10:00:00Z', commit: 'abcdef123', error: null,
      drift: [{ kind: 'service', key: 'shop/api', change: 'missing' }] };
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: check } as never);
    mockOf(api.gitops.apply).mockResolvedValue({ check, steps: [{ item: 'create shop/api', ok: false, error: 'access denied' }] } as never);
    mockOf(api.gitops.check).mockResolvedValue({ ...check, drift: [] } as never);
    renderWithProviders(<GitopsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apply the file' }));
    expect(await screen.findByText(/create shop\/api — access denied/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('In sync')).toBeInTheDocument();
    expect(screen.queryByText(/create shop\/api — access denied/)).not.toBeInTheDocument();
  });

  it('clears earlier apply results when updated GitOps settings are saved', async () => {
    const check = { at: '2026-10-28T10:00:00Z', commit: 'abcdef123', error: null,
      drift: [{ kind: 'service', key: 'shop/api', change: 'missing' }] };
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: check } as never);
    mockOf(api.gitops.apply).mockResolvedValue({ check, steps: [{ item: 'create shop/api', ok: false, error: 'access denied' }] } as never);
    mockOf(api.gitops.configure).mockResolvedValue({ config: CONFIG, lastCheck: check } as never);
    renderWithProviders(<GitopsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apply the file' }));
    expect(await screen.findByText(/create shop\/api — access denied/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('GitOps settings saved')).toBeInTheDocument();
    expect(screen.queryByText(/create shop\/api — access denied/)).not.toBeInTheDocument();
  });

  it('surfaces a save failure and retains the entered repository', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: null, lastCheck: null } as never);
    mockOf(api.gitops.configure).mockRejectedValue(new Error('repository denied'));
    renderWithProviders(<GitopsSection />);
    const url = await screen.findByPlaceholderText('https://github.com/acme/infrastructure');
    await userEvent.type(url, CONFIG.repoUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('repository denied')).toBeInTheDocument();
    expect(url).toHaveValue(CONFIG.repoUrl);
  });

  it('exports the instance file and releases the temporary download URL', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: null } as never);
    mockOf(api.gitops.export).mockResolvedValue({ file: 'version: "1"\nprojects: []\n' } as never);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:gitops');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      renderWithProviders(<GitopsSection />);
      await userEvent.click(await screen.findByRole('button', { name: 'Export the panel as the file' }));
      await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:gitops'));
      expect(create).toHaveBeenCalledWith(expect.any(Blob));
      expect(click).toHaveBeenCalledOnce();
    } finally {
      create.mockRestore(); revoke.mockRestore(); click.mockRestore();
    }
  });
});
