/**
 * Form-state helpers for the Manifest Creator page.
 *
 * The page owns a single `NinedeployManifest` state object. Each section
 * component receives a slice and an update callback; this file is the
 * shared plumbing for the section list, slice updates, an undo/redo
 * history, and a small localStorage-backed hook so the operator's work
 * (and their place in the form) survives page reloads.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Boxes,
  Cable,
  CirclePlay,
  Compass,
  Container,
  Cpu,
  Database,
  GitBranch,
  GitPullRequest,
  Globe,
  HardDrive,
  Hammer,
  KeyRound,
  Layers,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { NinedeployManifest } from '@ninedeploy/schemas';

const STORAGE_KEY = 'ninedeploy.manifest.draft';
/** The last-open section is persisted separately so a reload keeps context. */
const SECTION_KEY = 'ninedeploy.manifest.section';

const EMPTY_MANIFEST: NinedeployManifest = { version: '1' };

/** Read the persisted draft, falling back to a clean empty manifest. */
function loadDraft(): NinedeployManifest {
  if (typeof window === 'undefined') return EMPTY_MANIFEST;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_MANIFEST;
    const parsed = JSON.parse(raw) as NinedeployManifest;
    // Light shape check — full validation is the SDK's job at apply time.
    if (parsed && typeof parsed === 'object' && parsed.version === '1') {
      return parsed;
    }
    return EMPTY_MANIFEST;
  } catch {
    return EMPTY_MANIFEST;
  }
}

/** Persist a draft to localStorage. Quietly swallows quota / private-mode errors. */
function saveDraft(manifest: NinedeployManifest): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(manifest));
  } catch {
    /* private mode or quota — non-fatal */
  }
}

/**
 * How far back the undo history reaches. 50 snapshots of a ≤16 KiB
 * manifest is a rounding error against the 5 MiB localStorage budget the
 * draft itself already uses.
 */
const HISTORY_LIMIT = 50;

interface FormState {
  manifest: NinedeployManifest;
  past: NinedeployManifest[];
  future: NinedeployManifest[];
}

/**
 * React hook returning the current manifest plus whole-state operations:
 * `replace` for swaps (preset apply, section edit, import — every swap is
 * undoable), `reset` back to the empty starter (also undoable), and
 * `undo` / `redo` walking the bounded history. The draft is auto-saved to
 * localStorage on every change. Slice-level updates are not exposed — the
 * page builds the next state in a closure and hands it to `replace`, which
 * keeps the data-flow simple.
 */
export function useManifestForm() {
  const [state, setState] = useState<FormState>(() => ({
    manifest: loadDraft(),
    past: [],
    future: [],
  }));

  useEffect(() => {
    saveDraft(state.manifest);
  }, [state.manifest]);

  const replace = useCallback((next: NinedeployManifest) => {
    setState((s) => {
      // A no-op replace (re-applying the identical preset, a section
      // writing back what it already had) must not pollute the history.
      if (JSON.stringify(next) === JSON.stringify(s.manifest)) return s;
      return {
        manifest: next,
        past: [...s.past.slice(-(HISTORY_LIMIT - 1)), s.manifest],
        future: [],
      };
    });
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const previous = s.past[s.past.length - 1];
      if (!previous) return s;
      return {
        manifest: previous,
        past: s.past.slice(0, -1),
        future: [s.manifest, ...s.future].slice(0, HISTORY_LIMIT),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const next = s.future[0];
      if (!next) return s;
      return {
        manifest: next,
        past: [...s.past, s.manifest].slice(-(HISTORY_LIMIT - 1)),
        future: s.future.slice(1),
      };
    });
  }, []);

  const reset = useCallback(() => {
    replace(EMPTY_MANIFEST);
  }, [replace]);

  return {
    manifest: state.manifest,
    replace,
    reset,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  } as const;
}

/**
 * The section the nav had open, persisted so a reload (or a nav away and
 * back) drops the operator where they left off instead of at the top.
 */
export function loadActiveSection(valid: ReadonlyArray<string>): string | null {
  if (typeof window === 'undefined') return null;
  const id = window.localStorage.getItem(SECTION_KEY);
  return id != null && valid.includes(id) ? id : null;
}

export function saveActiveSection(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SECTION_KEY, id);
  } catch {
    /* non-fatal */
  }
}

/**
 * Section descriptor for the page's left navigation. The order here is
 * the order rendered in the form, so it doubles as a content outline.
 */
export interface ManifestSection {
  id: string;
  label: string;
  /** Short summary shown in the nav — keeps it scannable. */
  blurb: string;
  /** Icon shown next to the label in the nav and the section header. */
  icon: LucideIcon;
  /** True when the section has any user-provided values; drives the • dot in the nav. */
  isFilled: (m: NinedeployManifest) => boolean;
}

export const SECTIONS: readonly ManifestSection[] = [
  {
    id: 'runtime',
    label: 'Runtime',
    blurb: 'Language + version pin (Node, Python, Go, …)',
    icon: Container,
    isFilled: (m) => m.runtime != null,
  },
  {
    id: 'build',
    label: 'Build',
    blurb: 'Install, build, start commands and baseDir',
    icon: Hammer,
    isFilled: (m) => m.build != null && Object.keys(m.build).length > 0,
  },
  {
    id: 'run',
    label: 'Run',
    blurb: 'Container port, healthcheck, restart policy',
    icon: CirclePlay,
    isFilled: (m) => m.run != null,
  },
  {
    id: 'static',
    label: 'Static',
    blurb: 'SPA fallback for static frontends',
    icon: Globe,
    isFilled: (m) => m.static != null,
  },
  {
    id: 'env',
    label: 'Environment',
    blurb: 'Required env keys + managed-DB aliases',
    icon: KeyRound,
    isFilled: (m) =>
      m.env != null && (m.env.required.length > 0 || Object.keys(m.env.aliases ?? {}).length > 0),
  },
  {
    id: 'phases',
    label: 'Phases',
    blurb: 'Extra nixpkgs + build-step cmds',
    icon: Layers,
    isFilled: (m) =>
      m.phases != null &&
      ((m.phases.setup?.pkgs.length ?? 0) > 0 || (m.phases.build?.cmds.length ?? 0) > 0),
  },
  {
    id: 'resources',
    label: 'Resources',
    blurb: 'CPU shares + memory cap',
    icon: Cpu,
    isFilled: (m) => m.resources != null,
  },
  {
    id: 'hooks',
    label: 'Hooks',
    blurb: 'preBuild / postBuild / preStop scripts',
    icon: Webhook,
    isFilled: (m) =>
      m.hooks != null && (m.hooks.preBuild != null || m.hooks.postBuild != null || m.hooks.preStop != null),
  },
  {
    id: 'watch',
    label: 'Watch',
    blurb: 'Monorepo watch-paths for auto-deploy',
    icon: GitBranch,
    isFilled: (m) => m.watch != null && m.watch.paths.length > 0,
  },
  {
    id: 'routing',
    label: 'Routing',
    blurb: 'Domain + path + SSL + headers',
    icon: Compass,
    isFilled: (m) => m.routes != null && m.routes.length > 0,
  },
  {
    id: 'previews',
    label: 'PR previews',
    blurb: 'Hostname template for preview envs',
    icon: GitPullRequest,
    isFilled: (m) => m.previews != null && m.previews.enabled,
  },
  {
    id: 'volume',
    label: 'Volume',
    blurb: 'Mount path + backup schedule',
    icon: HardDrive,
    isFilled: (m) => m.volume != null,
  },
  {
    id: 'database',
    label: 'Database',
    blurb: 'Attach a managed DB by slug',
    icon: Database,
    isFilled: (m) => m.database != null,
  },
  {
    id: 'network',
    label: 'Network',
    blurb: 'publishPort + internal network aliases',
    icon: Cable,
    isFilled: (m) => m.network != null,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    blurb: 'Channel routing for deploy/fail/alert',
    icon: Bell,
    isFilled: (m) =>
      m.notifications != null &&
      (m.notifications.onDeploy.length > 0 ||
        m.notifications.onFailure.length > 0 ||
        m.notifications.onAlert.length > 0),
  },
  {
    id: 'alerts',
    label: 'Alerts',
    blurb: 'Deploy-fail / restart-loop / high-mem rules',
    icon: Boxes,
    isFilled: (m) => m.alerts != null && m.alerts.length > 0,
  },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * Nav grouping: sixteen flat entries stop scanning well before the bottom,
 * so the nav renders titled clusters in the same overall order as before.
 */
export interface SectionGroup {
  id: string;
  label: string;
  sectionIds: ReadonlyArray<SectionId>;
}

export const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    id: 'core',
    label: 'Core',
    sectionIds: ['runtime', 'build', 'run', 'static', 'env'],
  },
  {
    id: 'pipeline',
    label: 'Build pipeline',
    sectionIds: ['phases', 'hooks', 'watch'],
  },
  {
    id: 'operations',
    label: 'Operations',
    sectionIds: ['resources', 'volume', 'network', 'database'],
  },
  {
    id: 'traffic',
    label: 'Traffic',
    sectionIds: ['routing', 'previews'],
  },
  {
    id: 'observability',
    label: 'Observability',
    sectionIds: ['notifications', 'alerts'],
  },
] as const;
