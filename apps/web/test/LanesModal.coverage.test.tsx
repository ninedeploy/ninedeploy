import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LanesModal } from '../src/components/LanesModal.js';
import { api } from '../src/lib/api.js';
import { useWorkspace } from '../src/lib/workspace.js';
import { renderWithProviders, mockOf } from './helpers.js';
import type { Environment } from '@ninedeploy/sdk';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

vi.mock('../src/lib/workspace.js', async () => {
  const { createWorkspaceMock } = await import('./apiMock.js');
  return createWorkspaceMock();
});

vi.mock('../src/lib/theme.js', async () => {
  const { createThemeMock } = await import('./apiMock.js');
  return createThemeMock();
});

vi.mock('../src/lib/mode.js', async () => {
  const { createModeMock } = await import('./apiMock.js');
  return createModeMock();
});

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/components/Toast.js', async () => {
  const React = await import('react');
  return {
    useToast: () => ({ toast: toastSpy }),
    ToastProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

const lane = (over: Partial<Environment> = {}): Environment => ({
  id: 1,
  workspaceId: 10,
  name: 'production',
  slug: 'production',
  serviceCount: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('LanesModal: failures and cancelling', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    for (const fn of Object.values(api.environments)) mockOf(fn as never).mockReset();
    mockOf(api.environments.list).mockResolvedValue([lane()]);
    mockOf(useWorkspace).mockReturnValue({
      workspaces: [],
      currentWorkspace: { id: 10, name: 'Acme' } as never,
      isLoading: false,
      switchWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      refreshWorkspaces: vi.fn(),
    });
  });

  it('toasts the server error when creating a lane fails and keeps the typed name', async () => {
    mockOf(api.environments.create).mockRejectedValue(new Error('A lane with that name exists'));
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New lane name'), 'production');
    await user.click(screen.getByRole('button', { name: /Create lane/ }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('A lane with that name exists', 'error'));
    expect(api.environments.create).toHaveBeenCalledWith({ workspaceId: 10, name: 'production' });
    expect(screen.getByLabelText('New lane name')).toHaveValue('production');
  });

  it('falls back to a generic message when a create fails without an Error', async () => {
    mockOf(api.environments.create).mockRejectedValue('nope');
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New lane name'), 'qa');
    await user.click(screen.getByRole('button', { name: /Create lane/ }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Create failed', 'error'));
  });

  it('toasts a failed rename and keeps the editor open', async () => {
    mockOf(api.environments.rename).mockRejectedValue(new Error('Insufficient role'));
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Rename production'));
    const field = await screen.findByLabelText('Lane name');
    await user.clear(field);
    await user.type(field, 'prod');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Insufficient role', 'error'));
    expect(api.environments.rename).toHaveBeenCalledWith(1, 'prod');
    expect(screen.getByLabelText('Lane name')).toHaveValue('prod');
  });

  it('cancels a rename without calling the API', async () => {
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Rename production'));
    expect(await screen.findByLabelText('Lane name')).toHaveValue('production');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Lane name')).not.toBeInTheDocument();
    expect(screen.getByText('production')).toBeInTheDocument();
    expect(api.environments.rename).not.toHaveBeenCalled();
  });

  it('toasts a failed delete', async () => {
    mockOf(api.environments.remove).mockRejectedValue(new Error('Lane has protected services'));
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Delete production'));
    await user.click(await screen.findByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Lane has protected services', 'error'));
    expect(api.environments.remove).toHaveBeenCalledWith(1);
    expect(screen.getByText('Delete lane?')).toBeInTheDocument();
  });

  it('keeps a lane when the delete confirm is dismissed', async () => {
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Delete production'));
    await user.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Delete lane?')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Delete production')).toBeInTheDocument();
    expect(api.environments.remove).not.toHaveBeenCalled();
  });
});
