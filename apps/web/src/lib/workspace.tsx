import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Workspace, WorkspaceCreateInput } from '@ninedeploy/sdk';
import { api } from './api.js';
import { useAuth } from './auth.js';

interface WorkspaceContextValue {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  isLoading: boolean;
  switchWorkspace: (workspaceId: number) => void;
  createWorkspace: (input: WorkspaceCreateInput) => Promise<Workspace>;
  refreshWorkspaces: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const STORAGE_KEY = 'nd_current_workspace_id';

/**
 * Make `workspaceId` the active workspace for the next WorkspaceProvider
 * mount. For pages outside the provider (the public /invite/:token route)
 * that hand the user over to the authed shell.
 */
export function rememberWorkspace(workspaceId: number): void {
  localStorage.setItem(STORAGE_KEY, String(workspaceId));
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? Number(saved) : null;
  });

  const { data: workspaces = [], isLoading, refetch } = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => (await api.workspaces.list()) ?? [],
    enabled: Boolean(user),
  });

  // Ensure an active workspace is selected
  useEffect(() => {
    if (workspaces.length > 0) {
      const exists = workspaces.some((w) => w.id === selectedId);
      if (!exists || selectedId === null) {
        const first = workspaces[0];
        // Defensive: unreachable in practice — some() above already dereferences
        // every element, so a missing first slot cannot survive to here.
        /* v8 ignore next 4 */
        if (first) {
          setSelectedId(first.id);
          localStorage.setItem(STORAGE_KEY, String(first.id));
        }
      }
    } else if (user && !isLoading) {
      // Only clear a saved selection once we KNOW the signed-in user has no
      // workspaces — clearing during the initial empty/loading render would
      // wipe the persisted choice before the list ever arrives.
      setSelectedId(null);
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [workspaces, selectedId, user, isLoading]);

  const createMutation = useMutation({
    mutationFn: (input: WorkspaceCreateInput) => api.workspaces.create(input),
    onSuccess: (newWs) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setSelectedId(newWs.id);
      localStorage.setItem(STORAGE_KEY, String(newWs.id));
    },
  });

  const switchWorkspace = (workspaceId: number) => {
    setSelectedId(workspaceId);
    localStorage.setItem(STORAGE_KEY, String(workspaceId));
    // Invalidate project and resource queries scoped to workspace
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const currentWorkspace = workspaces.find((w) => w.id === selectedId) ?? (workspaces[0] ?? null);

  const value: WorkspaceContextValue = {
    workspaces,
    currentWorkspace,
    isLoading,
    switchWorkspace,
    createWorkspace: (input) => createMutation.mutateAsync(input),
    refreshWorkspaces: async () => {
      await refetch();
    },
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}
