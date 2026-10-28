import { type ReactNode, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../../lib/auth.js';
import {
  ArrowLeftRight,
  Bell,
  Bot,
  Boxes,
  DatabaseBackup,
  HardDrive,
  KeyRound,
  Network,
  Palette,
  Puzzle,
  Search,
  Server,
  Settings as SettingsIcon,
  Shield,
  Snowflake,
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
import { PanelBackupSection } from './PanelBackupSection.js';
import { SwarmSection } from './SwarmSection.js';
import { DeployFreezeSection } from './DeployFreezeSection.js';
import { AutofillRejectingInput, PageHeader, Select, cn } from '../../components/ui.js';
import { msg, useT } from '../../lib/i18n.js';

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
  | 'swarm'
  | 'deploy-freeze'
  | 'config'
  | 'plugins'
  | 'system'
  | 'panel-backup'
  | 'notifications'
  | 'migration';

interface SectionItem {
  id: SectionId;
  label: string;
  desc: string;
  icon: ReactNode;
  /** r472: backing routes are operator-only — members saw these sections
   * render error states (the Firewall one even read as "Not Installed"). */
  operatorOnly?: boolean;
}

interface SectionCategory {
  category: string;
  items: SectionItem[];
}

const SETTING_GROUPS: SectionCategory[] = [
  {
    category: msg('Personal & Access'),
    items: [
      { id: 'account', label: msg('Account'), desc: msg('Profile, credentials & passkeys'), icon: <User size={16} /> },
      { id: 'appearance', label: msg('Appearance'), desc: msg('Theme colors & density'), icon: <Palette size={16} /> },
      { id: 'security', label: msg('Security'), desc: msg('2FA, audit logs & sessions'), icon: <Shield size={16} /> },
      { id: 'sso', label: msg('SSO & OIDC'), desc: msg('Identity providers & auto-enroll'), icon: <KeyRound size={16} />, operatorOnly: true },
    ],
  },
  {
    category: msg('Integrations & Alerts'),
    items: [
      { id: 'integrations', label: msg('Integrations'), desc: msg('Vault secrets, DNS & S3'), icon: <Boxes size={16} />, operatorOnly: true },
      { id: 'ai', label: msg('AI Diagnosis'), desc: msg('BYO-key failed-deploy analysis'), icon: <Bot size={16} /> },
      { id: 'notifications', label: msg('Notifications'), desc: msg('Webhooks, Slack, Telegram'), icon: <Bell size={16} />, operatorOnly: true },
      { id: 'log-drains', label: msg('Log Drains'), desc: msg('Syslog, Datadog & Vector'), icon: <Terminal size={16} />, operatorOnly: true },
    ],
  },
  {
    category: msg('DevOps & Engine'),
    items: [
      { id: 'firewall', label: msg('Firewall (UFW)'), desc: msg('Host ports & inbound packet filter'), icon: <Shield size={16} />, operatorOnly: true },
      { id: 'storage', label: msg('Storage & Prune'), desc: msg('Disks, Docker prune & logs'), icon: <HardDrive size={16} />, operatorOnly: true },
      { id: 'swarm', label: msg('Swarm'), desc: msg('Multi-node orchestration & cluster'), icon: <Network size={16} />, operatorOnly: true },
      { id: 'deploy-freeze', label: msg('Deploy freeze'), desc: msg('Hold deploys during releases & incidents'), icon: <Snowflake size={16} />, operatorOnly: true },
      { id: 'config', label: msg('Config Center'), desc: msg('Global key-value configuration'), icon: <Sliders size={16} />, operatorOnly: true },
      { id: 'plugins', label: msg('Plugins'), desc: msg('Community plugins & extensions'), icon: <Puzzle size={16} /> },
    ],
  },
  {
    category: msg('Platform & Lifecycle'),
    items: [
      { id: 'system', label: msg('System'), desc: msg('Resources, version & updates'), icon: <Server size={16} />, operatorOnly: true },
      { id: 'panel-backup', label: msg('Panel backup'), desc: msg('Scheduled, encrypted self-backup'), icon: <DatabaseBackup size={16} />, operatorOnly: true },
      { id: 'migration', label: msg('Migration'), desc: msg('Full backups import/export'), icon: <ArrowLeftRight size={16} />, operatorOnly: true },
    ],
  },
];

/** Settings page shell: clean vertical sidebar navigation layout with search filter. */

/** Settings page shell: clean vertical sidebar navigation layout with search filter. */
export function Settings() {
  const { user } = useAuth();
  const t = useT();
  const isOperator = user?.isOperator === true;
  const [searchParams, setSearchParams] = useSearchParams();
  // Privilege filter first (r472): operator-only sections vanish from the
  // sidebar AND from deep-links — a member opening ?section=firewall falls
  // back to the landing section instead of rendering the false
  // "Not Installed" status a refused probe produced.
  const baseGroups = useMemo(
    () =>
      isOperator
        ? SETTING_GROUPS
        : SETTING_GROUPS.map((group) => ({
            ...group,
            items: group.items.filter((item) => !item.operatorOnly),
          })).filter((group) => group.items.length > 0),
    [isOperator],
  );
  // The active section lives in the URL (?section=…) so it deep-links and the
  // help drawer can show section-specific help. Unknown or missing values fall
  // back to the landing section instead of breaking the page.
  const sectionParam = searchParams.get('section');
  const section: SectionId = baseGroups.some((group) => group.items.some((item) => item.id === sectionParam))
    ? (sectionParam as SectionId)
    : 'account';
  const setSection = (next: SectionId) => setSearchParams({ section: next }, { replace: true });
  const [search, setSearch] = useState('');

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return baseGroups;
    const q = search.toLowerCase();
    return baseGroups.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => t(item.label).toLowerCase().includes(q) || t(item.desc).toLowerCase().includes(q),
      ),
    })).filter((group) => group.items.length > 0);
  }, [search, baseGroups, t]);

  return (
    <div className="space-y-6 nd-fade">
      <PageHeader
        icon={<SettingsIcon size={20} />}
        title={t('Settings & Platform Config')}
        subtitle={t('Manage instance preferences, security, storage, log sinks and system lifecycle.')}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Below lg: one picker instead of the sixteen-item list, which pushed
            the section itself a whole phone screen down. */}
        <div className="lg:hidden">
          <Select
            aria-label={t('Settings section')}
            value={section}
            onChange={(e) => setSection(e.target.value as SectionId)}
            className="h-10"
          >
            {baseGroups.map((group) => (
              <optgroup key={group.category} label={t(group.category)}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(item.label)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>

        {/* Categorized Vertical Sidebar */}
        <aside className="hidden lg:col-span-4 lg:block xl:col-span-3">
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
                placeholder={t('Filter settings...')}
                aria-label={t('Filter settings')}
                className="h-8 pl-8 pr-7 text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  aria-label={t('Clear filter')}
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <nav className="space-y-4" aria-label={t('Settings sections')}>
              {filteredGroups.length === 0 ? (
                <p className="p-3 text-center text-xs text-slate-500">{t('No settings matching "{search}"', { search })}</p>
              ) : (
                filteredGroups.map((group) => (
                  <div key={group.category} className="space-y-1">
                    <h3 className="px-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {t(group.category)}
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
                                {t(item.label)}
                              </div>
                              <div className="truncate text-[10px] text-slate-500">{t(item.desc)}</div>
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
            {section === 'swarm' && <SwarmSection />}
            {section === 'deploy-freeze' && <DeployFreezeSection />}
            {section === 'config' && <ConfigCenterSection />}
            {section === 'plugins' && <PluginsSection />}
            {section === 'system' && <SystemSection />}
            {section === 'panel-backup' && <PanelBackupSection />}
            {section === 'migration' && <MigrationSection />}
          </div>
        </main>
      </div>
    </div>
  );
}
