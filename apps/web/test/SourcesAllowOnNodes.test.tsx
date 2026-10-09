import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Sources } from '../src/routes/Sources.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/**
 * Multi-node (owner decision O5): a PAT or deploy key may be sent to a node
 * only after an operator turns "Allow on nodes" on, which takes the password
 * re-check. Turning it off never does. Absent on an older panel.
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
  { id: 1, name: 'github-pat', type: 'github', hasToken: true, hasDeployKey: false, allowOnNodes: false, createdAt: 'x' },
  { id: 2, name: 'gitlab-key', type: 'gitlab', hasToken: false, hasDeployKey: true, allowOnNodes: true, createdAt: 'x' },
  { id: 3, name: 'ghcr', type: 'registry', hasToken: true, hasDeployKey: false, allowOnNodes: false, createdAt: 'x' },
  { id: 4, name: 'gh-app:acme', type: 'github_app', hasToken: false, hasDeployKey: false, allowOnNodes: false, createdAt: 'x' },
  { id: 5, name: 'old-panel', type: 'github', hasToken: true, hasDeployKey: false, createdAt: 'x' },
];

describe('Sources — Allow on nodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.sources.list).mockResolvedValue(SOURCES as never);
    mockOf(api.sources.update).mockResolvedValue({} as never);
  });

  it('offers the switch only on Git credentials from a panel that reports it', async () => {
    renderWithProviders(<Sources />);
    expect(await screen.findByRole('switch', { name: 'Allow github-pat on nodes' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Allow gitlab-key on nodes' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Sent to a node for each clone there.')).toBeInTheDocument();
    for (const name of ['ghcr', 'gh-app:acme', 'old-panel']) {
      expect(screen.queryByRole('switch', { name: `Allow ${name} on nodes` })).toBeNull();
    }
  });

  it('turning it on asks for the password, keeps the prompt on a wrong one, then saves', async () => {
    mockOf(api.sources.update).mockRejectedValueOnce(coded('Invalid password', 'invalid_password') as never);
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow github-pat on nodes' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow on nodes' }));
    expect(await within(dialog).findByText('Invalid password')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: PASS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow on nodes' }));
    await waitFor(() => expect(api.sources.update).toHaveBeenLastCalledWith(1, { allowOnNodes: true, password: PASS }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toastSpy.toast).toHaveBeenCalledWith('This credential may now be sent to nodes for clones', 'success');
  });

  it('an SSO account sends no password; another refusal closes the prompt and is toasted', async () => {
    mockOf(api.sources.update).mockRejectedValueOnce(coded('Allowing a credential on nodes requires an interactive session', 'forbidden') as never);
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow github-pat on nodes' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow on nodes' }));
    await waitFor(() => expect(api.sources.update).toHaveBeenCalledWith(1, { allowOnNodes: true }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Allowing a credential on nodes requires an interactive session', 'error'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel closes the prompt without saving', async () => {
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow github-pat on nodes' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.sources.update).not.toHaveBeenCalled();
  });

  it('turning it off needs no password, and a failure is toasted', async () => {
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow gitlab-key on nodes' }));
    await waitFor(() => expect(api.sources.update).toHaveBeenCalledWith(2, { allowOnNodes: false }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('This credential stays on the panel', 'success'));
    expect(screen.queryByRole('dialog')).toBeNull();
    mockOf(api.sources.update).mockRejectedValueOnce('plain' as never);
    fireEvent.click(screen.getByRole('switch', { name: 'Allow gitlab-key on nodes' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not change the setting', 'error'));
  });
});
