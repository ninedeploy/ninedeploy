import { type ReactNode, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ArrowLeftRight,
  Bell,
  Bot,
  Boxes,
  HardDrive,
  KeyRound,
  Palette,
  Puzzle,
  Search,
  Server,
  Settings as SettingsIcon,
  Shield,
  Sliders,
  Terminal,
  User,
  X,
} from 'lucide-react';
import { AccountSection } from './AccountSection.js';
import { AiSection } from './AiSection.js';
import { AppearanceSection } from './AppearanceSection.js';
import { SecuritySection } from './SecuritySection.js';
import { SystemSection } from './SystemSection.js';
import { NotificationsSection } from './NotificationsSection.js';
import { MigrationSection } from './MigrationSection.js';
import { IntegrationsSection } from './IntegrationsSection.js';
import { ConfigCenterSection } from './ConfigCenterSection.js';
import { PluginsSection } from './PluginsSection.js';
import { LogDrainsSection } from './LogDrainsSection.js';
import { StorageSection } from './StorageSection.js';
import { SsoSection } from './SsoSection.js';
import { FirewallSection } from './FirewallSection.js';
import { AutofillRejectingInput, PageHeader, cn } from '../../components/ui.js';

type SectionId =
  | 'account'
  | 'appearance'
  | 'security'
  | 'sso'
  | 'integrations'
  | 'ai'
  | 'log-drains'
  | 'storage'
  | 'firewall'
  | 'config'
  | 'plugins'
  | 'system'
  | 'notifications'
  | 'migration';

interface SectionItem {
  id: SectionId;
  label: string;
  desc: string;
  icon: ReactNode;
}

interface SectionCategory {
  category: string;
  items: SectionItem[];
}

const SETTING_GROUPS: SectionCategory[] = [
  {
    category: 'Personal & Access',
    items: [
      { id: 'account', label: 'Account', desc: 'Profile, credentials & passkeys', icon: <User size={16} /> },
      { id: 'appearance', label: 'Appearance', desc: 'Theme colors & density', icon: <Palette size={16} /> },
      { id: 'security', label: 'Security', desc: '2FA, audit logs & sessions', icon: <Shield size={16} /> },
      { id: 'sso', label: 'SSO & OIDC', desc: 'Identity providers & auto-enroll', icon: <KeyRound size={16} /> },
    ],
  },
  {
    category: 'Integrations & Alerts',
    items: [
      { id: 'integrations', label: 'Integrations', desc: 'Vault secrets, DNS & S3', icon: <Boxes size={16} /> },
      { id: 'ai', label: 'AI Diagnosis', desc: 'BYO-key failed-deploy analysis', icon: <Bot size={16} /> },
      { id: 'notifications', label: 'Notifications', desc: 'Webhooks, Slack, Telegram', icon: <Bell size={16} /> },
      { id: 'log-drains', label: 'Log Drains', desc: 'Syslog, Datadog & Vector', icon: <Terminal size={16} /> },
    ],
  },
  {
    category: 'DevOps & Engine',
    items: [
      { id: 'firewall', label: 'Firewall (UFW)', desc: 'Host ports & inbound packet filter', icon: <Shield size={16} /> },
      { id: 'storage', label: 'Storage & Prune', desc: 'Disks, Docker prune & logs', icon: <HardDrive size={16} /> },
      { id: 'config', label: 'Config Center', desc: 'Global key-value configuration', icon: <Sliders size={16} /> },
      { id: 'plugins', label: 'Plugins', desc: 'Community plugins & extensions', icon: <Puzzle size={16} /> },
    ],
  },
  {
    category: 'Platform & Lifecycle',
    items: [
      { id: 'system', label: 'System', desc: 'Resources, version & updates', icon: <Server size={16} /> },
      { id: 'migration', label: 'Migration', desc: 'Full backups import/export', icon: <ArrowLeftRight size={16} /> },
    ],
  },
];

/** Every valid section id, flattened for ?section= validation. */
const ALL_SECTION_IDS: SectionId[] = SETTING_GROUPS.flatMap((group) =>
  group.items.map((item) => item.id),
);

/** Settings page shell: clean vertical sidebar navigation layout with search filter. */
export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  // The active section lives in the URL (?section=…) so it deep-links and the
  // help drawer can show section-specific help. Unknown or missing values fall
  // back to the landing section instead of breaking the page.
  const sectionParam = searchParams.get('section');
  const section: SectionId = ALL_SECTION_IDS.includes(sectionParam as SectionId)
    ? (sectionParam as SectionId)
    : 'account';
  const setSection = (next: SectionId) => setSearchParams({ section: next }, { replace: true });
  const [search, setSearch] = useState('');

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return SETTING_GROUPS;
    const q = search.toLowerCase();
    return SETTING_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => item.label.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q),
      ),
    })).filter((group) => group.items.length > 0);
  }, [search]);

  return (
    <div className="space-y-6 nd-fade">
      <PageHeader
        icon={<SettingsIcon size={20} />}
        title="Settings & Platform Config"
        subtitle="Manage instance preferences, security, storage, log sinks and system lifecycle."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Categorized Vertical Sidebar */}
        <aside className="lg:col-span-4 xl:col-span-3">
          <div className="sticky top-6 space-y-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3 backdrop-blur-md">
            {/* Quick Filter Input */}
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <AutofillRejectingInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                // Browser-only autofill rejection; jsdom never fires it.
                onAutofillRejected={/* v8 ignore start */ () => setSearch('') /* v8 ignore stop */}
                name="ninedeploy-settings-filter"
                type="search"
                placeholder="Filter settings..."
                aria-label="Filter settings"
                className="h-8 pl-8 pr-7 text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  aria-label="Clear filter"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <nav className="space-y-4" aria-label="Settings sections">
              {filteredGroups.length === 0 ? (
                <p className="p-3 text-center text-xs text-slate-500">No settings matching "{search}"</p>
              ) : (
                filteredGroups.map((group) => (
                  <div key={group.category} className="space-y-1">
                    <h3 className="px-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {group.category}
                    </h3>
                    <div className="space-y-0.5">
                      {group.items.map((item) => {
                        const active = section === item.id;
                        return (
                          <button
                            type="button"
                            key={item.id}
                            role="tab"
                            aria-selected={active}
                            aria-controls={`settings-panel-${item.id}`}
                            onClick={() => setSection(item.id)}
                            className={cn(
                              'group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-all duration-150',
                              active
                                ? 'bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-500/30'
                                : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200',
                            )}
                          >
                            <span
                              className={cn(
                                'grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors',
                                active
                                  ? 'bg-indigo-500/20 text-indigo-300'
                                  : 'bg-white/[0.04] text-slate-400 group-hover:text-slate-200',
                              )}
                            >
                              {item.icon}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className={cn('text-xs font-semibold', active ? 'text-slate-100' : 'text-slate-300')}>
                                {item.label}
                              </div>
                              <div className="truncate text-[10px] text-slate-500">{item.desc}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </nav>
          </div>
        </aside>

        {/* Active Section Content Panel */}
        <main className="lg:col-span-8 xl:col-span-9 min-w-0" id={`settings-panel-${section}`} role="tabpanel">
          <div className="space-y-6">
            {section === 'account' && <AccountSection />}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'security' && <SecuritySection />}
            {section === 'sso' && <SsoSection />}
            {section === 'integrations' && <IntegrationsSection />}
            {section === 'ai' && <AiSection />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'log-drains' && <LogDrainsSection />}
            {section === 'firewall' && <FirewallSection />}
            {section === 'storage' && <StorageSection />}
            {section === 'config' && <ConfigCenterSection />}
            {section === 'plugins' && <PluginsSection />}
            {section === 'system' && <SystemSection />}
            {section === 'migration' && <MigrationSection />}
          </div>
        </main>
      </div>
    </div>
  );
}
