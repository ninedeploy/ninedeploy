import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Projects } from '../src/routes/Projects.js';
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

// Only `useTagScope` is replaced: `renderWithProviders` still mounts the real
// `ProjectScopeProvider` from the same module.
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

const project = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Acme Web',
  slug: 'acme-web',
  description: 'Marketing site',
  workspaceId: 2,
  workspaceName: 'Core',
  serviceCount: 3,
  databaseCount: 1,
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

describe('Projects route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedInAs(true);
    withWorkspaces([workspace]);
    mockOf(api.projects.list).mockResolvedValue([project()] as never);
  });

  it('lists projects with their scope, resource counts and update time', async () => {
    renderWithProviders(<Projects />);

    expect(await screen.findByText('Acme Web')).toBeInTheDocument();
    expect(screen.getByText('Marketing site')).toBeInTheDocument();
    expect(screen.getByText('/acme-web')).toBeInTheDocument();
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(screen.getByText('3 svc · 1 db')).toBeInTheDocument();
  });

  it('labels an unscoped project and omits a missing description', async () => {
    mockOf(api.projects.list).mockResolvedValue([
      project({ id: 2, name: 'Shared', workspaceId: null, description: null }),
    ] as never);
    renderWithProviders(<Projects />);

    expect(await screen.findByText('No workspace')).toBeInTheDocument();
    expect(screen.queryByText('Marketing site')).not.toBeInTheDocument();
  });

  it('scopes the tag filter to the project and navigates to the service list', async () => {
    renderWithProviders(<Projects />);
    fireEvent.click(await screen.findByText('Acme Web'));
    // `/services` reads its filter from the shared tag scope, not from a
    // query string — a `?projectId=` link would navigate but not filter.
    expect(tagScope.setProjectIds).toHaveBeenCalledWith([1]);
    expect(navigate).toHaveBeenCalledWith('/services');
  });

  it('scopes the query to the active workspace', async () => {
    withWorkspaces([workspace], workspace);
    renderWithProviders(<Projects />);
    await waitFor(() => expect(api.projects.list).toHaveBeenCalledWith('?workspaceId=2'));
  });

  it('shows the loading skeleton, then the empty state for an operator', async () => {
    let release!: (v: unknown) => void;
    mockOf(api.projects.list).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );
    const { container } = renderWithProviders(<Projects />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    release([]);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create project/ })).toBeInTheDocument();
  });

  it('tells a member to ask an operator instead of offering a create button', async () => {
    signedInAs(false);
    mockOf(api.projects.list).mockResolvedValue([] as never);
    renderWithProviders(<Projects />);

    expect(await screen.findByText(/No projects in this workspace yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create project/ })).not.toBeInTheDocument();
  });

  it('blocks a member with no workspace from creating anything', async () => {
    signedInAs(false);
    withWorkspaces([]);
    mockOf(api.projects.list).mockResolvedValue([] as never);
    renderWithProviders(<Projects />);

    expect(await screen.findByText('No workspaces yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New project/ })).toBeDisabled();
  });

  it('shows a retryable error card when the query fails', async () => {
    mockOf(api.projects.list).mockRejectedValue(new Error('403') as never);
    renderWithProviders(<Projects />);

    expect(await screen.findByText("Couldn't load projects")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockOf(api.projects.list).mock.calls.length).toBeGreaterThan(1));
  });

  it('creates a project from the modal', async () => {
    mockOf(api.projects.create).mockResolvedValue(project({ id: 9 }) as never);
    renderWithProviders(<Projects />);

    fireEvent.click(await screen.findByRole('button', { name: /New project/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Acme Web'), { target: { value: ' Billing ' } });
    fireEvent.change(screen.getByPlaceholderText('acme-web'), { target: { value: ' billing ' } });
    fireEvent.change(screen.getByPlaceholderText(/Frontend, marketing site/), {
      target: { value: ' invoices ' },
    });
    fireEvent.change(screen.getByDisplayValue('No workspace (operator-shared)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() =>
      expect(api.projects.create).toHaveBeenCalledWith({
        name: 'Billing',
        slug: 'billing',
        description: 'invoices',
        workspaceId: 2,
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Project created', 'success'));
  });

  it('omits the slug and description when they are left blank', async () => {
    mockOf(api.projects.create).mockResolvedValue(project({ id: 9 }) as never);
    renderWithProviders(<Projects />);

    fireEvent.click(await screen.findByRole('button', { name: /New project/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Acme Web'), { target: { value: 'Billing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() =>
      expect(api.projects.create).toHaveBeenCalledWith({
        name: 'Billing',
        description: null,
        workspaceId: null,
      }),
    );
  });

  it('refuses a whitespace-only name without calling the API', async () => {
    renderWithProviders(<Projects />);
    fireEvent.click(await screen.findByRole('button', { name: /New project/ }));

    // Submitting the form directly bypasses the disabled button.
    fireEvent.change(screen.getByPlaceholderText('e.g. Acme Web'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByPlaceholderText('e.g. Acme Web').closest('form')!);

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Name is required', 'error'));
    expect(api.projects.create).not.toHaveBeenCalled();
  });

  it('reports a failed create and a non-Error rejection', async () => {
    mockOf(api.projects.create).mockRejectedValueOnce(new Error('slug taken') as never);
    renderWithProviders(<Projects />);

    fireEvent.click(await screen.findByRole('button', { name: /New project/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Acme Web'), { target: { value: 'Billing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('slug taken', 'error'));

    mockOf(api.projects.create).mockRejectedValueOnce('nope' as never);
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the project', 'error'),
    );
  });

  it('edits an existing project, pre-filling the form', async () => {
    mockOf(api.projects.update).mockResolvedValue(project() as never);
    renderWithProviders(<Projects />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
    expect(screen.getByText('Edit project')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Acme Web')).toBeInTheDocument();
    // r214: the slug is shown but fixed — the update API cannot change it.
    expect(screen.getByDisplayValue('acme-web')).toBeDisabled();
    expect(screen.getByDisplayValue('Marketing site')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Acme Web'), { target: { value: 'Acme Site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.projects.update).toHaveBeenCalledWith(1, {
        name: 'Acme Site',
        description: 'Marketing site',
        workspaceId: 2,
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Project updated', 'success'));
  });

  it('pre-fills an unscoped project without a description', async () => {
    mockOf(api.projects.list).mockResolvedValue([
      project({ workspaceId: null, description: null }),
    ] as never);
    renderWithProviders(<Projects />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
    expect(screen.getByDisplayValue('No workspace (operator-shared)')).toBeInTheDocument();
  });

  it('closes the form with Cancel', async () => {
    renderWithProviders(<Projects />);
    fireEvent.click(await screen.findByRole('button', { name: /New project/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // The page header keeps its own "New project" button, so assert on a field.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('e.g. Acme Web')).not.toBeInTheDocument(),
    );
  });

  it('deletes a project after confirmation', async () => {
    mockOf(api.projects.remove).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<Projects />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
    expect(screen.getByText(/are NOT deleted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.projects.remove).toHaveBeenCalledWith(1));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith(
        'Project deleted — services inside it were detached, not removed',
        'success',
      ),
    );
  });

  it('reports a failed delete and a non-Error rejection', async () => {
    mockOf(api.projects.remove).mockRejectedValueOnce(new Error('in use') as never);
    renderWithProviders(<Projects />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('in use', 'error'));

    mockOf(api.projects.remove).mockRejectedValueOnce('nope' as never);
    // The dialog closes on the failed attempt; re-open it for the second.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Could not delete the project', 'error'),
    );
  });

  it('hides the row actions from a member', async () => {
    signedInAs(false);
    renderWithProviders(<Projects />);

    await screen.findByText('Acme Web');
    expect(screen.queryByRole('button', { name: 'Edit project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
  });
});
