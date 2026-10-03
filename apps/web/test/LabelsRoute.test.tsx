import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Labels } from '../src/routes/Labels.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { useWorkspace } from '../src/lib/workspace.js';
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
vi.mock('../src/lib/workspace.js', async () => {
  const { createWorkspaceMock } = await import('./apiMock.js');
  return createWorkspaceMock();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigate };
});

// Only `useTagScope` is replaced; `renderWithProviders` still mounts the real
// `ProjectScopeProvider` exported from the same module.
const tagScope = vi.hoisted(() => ({
  workspaceIds: [] as number[],
  projectIds: [] as number[],
  labelIds: [] as number[],
  setWorkspaceIds: vi.fn(),
  setProjectIds: vi.fn(),
  setLabelIds: vi.fn(),
  clearAll: vi.fn(),
  isFiltered: false,
}));
vi.mock('../src/lib/projects.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/projects.js')>('../src/lib/projects.js');
  return { ...actual, useTagScope: () => tagScope };
});

const workspace = { id: 2, name: 'Core', slug: 'core', role: 'owner' };

const label = (over: Record<string, unknown> = {}) => ({
  id: 1,
  workspaceId: 2,
  name: 'production',
  color: 'emerald',
  serviceCount: 4,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
  ...over,
});

const signedInAs = (isOperator: boolean) =>
  mockOf(useAuth).mockReturnValue({ user: { id: 1, isOperator }, loading: false } as never);

const withWorkspaces = (workspaces: unknown[], currentWorkspace: unknown = null) =>
  mockOf(useWorkspace).mockReturnValue({
    workspaces,
    currentWorkspace,
    isLoading: false,
    switchWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
  } as never);

describe('Labels route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedInAs(true);
    withWorkspaces([workspace]);
    mockOf(api.labels.list).mockResolvedValue([label()] as never);
  });

  it('lists labels with their scope, service count and update time', async () => {
    renderWithProviders(<Labels />);

    expect(await screen.findByText('production')).toBeInTheDocument();
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(screen.getByText('4 svc')).toBeInTheDocument();
  });

  it('labels an unscoped row and falls back to indigo for an unknown colour', async () => {
    mockOf(api.labels.list).mockResolvedValue([
      label({ id: 2, name: 'shared', workspaceId: null, color: 'chartreuse' }),
    ] as never);
    renderWithProviders(<Labels />);

    expect(await screen.findByText('No workspace')).toBeInTheDocument();
    // Unknown palette tokens must not reach the DOM as a class name.
    const chip = screen.getByText('shared').closest('span');
    expect(chip?.className).toContain('indigo');
  });

  it('scopes the tag filter to the label and navigates to the service list', async () => {
    renderWithProviders(<Labels />);
    fireEvent.click(await screen.findByText('production'));
    expect(tagScope.setLabelIds).toHaveBeenCalledWith([1]);
    expect(navigate).toHaveBeenCalledWith('/services');
  });

  it('scopes the query to the active workspace', async () => {
    withWorkspaces([workspace], workspace);
    renderWithProviders(<Labels />);
    await waitFor(() => expect(api.labels.list).toHaveBeenCalledWith('?workspaceId=2'));
  });

  it('shows the loading skeleton, then the empty state', async () => {
    let release!: (v: unknown) => void;
    mockOf(api.labels.list).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );
    const { container } = renderWithProviders(<Labels />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    release([]);
    expect(await screen.findByText('No labels yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create label/ })).toBeInTheDocument();
  });

  it('shows a retryable error card when the query fails', async () => {
    mockOf(api.labels.list).mockRejectedValueOnce(new Error('403') as never);
    renderWithProviders(<Labels />);
    expect(await screen.findByText("Couldn't load labels")).toBeInTheDocument();

    // Retry re-runs the query; the resolved second attempt restores the list.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('production')).toBeInTheDocument();
  });

  it('creates a label with the chosen colour and workspace', async () => {
    mockOf(api.labels.create).mockResolvedValue(label({ id: 9, name: 'staging' }) as never);
    withWorkspaces([workspace], workspace);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: /New label/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'staging' } });
    fireEvent.click(screen.getByRole('button', { name: 'amber' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create label' }));

    await waitFor(() =>
      expect(api.labels.create).toHaveBeenCalledWith({ name: 'staging', color: 'amber', workspaceId: 2 }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Label created', 'success'));
  });

  it('creates an operator-shared label when no workspace is selected', async () => {
    mockOf(api.labels.create).mockResolvedValue(label({ id: 9 }) as never);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: /New label/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'edge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create label' }));

    await waitFor(() =>
      expect(api.labels.create).toHaveBeenCalledWith({ name: 'edge', color: 'indigo', workspaceId: null }),
    );
  });

  it('moves the create form between operator-shared and workspace scopes via the select', async () => {
    mockOf(api.labels.create).mockResolvedValue(label({ id: 10 }) as never);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: /New label/ }));
    const formRoot = screen.getByText('Workspace').closest('div')?.parentElement ?? document.body;
    const scopeSelect = formRoot.querySelector('select');
    if (!scopeSelect) throw new Error('workspace select not rendered');
    expect(scopeSelect.value).toBe('');

    // '' → number: scope the draft to Core.
    fireEvent.change(scopeSelect, { target: { value: '2' } });
    expect(scopeSelect.value).toBe('2');
    // Back to '': operator-shared again.
    fireEvent.change(scopeSelect, { target: { value: '' } });
    expect(scopeSelect.value).toBe('');
  });

  it('surfaces a create failure without closing the form', async () => {
    mockOf(api.labels.create).mockRejectedValue(new Error('duplicate name') as never);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: /New label/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'production' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create label' }));

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('duplicate name', 'error'));
    expect(screen.getByRole('button', { name: 'Create label' })).toBeInTheDocument();
  });

  it('edits a label without offering to move it between workspaces', async () => {
    mockOf(api.labels.update).mockResolvedValue(label({ name: 'prod' }) as never);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit label' }));
    // The workspace select is create-only: a label's scope is fixed.
    expect(screen.queryByText('No workspace (operator-shared)')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'prod' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.labels.update).toHaveBeenCalledWith(1, { name: 'prod', color: 'emerald' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Label updated', 'success'));
  });

  it('closes the form without saving when Cancel is pressed', async () => {
    renderWithProviders(<Labels />);
    fireEvent.click(await screen.findByRole('button', { name: /New label/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create label' })).not.toBeInTheDocument());
    expect(api.labels.create).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only name before calling the API', async () => {
    renderWithProviders(<Labels />);
    fireEvent.click(await screen.findByRole('button', { name: /New label/ }));
    const input = screen.getByPlaceholderText('e.g. production');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Name is required', 'error'));
    expect(api.labels.create).not.toHaveBeenCalled();
  });

  it('deletes a label after confirmation and says the services survived', async () => {
    mockOf(api.labels.remove).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete label' }));
    expect(await screen.findByText(/removed from the 4 service\(s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.labels.remove).toHaveBeenCalledWith(1));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith(
        'Label deleted — the services that carried it were untouched',
        'success',
      ),
    );
  });

  it('surfaces a delete failure', async () => {
    mockOf(api.labels.remove).mockRejectedValue(new Error('still in use') as never);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete label' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('still in use', 'error'));
  });

  it('falls back to a generic message when the failure is not an Error', async () => {
    mockOf(api.labels.create).mockRejectedValue('nope' as never);
    mockOf(api.labels.remove).mockRejectedValue('nope' as never);
    renderWithProviders(<Labels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete label' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not delete the label', 'error'));

    fireEvent.click(screen.getByRole('button', { name: /New label/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create label' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the label', 'error'));
  });

  it('treats a null list from the API as empty', async () => {
    mockOf(api.labels.list).mockResolvedValue(null as never);
    renderWithProviders(<Labels />);
    expect(await screen.findByText('No labels yet')).toBeInTheDocument();
  });
});
