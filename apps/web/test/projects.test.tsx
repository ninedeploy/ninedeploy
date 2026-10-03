import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import './web-utils.js';
import { ProjectScopeProvider, useProjectScope, useTagScope } from '../src/lib/projects.js';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Consumer that reports the scope and lets tests switch projects. */
function ScopeProbe() {
  const { projects, selectedId, selected, select } = useProjectScope();
  const [other, setOther] = useState(false);
  return (
    <div>
      <span data-testid="count">{projects.length}</span>
      <span data-testid="selected-id">{selectedId ?? 'none'}</span>
      <span data-testid="selected-name">{selected?.name ?? 'none'}</span>
      <button type="button" onClick={() => select(2)}>pick2</button>
      <button type="button" onClick={() => select(null)}>clear</button>
      <button type="button" onClick={() => setOther((v) => !v)}>{other ? 'other' : 'idle'}</button>
    </div>
  );
}

// The provider loads the project list through the api client module — mock it.
// The test fixtures and mock factory both need access to the same project
// list, so they are declared inside `vi.hoisted` (which runs before every
// `vi.mock` factory is hoisted to the top of the file). Referencing a plain
// `const PROJECTS` from inside the factory triggers a TDZ error at import
// time, which is what made this file flaky on full-suite runs.
const { PROJECTS } = vi.hoisted(() => {
  const PROJECTS: Array<{
    id: number;
    name: string;
    slug: string;
    description: string | null;
    serviceCount: number;
    databaseCount: number;
    createdAt: string;
    updatedAt: string;
  }> = [
    { id: 1, name: 'Alpha', slug: 'alpha', description: null, serviceCount: 0, databaseCount: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 2, name: 'Beta', slug: 'beta', description: null, serviceCount: 3, databaseCount: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ];
  return { PROJECTS };
});

function renderProvider(list: Promise<typeof PROJECTS> | undefined = Promise.resolve(PROJECTS)) {
  const client = makeClient();
  const { ...utils } = render(
    <QueryClientProvider client={client}>
      <ProjectScopeProvider>
        <ScopeProbe />
      </ProjectScopeProvider>
    </QueryClientProvider>,
  );
  void list;
  return utils;
}

vi.mock('../src/lib/api.js', () => {
  const state = { projects: [...PROJECTS] };
  return {
    api: { projects: { list: vi.fn(async () => state.projects) } },
    __setState: (p: typeof PROJECTS) => { state.projects = p; },
  };
});

describe('ProjectScopeProvider', () => {
  it('defaults to All projects and loads the list', async () => {
    localStorage.removeItem('ninedeploy.projectId');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('selected-id')).toHaveTextContent('none');
    expect(screen.getByTestId('selected-name')).toHaveTextContent('none');
  });

  it('persists the selection and resolves the selected project', async () => {
    localStorage.removeItem('ninedeploy.projectId');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    act(() => { fireEvent.click(screen.getByText('pick2')); });
    expect(screen.getByTestId('selected-id')).toHaveTextContent('2');
    expect(screen.getByTestId('selected-name')).toHaveTextContent('Beta');
    expect(localStorage.getItem('ninedeploy.projectId')).toBe('2');
    act(() => { fireEvent.click(screen.getByText('clear')); });
    expect(localStorage.getItem('ninedeploy.projectId')).toBeNull();
  });

  it('drops a stored selection that no longer exists', async () => {
    localStorage.setItem('ninedeploy.projectId', '99');
    renderProvider(Promise.resolve([PROJECTS[0]!]));
    await waitFor(() => expect(screen.getByTestId('selected-id')).toHaveTextContent('none'));
  });

  it('falls back to an All-projects scope outside the provider', () => {
    render(<ScopeProbe />);
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(screen.getByTestId('selected-id')).toHaveTextContent('none');
    // The fallback select is a no-op: switching must not throw or change state.
    act(() => { fireEvent.click(screen.getByText('pick2')); });
    expect(screen.getByTestId('selected-id')).toHaveTextContent('none');
  });

  it('survives localStorage access failures', () => {
    const storage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => {},
    } as unknown as Storage;
    Object.defineProperty(window, 'localStorage', { get: () => storage, configurable: true });
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <ProjectScopeProvider>
          <ScopeProbe />
        </ProjectScopeProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('selected-id')).toHaveTextContent('none');
    // select() must not blow up when persistence fails.
    act(() => { fireEvent.click(screen.getByText('pick2')); });
    expect(screen.getByTestId('selected-id')).toHaveTextContent('2');
  });
});

describe('useTagScope outside a provider', () => {
  /** Renders the fallback scope and drives every one of its no-op setters. */
  function FallbackProbe() {
    const scope = useTagScope();
    return (
      <div>
        <span data-testid="filtered">{String(scope.isFiltered)}</span>
        <span data-testid="ids">
          {scope.workspaceIds.length}/{scope.projectIds.length}/{scope.labelIds.length}
        </span>
        <button type="button" onClick={() => { scope.setWorkspaceIds([1]); }}>ws</button>
        <button type="button" onClick={() => { scope.setProjectIds([2]); }}>proj</button>
        <button type="button" onClick={() => { scope.setLabelIds([3]); }}>label</button>
        <button type="button" onClick={() => { scope.clearAll(); }}>clear</button>
      </div>
    );
  }

  it('reports an unfiltered scope whose setters are inert', () => {
    render(<FallbackProbe />);
    expect(screen.getByTestId('filtered')).toHaveTextContent('false');
    expect(screen.getByTestId('ids')).toHaveTextContent('0/0/0');

    // Storybooks and bare tests may still call the setters; they must no-op
    // rather than crash, and the scope stays empty.
    for (const label of ['ws', 'proj', 'label', 'clear']) {
      act(() => { fireEvent.click(screen.getByText(label)); });
    }
    expect(screen.getByTestId('ids')).toHaveTextContent('0/0/0');
    expect(screen.getByTestId('filtered')).toHaveTextContent('false');
  });
});
