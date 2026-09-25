import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  Activity, Building2, Cloud, Container, Database, FileCode, FolderKanban, Globe, HardDrive, HelpCircle, KeyRound,
  Layers, LayoutDashboard, type LucideIcon, Network, Rocket, Search, Server,
  Settings as SettingsIcon, Shield, Sparkles, Tag, Users,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { ICON_MAP } from './Layout.js';
import { cn } from './ui.js';

interface Cmd {
  type: string;
  label: string;
  sub: string;
  to: string;
  icon: LucideIcon;
}

const NAV_COMMANDS: Cmd[] = [
  { type: 'Navigate', label: 'Hub', sub: 'Template gallery', to: '/hub', icon: Sparkles },
  { type: 'Navigate', label: 'Dashboard', sub: 'Overview & health', to: '/', icon: LayoutDashboard },
  { type: 'Navigate', label: 'Services', sub: 'All services', to: '/services', icon: Server },
  { type: 'Navigate', label: 'Manifest Creator', sub: 'Build a .ninedeploy manifest', to: '/manifest-creator', icon: FileCode },
  { type: 'Navigate', label: 'Workspaces', sub: 'Tenants, members & invitations', to: '/workspaces', icon: Building2 },
  { type: 'Navigate', label: 'Projects', sub: 'Group services by purpose', to: '/projects', icon: FolderKanban },
  { type: 'Navigate', label: 'Labels', sub: 'Free-form service tags', to: '/labels', icon: Tag },
  { type: 'Navigate', label: 'Databases', sub: 'Managed databases', to: '/databases', icon: Database },
  { type: 'Navigate', label: 'Domains', sub: 'Domain routing & SSL', to: '/domains', icon: Globe },
  { type: 'Navigate', label: 'Tunnels', sub: 'Cloudflare tunnels', to: '/tunnels', icon: Cloud },
  { type: 'Navigate', label: 'Volumes', sub: 'Persistent storage', to: '/volumes', icon: Layers },
  { type: 'Navigate', label: 'Networks', sub: 'Docker networks', to: '/networks', icon: Network },
  { type: 'Navigate', label: 'Traefik', sub: 'Ingress, routers & middlewares', to: '/traefik', icon: Shield },
  { type: 'Navigate', label: 'Docker', sub: 'Containers, images & system', to: '/docker', icon: Container },
  { type: 'Navigate', label: 'Topology', sub: 'Service graph', to: '/topology', icon: Network },
  { type: 'Navigate', label: 'Backups', sub: 'Database snapshots', to: '/backups', icon: HardDrive },
  { type: 'Navigate', label: 'Sources', sub: 'Private repo credentials', to: '/sources', icon: KeyRound },
  { type: 'Navigate', label: 'Users', sub: 'Team management', to: '/users', icon: Users },
  { type: 'Navigate', label: 'Monitoring', sub: 'Resource metrics', to: '/monitoring', icon: Activity },
  { type: 'Navigate', label: 'Activity', sub: 'Audit logs & platform events', to: '/activity', icon: Activity },
  { type: 'Navigate', label: 'Servers', sub: 'Remote hosts running the agent', to: '/servers', icon: HardDrive },
  { type: 'Navigate', label: 'About', sub: 'System information', to: '/about', icon: HelpCircle },
  { type: 'Navigate', label: 'Settings', sub: 'System info', to: '/settings', icon: SettingsIcon },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const services = useQuery({ queryKey: ['services'], queryFn: () => api.services.list() });
  const databases = useQuery({ queryKey: ['databases'], queryFn: () => api.databases.list() });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.templates.list() });
  const plugins = useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      const res = await api.plugins.list();
      return res.plugins;
    },
  });
  const menus = useQuery({
    queryKey: ['menus'],
    queryFn: async () => {
      const res = await api.menus.list();
      return res.items;
    },
  });

  const results = useMemo<Cmd[]>(() => {
    const dynamic: Cmd[] = [
      ...(services.data ?? []).map((s) => ({
        type: 'Service', label: s.name, sub: `${s.type} · ${s.status}`, to: `/services/${s.id}`, icon: Server,
      })),
      ...(databases.data ?? []).map((d) => ({
        type: 'Database', label: d.name, sub: `${d.engine} · ${d.status}`, to: `/databases/${d.id}`, icon: Database,
      })),
      ...(templates.data ?? []).map((t) => ({
        type: 'Template', label: `Deploy ${t.name}`, sub: t.tagline, to: '/hub', icon: Sparkles,
      })),
      ...(plugins.data ?? []).map((p) => ({
        type: 'Plugin', label: p.name, sub: `v${p.version} · ${p.status}`, to: '/settings', icon: Layers,
      })),
      ...(menus.data ?? []).map((m) => ({
        type: 'Extension', label: m.label, sub: m.route, to: m.route, icon: m.icon && ICON_MAP[m.icon.toLowerCase()] ? ICON_MAP[m.icon.toLowerCase()]! : Globe,
      })),
    ];

    const all = [...NAV_COMMANDS, ...dynamic];
    if (!query.trim()) return all.slice(0, 8);
    const q = query.toLowerCase();

    // Rank before truncating. Every nav entry carries the type 'Navigate', so
    // a bare type match makes single letters like "n" or "a" hit all of them
    // at once — enough to fill the result cap and starve the service or
    // template the operator was actually looking for. A label match therefore
    // always outranks a description match, which outranks a type match.
    const rank = (c: Cmd): number => {
      const label = c.label.toLowerCase();
      if (label.startsWith(q)) return 0;
      if (label.includes(q)) return 1;
      if (c.sub.toLowerCase().includes(q)) return 2;
      if (c.type.toLowerCase().includes(q)) return 3;
      return -1;
    };
    return all
      .map((c) => ({ c, r: rank(c) }))
      .filter((e) => e.r >= 0)
      // Array.prototype.sort is stable, so entries of equal rank keep their
      // declaration order (nav first, then services, databases, templates).
      .sort((a, b) => a.r - b.r)
      .slice(0, 24)
      .map((e) => e.c);
  }, [query, services.data, databases.data, templates.data, plugins.data, menus.data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on query — the selection must reset whenever the search text changes, even though the body only touches the setter.
  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); const r = results[selected]; if (r) { navigate(r.to); onClose(); } }
      else if (e.key === 'Escape') { onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [results, selected, navigate, onClose]);

  const activate = (cmd: Cmd) => { navigate(cmd.to); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <button type="button" aria-label="Close palette" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="nd-fade relative w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
          <Search size={18} className="shrink-0 text-slate-500" />
          <input
            // biome-ignore lint/a11y/noAutofocus: command-palette search should grab focus on open (the palette is modal; the user just pressed ⌘K).
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services, databases, templates, or jump to…"
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
          <kbd className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-500">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-auto p-2">
          {results.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-600">No results for "{query}"</p>
          ) : (
            results.map((cmd, i) => {
              const Icon = cmd.icon;
              return (
                <button
                  type="button"
                  key={`${cmd.type}-${cmd.label}-${i}`}
                  onClick={() => activate(cmd)}
                  onMouseEnter={() => setSelected(i)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition',
                    i === selected ? 'bg-indigo-500/15' : 'hover:bg-white/[0.03]',
                  )}
                >
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', i === selected ? 'bg-indigo-500/20 text-indigo-300' : 'bg-white/[0.04] text-slate-500')}>
                    <Icon size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-200">{cmd.label}</div>
                    <div className="truncate text-xs text-slate-500">{cmd.sub}</div>
                  </div>
                  <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600">
                    {cmd.type}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-white/5 px-4 py-2 text-[10px] text-slate-600">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><kbd className="rounded bg-white/[0.06] px-1 py-0.5">↑↓</kbd> navigate</span>
            <span className="flex items-center gap-1"><kbd className="rounded bg-white/[0.06] px-1 py-0.5">↵</kbd> select</span>
          </div>
          <span className="flex items-center gap-1"><Rocket size={10} /> NineDeploy</span>
        </div>
      </div>
    </div>
  );
}
