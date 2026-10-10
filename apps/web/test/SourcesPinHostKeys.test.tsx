import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Sources } from '../src/routes/Sources.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/**
 * 0.15.8: a deploy-key source can pin its git host's SSH keys. Switching it on
 * only tightens, so it takes no password; switching it off and resetting the
 * pinned keys let a changed key through, so both take the password re-check.
 * Absent on an older panel.
 */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: { id: 1, isOperator: true }, loading: false })),
}));

const PASS = ['step', 'up', 'pw'].join('-');
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

const SOURCES = [
  { id: 1, name: 'github-key', type: 'github', hasToken: false, hasDeployKey: true, pinHostKeys: false, pinnedHostKeys: [], createdAt: 'x' },
  {
    id: 2,
    name: 'gitlab-key',
    type: 'gitlab',
    hasToken: false,
    hasDeployKey: true,
    pinHostKeys: true,
    pinnedHostKeys: [
      { host: 'gitlab.com', type: 'ssh-ed25519', fingerprint: 'SHA256:abcDEF' },
      { host: '[git.example.com]:2222', type: 'ssh-rsa', fingerprint: null },
    ],
    createdAt: 'x',
  },
  { id: 3, name: 'ghcr', type: 'registry', hasToken: true, hasDeployKey: false, pinHostKeys: false, pinnedHostKeys: [], createdAt: 'x' },
  { id: 4, name: 'gh-app:acme', type: 'github_app', hasToken: false, hasDeployKey: false, pinHostKeys: false, pinnedHostKeys: [], createdAt: 'x' },
  { id: 5, name: 'old-panel', type: 'github', hasToken: false, hasDeployKey: true, createdAt: 'x' },
  { id: 6, name: 'fresh-pin', type: 'gitea', hasToken: false, hasDeployKey: true, pinHostKeys: true, pinnedHostKeys: [], createdAt: 'x' },
];

describe('Sources — host key pinning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.sources.list).mockResolvedValue(SOURCES as never);
    mockOf(api.sources.update).mockResolvedValue({} as never);
  });

  it('offers the switch only on Git credentials from a panel that reports it', async () => {
    renderWithProviders(<Sources />);
    expect(await screen.findByRole('switch', { name: 'Pin host keys of github-key' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Pin host keys of gitlab-key' })).toHaveAttribute('aria-checked', 'true');
    for (const name of ['ghcr', 'gh-app:acme', 'old-panel']) {
      expect(screen.queryByRole('switch', { name: `Pin host keys of ${name}` })).toBeNull();
    }
  });

  it('shows fingerprints, never keys, and says what an unpinned or empty source does', async () => {
    renderWithProviders(<Sources />);
    expect(await screen.findByText('SHA256:abcDEF')).toBeInTheDocument();
    expect(screen.getByText('gitlab.com')).toBeInTheDocument();
    expect(screen.getByText('(unreadable)')).toBeInTheDocument();
    expect(screen.getByText(/first clone learns the host keys/i)).toBeInTheDocument();
  });

  it('turning it on needs no password and says so', async () => {
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Pin host keys of github-key' }));
    await waitFor(() => expect(api.sources.update).toHaveBeenCalledWith(1, { pinHostKeys: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Host keys of this source are now pinned', 'success'));
  });

  it('turning it off asks for the password, keeps the prompt on a wrong one, then saves', async () => {
    mockOf(api.sources.update).mockRejectedValueOnce(coded('Invalid password', 'invalid_password') as never);
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Pin host keys of gitlab-key' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop pinning' }));
    expect(await within(dialog).findByText('Invalid password')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: PASS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop pinning' }));
    await waitFor(() => expect(api.sources.update).toHaveBeenLastCalledWith(2, { pinHostKeys: false, password: PASS }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toastSpy.toast).toHaveBeenCalledWith('Host keys of this source are no longer pinned', 'success');
  });

  it('resetting the keys asks for the password and explains the consequence', async () => {
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset pinned keys of gitlab-key' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/whatever the Git host presents/i)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: PASS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset keys' }));
    await waitFor(() => expect(api.sources.update).toHaveBeenCalledWith(2, { resetHostKeys: true, password: PASS }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Pinned host keys forgotten; the next clone learns them again', 'success'));
  });

  it('an SSO account sends no password; another refusal closes the prompt and is toasted; Cancel saves nothing', async () => {
    mockOf(api.sources.update).mockRejectedValueOnce(coded('Switching off host key pinning requires an interactive session', 'forbidden') as never);
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Pin host keys of gitlab-key' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop pinning' }));
    await waitFor(() => expect(api.sources.update).toHaveBeenCalledWith(2, { pinHostKeys: false }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Switching off host key pinning requires an interactive session', 'error'));
    expect(screen.queryByRole('dialog')).toBeNull();

    mockOf(api.sources.update).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reset pinned keys of gitlab-key' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.sources.update).not.toHaveBeenCalled();
  });

  it('a failure turning it on is toasted', async () => {
    mockOf(api.sources.update).mockRejectedValueOnce('plain' as never);
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Pin host keys of github-key' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not change the setting', 'error'));
  });
});
