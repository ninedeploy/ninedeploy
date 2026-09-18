import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Building2, ChevronLeft, ChevronRight, Clock, Cloud, Container, Database, FolderKanban, Globe, HardDrive,
  FileCode, Info, KeyRound, Layers, LayoutDashboard, ListOrdered, Moon, Network, Shield, Stethoscope, Tag, type LucideIcon,
  Rocket, Search, Server, Settings as SettingsIcon, Sparkles, Sun, Users, X,
} from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth.js';
import { api, getToken } from '../lib/api.js';
import { useTheme } from '../lib/theme.js';
import { Logo } from './Logo.js';
import { cn } from './ui.js';
import { CommandPalette } from './CommandPalette.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { TopBarFilters } from './TopBarFilters.js';
import { ModeToggle } from './ModeToggle.js';
import { UpdateBanner } from './UpdateBanner.js';
import { HelpButton, HelpDrawer } from './HelpDrawer.js';
import { DeployQueueBadge } from './DeployQueueBadge.js';
import { HelpProvider } from '../help/HelpContext.js';
import { useExperienceMode } from '../lib/mode.js';
import { installPanelAutofillGuard } from '../lib/autofill.js';

interface NavItem { to: string; label: string; icon: LucideIcon; advancedOnly?: boolean; operatorOnly?: boolean }

interface NavGroup { id: string; label: string; icon: LucideIcon; items: NavItem[] }

export const ICON_MAP: Record<string, LucideIcon> = {
  server: Server,
  activity: Activity,
  building: Building2,
  database: Database,
  shield: Shield,
  harddrive: HardDrive,
  container: Container,
  globe: Globe,
  network: Network,
  cloud: Cloud,
  key: KeyRound,
  sparkles: Sparkles,
  layers: Layers,
  users: Users,
  tag: Tag,
  folder: FolderKanban,
};

const GROUPS: NavGroup[] = [
  {
    id: 'deploy', label: 'Deploy', icon: Rocket, items: [
      { to: '/hub', label: 'Hub', icon: Sparkles },
      { to: '/manifest-creator', label: 'Manifest Creator', icon: FileCode },
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/services', label: 'Services', icon: Server },
      // Global queue view: every in-flight (queued / building / deploying)
      // deploy across every service the caller can see, with one-click
      // cancel + remove. Sits in the Deploy group because that is what the
      // page is for; the per-service Deploys tab still owns the per-row
      // log and config diff.
      { to: '/deploys', label: 'Queue', icon: ListOrdered },
    ],
  },
  {
    // The three tag dimensions a service can belong to. Projects and labels
    // used to have no navigation entry at all — projects were reachable only
    // by typing the URL, and labels only as a side effect of the top-bar
    // filter, which offered no way to rename, recolour or delete one.
    id: 'organize', label: 'Organize', icon: FolderKanban, items: [
      { to: '/workspaces', label: 'Workspaces', icon: Building2 },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/labels', label: 'Labels', icon: Tag },
    ],
  },
  {
    id: 'data', label: 'Data', icon: Database, items: [
      { to: '/databases', label: 'Databases', icon: Database },
      { to: '/volumes', label: 'Volumes', icon: Layers },
      { to: '/backups', label: 'Backups', icon: HardDrive },
    ],
  },
  {
    id: 'network', label: 'Network', icon: Globe, items: [
      { to: '/domains', label: 'Domains', icon: Globe },
      { to: '/traefik', label: 'Traefik', icon: Shield },
      { to: '/networks', label: 'Networks', icon: Network, advancedOnly: true },
      { to: '/tunnels', label: 'Tunnels', icon: Cloud, advancedOnly: true },
      { to: '/topology', label: 'Topology', icon: Network },
    ],
  },
  {
    id: 'system', label: 'System', icon: SettingsIcon, items: [
      { to: '/activity', label: 'Activity', icon: Clock },
      { to: '/monitoring', label: 'Monitoring', icon: Activity },
      // Host-wide analysis + guarded cleanup (dead containers, orphan volumes,
      // row/runtime desync, reclaimable bloat). Operator-gated server-side, so
      // members don't get a sidebar link to a page that can only refuse them.
      { to: '/doctor', label: 'Doctor', icon: Stethoscope, operatorOnly: true },
      { to: '/docker', label: 'Docker', icon: Container, advancedOnly: true },
      { to: '/sources', label: 'Sources', icon: KeyRound },
      { to: '/servers', label: 'Servers', icon: HardDrive, advancedOnly: true },
      { to: '/users', label: 'Users', icon: Users },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
      { to: '/about', label: 'About', icon: Info },
    ],
  },
];

function matchItem(item: NavItem, pathname: string): boolean {
  // '/services' must not light up on '/services/new' for a DIFFERENT item —
  // prefix matching is fine because group items have distinct prefixes.
  return pathname.startsWith(item.to);
}

/**
 * Resolve the active sidebar group for a given path.
 *
 * Iterates every group/item and returns the group whose item is the
 * LONGEST prefix match, not the first one declared. Plugin-contributed
 * menu items register with routes like `/settings/extensions/foo` and
 * those routes also start with the built-in `/settings` (System group)
 * — without a longest-match rule, the System group would always win
 * because the static GROUPS are declared before the dynamic
 * extensions group, and the user would land in the wrong panel
 * every time they clicked an extension link. The longest-match
 * strategy still keeps the simple "this route maps to that group"
 * behaviour for every built-in nav item; it just prefers the more
 * specific item when two groups both match.
 */
function findGroup(pathname: string, groups: NavGroup[] = GROUPS): string | null {
  let best: { groupId: string; prefixLen: number } | null = null;
  for (const g of groups) {
    for (const i of g.items) {
      if (!matchItem(i, pathname)) continue;
      if (best === null || i.to.length > best.prefixLen) {
        best = { groupId: g.id, prefixLen: i.to.length };
      }
    }
  }
  return best?.groupId ?? null;
}

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { isSimple } = useExperienceMode();
  const location = useLocation();

  useLayoutEffect(() => installPanelAutofillGuard(document), []);

  const menus = useQuery({
    queryKey: ['menus'],
    queryFn: async () => {
      try {
        const res = await api.menus.list();
        return res.items;
      } catch {
        return [];
      }
    },
  });

  const navGroups = useMemo(() => {
    const visible = (item: NavItem) =>
      (!item.advancedOnly || !isSimple) && (!item.operatorOnly || user?.isOperator === true);
    const rawGroups = GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(visible),
    }));

    // Only the items the plugin authors want in the secondary sidebar
    // end up here. `command:palette` items show in the Cmd+K palette
    // only, `service:tabs` and `database:tabs` belong to their parent
    // pages, `settings:nav` is rendered inside the settings shell, and
    // `user:menu` is the avatar dropdown. Without this filter every
    // `command:palette` entry would leak into the Extensions group
    // and bloat the sidebar with items the user cannot reach in the
    // rail anyway.
    const extensionItems: NavItem[] = (menus.data ?? [])
      .filter((m) => m.slot === 'sidebar:secondary')
      .map((m) => ({
        to: m.route,
        label: m.label,
        icon: m.icon && ICON_MAP[m.icon.toLowerCase()] ? ICON_MAP[m.icon.toLowerCase()]! : Globe,
      }));

    if (extensionItems.length === 0) return rawGroups;

    return [
      ...rawGroups,
      {
        id: 'extensions',
        label: 'Extensions',
        icon: Layers,
        items: extensionItems,
      },
    ];
  }, [menus.data, isSimple, user?.isOperator]);

  const [activeGroup, setActiveGroup] = useState<string | null>(() => {
    // On first paint: if the current path matches a known group, open that
    // group; otherwise fall back to the second group ("Organize") so the
    // secondary panel always has something visible on a fresh load (the
    // /nowhere and root paths otherwise render an empty rail and a panel
    // header with no items).
    const fromPath = findGroup(location.pathname, GROUPS);
    if (fromPath) return fromPath;
    return GROUPS[1]?.id ?? null;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Cmd+K / Ctrl+K to toggle command palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-open the correct group when navigating.
  useEffect(() => {
    const g = findGroup(location.pathname, navGroups);
    if (g) setActiveGroup(g);
  }, [location.pathname, navGroups]);

  const currentGroup = navGroups.find((g) => g.id === activeGroup) ?? null;

  const toggleGroup = (id: string) => setActiveGroup((prev) => (prev === id ? null : id));

  const currentItem = currentGroup?.items.find((i) => matchItem(i, location.pathname));
  const pageTitle = currentItem?.label ?? 'Dashboard';

  return (
    <HelpProvider>
    <div className="flex h-screen overflow-hidden">
      {/* ── Activity Bar (far-left rail) ──────────────────── */}
      <div className="relative z-30 flex w-12 shrink-0 flex-col items-center border-r border-white/[0.06] bg-slate-950/70 py-3 backdrop-blur">
        {/* Brand mark */}
        <div className="mb-3 grid h-8 w-8 place-items-center">
          <Logo className="h-8 w-8" />
        </div>

        {/* Group icons */}
        {navGroups.map((g) => {
          const Icon = g.icon;
          const active = activeGroup === g.id;
          return (
            <button type="button"
              key={g.id}
              onClick={() => toggleGroup(g.id)}
              className={cn(
                'group relative mb-1 grid h-10 w-10 place-items-center rounded-xl transition',
                active ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-inset ring-indigo-500/30'
                  : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-200',
              )}
            >
              <Icon size={19} />
              {/* Active indicator */}
              {active && <span className="absolute -left-3 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-indigo-400" />}
              {/* Tooltip */}
              <span className="pointer-events-none absolute left-full top-1/2 ml-2.5 z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-slate-700/80 bg-slate-900 px-2 py-1 text-xs font-medium text-slate-100 shadow-2xl opacity-0 transition-all duration-150 group-hover:opacity-100">
                {g.label}
              </span>
            </button>
          );
        })}

        <div className="flex-1" />

        {/* User avatar */}
        <button type="button"
          onClick={logout}
          className="group relative grid h-9 w-9 place-items-center rounded-full bg-indigo-500/20 text-xs font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-500/30 transition hover:bg-rose-500/20 hover:text-rose-300"
          title="Sign out"
        >
          {(user?.email ?? '?')[0]?.toUpperCase()}
          <span className="pointer-events-none absolute left-full top-1/2 ml-2.5 z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-slate-700/80 bg-slate-900 px-2 py-1 text-xs font-medium text-slate-100 shadow-2xl opacity-0 transition-all duration-150 group-hover:opacity-100">
            {user?.email} · Sign out
          </span>
        </button>
      </div>

      {/* ── Secondary Panel (group items) ────────────────── */}
      {currentGroup && (
        <div className="nd-flex nd-fade relative z-10 flex w-52 shrink-0 flex-col border-r border-white/[0.06] bg-white/[0.015] backdrop-blur-sm">
          {/* Group header */}
          <div className="flex items-center gap-2 px-4 pb-2 pt-4">
            <currentGroup.icon size={14} className="text-indigo-400" />
            <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">{currentGroup.label}</span>
          </div>

          {/* Items */}
          <nav className="flex-1 overflow-y-auto px-2 py-1">
            {currentGroup.items.map((item) => {
              const active = matchItem(item, location.pathname);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition',
                    active ? 'bg-indigo-500/15 font-medium text-white' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200',
                  )}
                >
                  <Icon size={16} className={active ? 'text-indigo-400' : 'text-slate-500'} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Collapse button */}
          <button type="button"
            onClick={() => setActiveGroup(null)}
            className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-slate-600 transition hover:text-slate-400"
          >
            <ChevronLeft size={13} /> Collapse
          </button>
        </div>
      )}

      {/* ── Main ──────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] px-5">
          <div className="flex items-center gap-2 text-sm">
            <WorkspaceSwitcher />
            <TopBarFilters />
            <span className="font-medium text-slate-300">{currentGroup?.label ?? 'NineDeploy'}</span>
            {currentItem && (
              <>
                <span className="text-slate-700">/</span>
                <span className="text-slate-500">{pageTitle}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <button type="button"
              onClick={toggleTheme}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs text-slate-500 transition hover:bg-white/[0.08] hover:text-slate-300"
              title="Search (⌘K)"
            >
              <Search size={13} />
              <span className="hidden sm:inline">Search</span>
              <kbd className="rounded bg-white/[0.06] px-1 py-0.5 text-[9px]">⌘K</kbd>
            </button>
            <DeployQueueBadge />
            <button type="button"
              onClick={() => setDrawerOpen(true)}
              className="relative rounded-lg p-2 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
              title="Activity"
            >
              <Activity size={16} />
            </button>
            <HelpButton />
          </div>
        </header>

        {/* Self-update availability / progress / result (operators only) */}
        <UpdateBanner />

        {/* Content */}
        <main className="nd-fade flex-1 overflow-auto">
          <div className="mx-auto max-w-6xl px-5 py-7 md:px-8">
            <Outlet />
          </div>
        </main>
      </div>

      {/* ── Right drawer (activity) ──────────────────────── */}
      {drawerOpen && <ActivityDrawer onClose={() => setDrawerOpen(false)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {/* Help drawer mounts itself; it reads open state from HelpProvider. */}
      <HelpDrawer />
    </div>
    </HelpProvider>
  );
}

// ── Legacy project switcher — replaced by TopBarFilters (3 chip groups) ───
void function _ProjectSwitcherRemoved() {
  /* The single-select <select> used to live here. Replaced by the chip-based
   * `TopBarFilters` (workspace / project / label, multi-select, persisted)
   * — see components/TopBarFilters.tsx. Kept as a no-op here so the diff
   * against upstream stays a rename rather than a removal. */
};

// ── Activity drawer (live WebSocket events) ───────────────────────────────
interface AppEvent { id: number; action: string; entity: string | null; ts: string }

function ActivityDrawer({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [filter, setFilter] = useState('all');
  // Socket state drives the "live" badge: a dead socket must never advertise
  // itself as live, or the operator trusts a feed that stopped feeding.
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const token = getToken();
      ws = new WebSocket(
        `${proto}://${window.location.host}/v1/events`,
        token ? [`ninedeploy.bearer.${token}`] : ['ninedeploy'],
      );
      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        try {
          const lines = String(e.data).split('\n').filter(Boolean);
          const parsed = lines.map((l) => JSON.parse(l) as AppEvent);
          // r209: the server replays its recent-event backlog on EVERY connect,
          // so each reconnect used to prepend up to 100 copies of events
          // already shown. Merge by id (ids are unique and increasing), newest first.
          setEvents((prev) => {
            const byId = new Map(prev.map((ev) => [ev.id, ev]));
            for (const ev of parsed) byId.set(ev.id, ev);
            return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 100);
          });
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        // Reconnect with capped exponential backoff (2s → 30s). Without this,
        // a transient drop (sleep/resume, proxy idle timeout) silently freezes
        // the feed forever.
        const delay = Math.min(30_000, 2000 * 2 ** attempts);
        attempts += 1;
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  const filtered = filter === 'all' ? events : events.filter((e) => e.action.startsWith(filter));

  const fmtTime = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(ts).toLocaleTimeString();
  };

  const ICONS: Record<string, string> = {
    'service': '🖥️', 'database': '🗄️', 'domain': '🌐', 'deploy': '🚀', 'rollback': '↩️',
    'backup': '💾', 'tunnel': '☁️', 'source': '🔑', 'user': '👤', 'template': '✨',
    'volume': '💾', 'env': '🔐', 'webhook': '🔗',
  };
  const COLORS: Record<string, string> = {
    'service': 'text-indigo-300', 'database': 'text-emerald-300', 'domain': 'text-sky-300',
    'deploy': 'text-indigo-300', 'rollback': 'text-amber-300', 'backup': 'text-sky-300',
    'delete': 'text-rose-300', 'create': 'text-emerald-300',
  };
  const iconFor = (action: string) => {
    const prefix = action.split('.')[0]!;
    return ICONS[prefix] ?? '•';
  };
  const colorFor = (action: string) => {
    if (action.includes('delete')) return COLORS['delete']!;
    if (action.includes('create')) return COLORS['create']!;
    const prefix = action.split('.')[0]!;
    return COLORS[prefix] ?? 'text-slate-300';
  };

  const filters = ['all', 'service', 'database', 'domain', 'deploy', 'backup', 'user'];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close events drawer" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="nd-fade relative flex h-full w-80 flex-col border-l border-white/10 bg-slate-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Activity size={15} className="text-indigo-400" /> Events
            {connected ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300">● live</span>
            ) : (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">● reconnecting</span>
            )}
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:bg-white/5 hover:text-slate-300">
            <X size={16} />
          </button>
        </div>
        {/* Filter chips */}
        <div className="flex gap-1 overflow-x-auto border-b border-white/5 px-3 py-2">
          {filters.map((f) => (
            <button type="button"
              key={f}
              onClick={() => setFilter(f)}
              className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition capitalize', filter === f ? 'bg-indigo-500 text-white' : 'bg-white/[0.04] text-slate-500 hover:bg-white/[0.08]')}
            >
              {f}
            </button>
          ))}
        </div>
        {/* Events */}
        <div className="flex-1 overflow-auto p-2">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-600">No events yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((e) => (
                <li key={e.id} className="nd-fade flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/[0.03]">
                  <span className="mt-0.5 text-sm">{iconFor(e.action)}</span>
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-xs font-medium', colorFor(e.action))}>
                      {e.action.replace(/\./g, ' ')}
                    </div>
                    {e.entity && <div className="truncate text-[11px] text-slate-500">{e.entity}</div>}
                    <div className="text-[9px] text-slate-600">{fmtTime(e.ts)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-white/5 p-3">
          <Link
            to="/activity"
            onClick={onClose}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-white/[0.04] py-2 text-xs font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
          >
            <span>View Full Audit Ledger</span>
            <ChevronRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  );
}
