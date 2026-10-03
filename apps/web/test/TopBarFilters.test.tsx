import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { TopBarFilters } from '../src/components/TopBarFilters.js';
import { TagScopeProvider } from '../src/lib/projects.js';
import { ToastProvider } from '../src/components/Toast.js';
import { useAuth } from '../src/lib/auth.js';
import { useWorkspace } from '../src/lib/workspace.js';
import { mockOf } from './helpers.js';

/**
 * This suite drives the real `src/lib/api.ts` through a stubbed `fetch`
 * instead of mocking the api module.
 *
 * TopBarFilters and TagScopeProvider load the api module with a dynamic
 * `import()` inside their query functions. Under vitest those concurrent
 * dynamic imports do not reliably resolve to a `vi.mock`'d module — in one
 * render some queries get the mock and others get the real module — so
 * module-level mocking makes this component's tests flaky. Stubbing the
 * transport is one layer lower and always wins.
 */
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

const workspace = { id: 2, name: 'Core', slug: 'core', role: 'owner' };
const project = { id: 5, name: 'Acme', slug: 'acme', workspaceName: 'Core' };
const label = { id: 7, name: 'production', color: 'rose', workspaceId: 2 };

const switchWorkspace = vi.fn();

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

let requests: RecordedRequest[] = [];
let routes: Record<string, unknown>;
/** When set, POST /v1/labels answers with this error message instead. */
let createLabelFailure: string | undefined;

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

function installFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body == null ? undefined : JSON.parse(String(init.body));
    requests.push({ url, method, body });

    if (method === 'POST' && url.startsWith('/v1/labels')) {
      if (createLabelFailure !== undefined) {
        return jsonResponse(400, { error: { message: createLabelFailure } });
      }
      const created = { id: 8, ...(body as Record<string, unknown>) };
      routes['/v1/labels'] = [...(routes['/v1/labels'] as unknown[]), created];
      return jsonResponse(200, created);
    }
    const key = url.split('?')[0] ?? url;
    return jsonResponse(200, routes[key] ?? []);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderFilters() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TagScopeProvider>
        <MemoryRouter>
          <ToastProvider>
            <TopBarFilters />
          </ToastProvider>
        </MemoryRouter>
      </TagScopeProvider>
    </QueryClientProvider>,
  );
}

/** Read the persisted chip scope back out of localStorage. */
const storedScope = () => JSON.parse(localStorage.getItem('ninedeploy.tagScope') ?? '{}');

const signedInAs = (isOperator: boolean) =>
  mockOf(useAuth).mockReturnValue({ user: { id: 1, isOperator }, loading: false } as never);

const withWorkspaces = (workspaces: unknown[], currentWorkspace: unknown = null) =>
  mockOf(useWorkspace).mockReturnValue({
    workspaces,
    currentWorkspace,
    isLoading: false,
    switchWorkspace,
    createWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
  } as never);

describe('TopBarFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    requests = [];
    createLabelFailure = undefined;
    routes = { '/v1/projects': [project], '/v1/labels': [label], '/v1/workspaces': [workspace] };
    signedInAs(true);
    withWorkspaces([workspace]);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the three chip groups in their unfiltered state', async () => {
    renderFilters();
    expect(await screen.findByRole('button', { name: /Workspace\s*All/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Project\s*Any/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Label\s*Any/ })).toBeInTheDocument();
    // Nothing selected → no "Clear all".
    expect(screen.queryByText('Clear all')).not.toBeInTheDocument();
  });

  it('switches the active workspace and records it in the scope', async () => {
    renderFilters();
    fireEvent.click(await screen.findByRole('button', { name: /Workspace\s*All/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Core/ }));

    expect(switchWorkspace).toHaveBeenCalledWith(2);
    await waitFor(() => expect(storedScope().workspaceIds).toEqual([2]));
  });

  it('clears the workspace group from its popover', async () => {
    renderFilters();
    fireEvent.click(await screen.findByRole('button', { name: /Workspace\s*All/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Core/ }));
    await waitFor(() => expect(storedScope().workspaceIds).toEqual([2]));

    // Selecting leaves the popover open, so Clear is reachable straight away.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());
  });

  it('toggles a project chip on and clears every group at once', async () => {
    renderFilters();
    fireEvent.click(await screen.findByRole('button', { name: /Project\s*Any/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Acme/ }));
    await waitFor(() => expect(storedScope().projectIds).toEqual([5]));

    fireEvent.click(await screen.findByText('Clear all'));
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());
  });

  it('removes a project chip with its own control, then via the group Clear', async () => {
    renderFilters();
    fireEvent.click(await screen.findByRole('button', { name: /Project\s*Any/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Acme/ }));
    await waitFor(() => expect(storedScope().projectIds).toEqual([5]));

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());

    // The popover is still open — re-select, then empty the group from Clear.
    fireEvent.click(await screen.findByRole('button', { name: /Acme/ }));
    await waitFor(() => expect(storedScope().projectIds).toEqual([5]));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());
  });

  it('toggles a label chip and removes it again', async () => {
    renderFilters();
    fireEvent.click(await screen.findByRole('button', { name: /Label\s*Any/ }));
    fireEvent.click(await screen.findByRole('button', { name: /production/ }));
    await waitFor(() => expect(storedScope().labelIds).toEqual([7]));

    fireEvent.click(screen.getByRole('button', { name: 'Remove label filter' }));
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());

    // The popover is still open — re-select, then empty the group from Clear.
    fireEvent.click(await screen.findByRole('button', { name: /production/ }));
    await waitFor(() => expect(storedScope().labelIds).toEqual([7]));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());
  });

  it('creates a global label inline and selects it', async () => {
    renderFilters();

    fireEvent.click(await screen.findByRole('button', { name: /Label\s*Any/ }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. production'), { target: { value: ' staging ' } });
    fireEvent.change(screen.getByDisplayValue('indigo'), { target: { value: 'sky' } });
    // The create control is the icon-only button in the creator row.
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '')!);

    await waitFor(() => {
      const post = requests.find((r) => r.method === 'POST' && r.url.startsWith('/v1/labels'));
      expect(post?.body).toEqual({ name: 'staging', color: 'sky', workspaceId: null });
    });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Label "staging" created', 'success'));
    await waitFor(() => expect(storedScope().labelIds).toEqual([8]));
  });

  it('creates a label with the Enter key, scoped to the current workspace', async () => {
    withWorkspaces([workspace], workspace);
    renderFilters();

    fireEvent.click(await screen.findByRole('button', { name: /Label\s*Any/ }));
    const input = await screen.findByPlaceholderText('e.g. production');
    fireEvent.change(input, { target: { value: 'staging' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const post = requests.find((r) => r.method === 'POST' && r.url.startsWith('/v1/labels'));
      expect(post?.body).toEqual({ name: 'staging', color: 'indigo', workspaceId: 2 });
    });
  });

  it('reports a failed label creation', async () => {
    createLabelFailure = 'label taken';
    renderFilters();

    fireEvent.click(await screen.findByRole('button', { name: /Label\s*Any/ }));
    const input = await screen.findByPlaceholderText('e.g. production');
    fireEvent.change(input, { target: { value: 'dup' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('label taken', 'error'));
  });

  it('ignores a non-Enter key and refuses an empty label name', async () => {
    renderFilters();
    fireEvent.click(await screen.findByRole('button', { name: /Label\s*Any/ }));
    const input = await screen.findByPlaceholderText('e.g. production');

    fireEvent.keyDown(input, { key: 'a' });
    // A whitespace-only name never reaches the API.
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Label name is required', 'error'));
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('shows the empty states when nothing is available', async () => {
    routes = { '/v1/projects': [], '/v1/labels': [], '/v1/workspaces': [] };
    withWorkspaces([]);
    renderFilters();

    fireEvent.click(await screen.findByRole('button', { name: /Workspace\s*All/ }));
    expect(await screen.findByText('No workspaces')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Project\s*Any/ }));
    expect(await screen.findByText('No projects in this workspace')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Label\s*Any/ }));
    expect(await screen.findByText('No labels yet')).toBeInTheDocument();
  });

  it('hides the inline label creator from a member with no current workspace', async () => {
    signedInAs(false);
    renderFilters();

    fireEvent.click(await screen.findByRole('button', { name: /Label\s*Any/ }));
    await screen.findByText('production');
    expect(screen.queryByPlaceholderText('e.g. production')).not.toBeInTheDocument();
  });

  it('scopes the project and label queries to the current workspace', async () => {
    withWorkspaces([workspace], workspace);
    renderFilters();

    await waitFor(() => expect(requests.some((r) => r.url === '/v1/projects?workspaceId=2')).toBe(true));
    expect(requests.some((r) => r.url === '/v1/labels?workspaceId=2')).toBe(true);
    // The already-current workspace is not repeated as an extra chip.
    expect(await screen.findByRole('button', { name: /Workspace\s*Core/ })).toBeInTheDocument();
  });

  it('closes an open popover by clicking its chip again, and via Close', async () => {
    renderFilters();
    const chip = await screen.findByRole('button', { name: /Project\s*Any/ });
    fireEvent.click(chip);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByText('Acme')).not.toBeInTheDocument());

    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Acme')).not.toBeInTheDocument());
  });

  it('falls back to the id when a persisted chip has no matching row', async () => {
    localStorage.setItem('ninedeploy.tagScope', JSON.stringify({ projectIds: [999], labelIds: [998] }));
    routes = { '/v1/projects': [], '/v1/labels': [], '/v1/workspaces': [] };
    renderFilters();

    expect(await screen.findByText('Project #999')).toBeInTheDocument();
    expect(screen.getByText('Label #998')).toBeInTheDocument();
  });

  it('drops a persisted chip whose target no longer exists', async () => {
    localStorage.setItem(
      'ninedeploy.tagScope',
      JSON.stringify({ workspaceIds: [404], projectIds: [404], labelIds: [404] }),
    );
    renderFilters();

    // The live sets come back without those ids, so the scope prunes itself.
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());
  });

  it('ignores a corrupt persisted scope', async () => {
    localStorage.setItem('ninedeploy.tagScope', 'not json');
    renderFilters();
    expect(await screen.findByRole('button', { name: /Project\s*Any/ })).toBeInTheDocument();
  });
  it('renders an extra chip for a filtered non-current workspace and removes it', async () => {
    const other = { id: 3, name: 'Edge', slug: 'edge', role: 'member' };
    routes['/v1/workspaces'] = [workspace, other];
    withWorkspaces([workspace, other], workspace);
    renderFilters();

    fireEvent.click(await screen.findByRole('button', { name: /Workspace\s*Core/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Edge/ }));
    await waitFor(() => expect(storedScope().workspaceIds).toEqual([3]));

    // Only the non-current workspace gets its own chip next to the group.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());
  });

  it('closes the workspace and label popovers with their Close control', async () => {
    renderFilters();
    fireEvent.click(await screen.findByRole('button', { name: /Workspace\s*All/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText(/Filter by additional workspaces/)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Label\s*Any/ }));
    expect(await screen.findByText('production')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('production')).not.toBeInTheDocument());
  });
});
