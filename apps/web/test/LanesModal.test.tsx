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

vi.mock('../src/components/Toast.js', async () => {
  const React = await import('react');
  return {
    useToast: () => ({ toast: vi.fn() }),
    ToastProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
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

describe('LanesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.environments.list).mockResolvedValue([]);
    mockOf(useWorkspace).mockReturnValue({
      workspaces: [],
      currentWorkspace: { id: 10, name: 'Acme' } as never,
      isLoading: false,
      switchWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      refreshWorkspaces: vi.fn(),
    });
  });

  it('lists lanes with their service counts', async () => {
    mockOf(api.environments.list).mockResolvedValue([
      lane(),
      lane({ id: 2, name: 'staging', slug: 'staging', serviceCount: 1 }),
    ]);
    renderWithProviders(<LanesModal onClose={() => {}} />);
    expect(await screen.findByText('production')).toBeInTheDocument();
    expect(screen.getByText('3 services')).toBeInTheDocument();
    expect(screen.getByText('staging')).toBeInTheDocument();
    expect(screen.getByText('1 service')).toBeInTheDocument();
  });

  it('creates a lane in the current workspace', async () => {
    const createSpy = vi.fn().mockResolvedValue(lane({ id: 3, name: 'canary', slug: 'canary', serviceCount: 0 }));
    mockOf(api.environments.create).mockImplementation(createSpy);
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New lane name'), 'canary');
    await user.click(screen.getByRole('button', { name: /Create lane/ }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ workspaceId: 10, name: 'canary' }));
  });

  it('renames a lane', async () => {
    mockOf(api.environments.list).mockResolvedValue([lane()]);
    const renameSpy = vi.fn().mockResolvedValue(lane({ name: 'prod' }));
    mockOf(api.environments.rename).mockImplementation(renameSpy);
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Rename production'));
    const field = await screen.findByLabelText('Lane name');
    await user.clear(field);
    await user.type(field, 'prod');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(renameSpy).toHaveBeenCalledWith(1, 'prod'));
  });

  it('deletes a lane behind an inline confirm', async () => {
    mockOf(api.environments.list).mockResolvedValue([lane()]);
    const removeSpy = vi.fn().mockResolvedValue({ ok: true });
    mockOf(api.environments.remove).mockImplementation(removeSpy);
    renderWithProviders(<LanesModal onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Delete production'));
    await user.click(await screen.findByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(1));
  });
});
