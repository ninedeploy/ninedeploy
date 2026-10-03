import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Label, ProjectEntry, Workspace } from '@ninedeploy/sdk';
import { api } from './api.js';

/**
 * Global tag-scope context (replaces the old single-project switcher).
 *
 * The top-bar `TopBarFilters` chip groups let the caller scope every project-
 * aware page by:
 *   - one or more workspaces
 *   - one or more projects
 *   - one or more labels
 *
 * Each dimension ANDs with the others (intersection across dimensions,
 * union within a dimension). The persisted shape is the same as the URL
 * query so a deep link can reproduce the filter exactly.
 *
 * `null` / empty selection in any dimension means "no constraint" — the
 * server returns everything in that dimension, just like the unfiltered
 * legacy mode.
 */

export interface TagScope {
  workspaceIds: number[];
  projectIds: number[];
  labelIds: number[];
  /** Update one dimension; pass an empty array to clear it. */
  setWorkspaceIds: (ids: number[]) => void;
  setProjectIds: (ids: number[]) => void;
  setLabelIds: (ids: number[]) => void;
  clearAll: () => void;
  /** True iff at least one chip is active. */
  isFiltered: boolean;
}

const TagContext = createContext<TagScope | null>(null);

const STORAGE_KEY = 'ninedeploy.tagScope';

interface PersistedScope {
  workspaceIds?: number[];
  projectIds?: number[];
  labelIds?: number[];
}

function readStored(): PersistedScope {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as PersistedScope;
  } catch {
    return {};
  }
}

function writeStored(scope: PersistedScope): void {
  try {
    if (
      (scope.workspaceIds?.length ?? 0) === 0 &&
      (scope.projectIds?.length ?? 0) === 0 &&
      (scope.labelIds?.length ?? 0) === 0
    ) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
    }
  } catch {
    /* ignore (privacy mode) */
  }
}

function sanitizeIds(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  for (const v of arr) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

export function TagScopeProvider({ children }: { children: ReactNode }) {
  const [workspaceIds, setWorkspaceIdsRaw] = useState<number[]>(() => sanitizeIds(readStored().workspaceIds));
  const [projectIds, setProjectIdsRaw] = useState<number[]>(() => sanitizeIds(readStored().projectIds));
  const [labelIds, setLabelIdsRaw] = useState<number[]>(() => sanitizeIds(readStored().labelIds));

  // Persist on every change. Cheap, the value is a handful of integers.
  useEffect(() => {
    writeStored({ workspaceIds, projectIds, labelIds });
  }, [workspaceIds, projectIds, labelIds]);

  // Drop a chip whose target was deleted. We resolve the live sets lazily:
  // workspaces, projects, labels. Each is queried only when the dimension
  // has at least one selection.
  const { data: workspaces = [] } = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => (await api.workspaces.list()) ?? [],
  });
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await api.projects.list()) ?? [],
  });
  const { data: labels = [] } = useQuery({
    queryKey: ['labels'],
    queryFn: async () => (await api.labels.list()) ?? [],
  });

  useEffect(() => {
    if (workspaceIds.length > 0 && workspaces.length > 0) {
      const live = new Set(workspaces.map((w: Workspace) => w.id));
      if (workspaceIds.some((id) => !live.has(id))) {
        setWorkspaceIdsRaw(workspaceIds.filter((id) => live.has(id)));
      }
    }
  }, [workspaces, workspaceIds]);
  useEffect(() => {
    if (projectIds.length > 0 && projects.length > 0) {
      const live = new Set(projects.map((p: ProjectEntry) => p.id));
      if (projectIds.some((id) => !live.has(id))) {
        setProjectIdsRaw(projectIds.filter((id) => live.has(id)));
      }
    }
  }, [projects, projectIds]);
  useEffect(() => {
    if (labelIds.length > 0 && labels.length > 0) {
      const live = new Set(labels.map((l: Label) => l.id));
      if (labelIds.some((id) => !live.has(id))) {
        setLabelIdsRaw(labelIds.filter((id) => live.has(id)));
      }
    }
  }, [labels, labelIds]);

  const setWorkspaceIds = useCallback((ids: number[]) => setWorkspaceIdsRaw(sanitizeIds(ids)), []);
  const setProjectIds = useCallback((ids: number[]) => setProjectIdsRaw(sanitizeIds(ids)), []);
  const setLabelIds = useCallback((ids: number[]) => setLabelIdsRaw(sanitizeIds(ids)), []);
  const clearAll = useCallback(() => {
    setWorkspaceIdsRaw([]);
    setProjectIdsRaw([]);
    setLabelIdsRaw([]);
  }, []);

  const value = useMemo<TagScope>(
    () => ({
      workspaceIds,
      projectIds,
      labelIds,
      setWorkspaceIds,
      setProjectIds,
      setLabelIds,
      clearAll,
      isFiltered: workspaceIds.length + projectIds.length + labelIds.length > 0,
    }),
    [workspaceIds, projectIds, labelIds, setWorkspaceIds, setProjectIds, setLabelIds, clearAll],
  );

  return <TagContext.Provider value={value}>{children}</TagContext.Provider>;
}

/** Fallback scope when rendered outside the provider (storybooks, bare tests). */
const FALLBACK: TagScope = {
  workspaceIds: [],
  projectIds: [],
  labelIds: [],
  setWorkspaceIds: () => {},
  setProjectIds: () => {},
  setLabelIds: () => {},
  clearAll: () => {},
  isFiltered: false,
};

export function useTagScope(): TagScope {
  return useContext(TagContext) ?? FALLBACK;
}

/**
 * Back-compat shim for the legacy `useProjectScope` API. Reads / writes the
 * same `ninedeploy.projectId` localStorage key the old single-project
 * switcher used, but does NOT participate in the chip-based scope. Use
 * `useTagScope` for new code.
 */
export interface ProjectScope {
  projects: ProjectEntry[];
  selectedId: number | null;
  selected: ProjectEntry | null;
  select: (id: number | null) => void;
}

const ProjectContext = createContext<ProjectScope | null>(null);
const LEGACY_STORAGE_KEY = 'ninedeploy.projectId';

function readLegacyId(): number | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function ProjectScopeProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<number | null>(readLegacyId);
  const { data } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await api.projects.list()) ?? [],
  });
  const projects = data ?? [];
  useEffect(() => {
    if (selectedId != null && data != null && !data.some((p) => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [data, selectedId]);
  const select = useCallback((id: number | null) => {
    setSelectedId(id);
    try {
      if (id == null) localStorage.removeItem(LEGACY_STORAGE_KEY);
      else localStorage.setItem(LEGACY_STORAGE_KEY, String(id));
    } catch {
      /* ignore (privacy mode) */
    }
  }, []);
  const selected = selectedId != null ? projects.find((p) => p.id === selectedId) ?? null : null;
  return (
    <ProjectContext.Provider value={{ projects, selectedId, selected, select }}>{children}</ProjectContext.Provider>
  );
}

const PROJECT_FALLBACK: ProjectScope = {
  projects: [],
  selectedId: null,
  selected: null,
  select: () => {},
};

export function useProjectScope(): ProjectScope {
  return useContext(ProjectContext) ?? PROJECT_FALLBACK;
}
