import { HELP_TOPICS } from './content.js';

/**
 * Tab/section ids mirrored from the route components that own them:
 * - service tabs: src/routes/service/index.tsx (TabId / SERVICE_TABS)
 * - database tabs: src/routes/DatabaseDetail.tsx
 * - settings sections: src/routes/settings/index.tsx (SectionId / SETTING_GROUPS)
 * Keep in sync — the helpKeys test guards the route table below, and the
 * Settings page validates `?section=` against its own list.
 */
export const SERVICE_TAB_IDS = [
  'overview', 'terminal', 'architecture', 'manifest', 'compose', 'deploys', 'environment',
  'network', 'volumes', 'files', 'framework', 'settings', 'activity', 'danger',
] as const;

export const DATABASE_TAB_IDS = [
  'overview', 'topology', 'manifest', 'files', 'backups', 'logs', 'settings',
] as const;

export const SETTINGS_SECTION_IDS = [
  'account', 'appearance', 'security', 'sso', 'integrations', 'ai', 'notifications',
  'log-drains', 'storage', 'firewall', 'config', 'plugins', 'system', 'migration',
] as const;

/** Plain path prefixes mapped to a help topic; longest prefix wins. */
const PATH_KEYS: Array<[prefix: string, key: string]> = [
  ['/manifest-creator', 'manifest-creator'],
  ['/workspaces', 'workspaces'],
  ['/dashboard', 'dashboard'],
  ['/databases', 'databases'],
  ['/topology', 'topology'],
  ['/activity', 'activity'],
  ['/monitoring', 'monitoring'],
  ['/services', 'services'],
  ['/projects', 'projects'],
  ['/networks', 'networks'],
  ['/tunnels', 'tunnels'],
  ['/domains', 'domains'],
  ['/backups', 'backups'],
  ['/volumes', 'volumes'],
  ['/sources', 'sources'],
  ['/servers', 'servers'],
  ['/traefik', 'traefik'],
  ['/settings', 'settings.account'],
  ['/labels', 'labels'],
  ['/docker', 'docker'],
  ['/users', 'users'],
  ['/about', 'about'],
  ['/hub', 'hub'],
  ['/', 'dashboard'],
];

/**
 * Every URL shape the panel can be on and the help topic it should show.
 * Doubles as the integrity test fixture (test/helpKeys.test.ts).
 */
export const HELP_ROUTE_TABLE: Array<{ path: string; search?: string; key: string }> = [
  { path: '/', key: 'dashboard' },
  { path: '/dashboard', key: 'dashboard' },
  { path: '/hub', key: 'hub' },
  { path: '/manifest-creator', key: 'manifest-creator' },
  { path: '/services', key: 'services' },
  { path: '/services/42', key: 'service.overview' },
  ...SERVICE_TAB_IDS.map((tab) => ({ path: '/services/42', search: `?tab=${tab}`, key: `service.${tab}` })),
  { path: '/workspaces', key: 'workspaces' },
  { path: '/projects', key: 'projects' },
  { path: '/labels', key: 'labels' },
  { path: '/databases', key: 'databases' },
  { path: '/databases/7', key: 'database.overview' },
  ...DATABASE_TAB_IDS.map((tab) => ({ path: '/databases/7', search: `?tab=${tab}`, key: `database.${tab}` })),
  { path: '/volumes', key: 'volumes' },
  { path: '/backups', key: 'backups' },
  { path: '/domains', key: 'domains' },
  { path: '/traefik', key: 'traefik' },
  { path: '/networks', key: 'networks' },
  { path: '/tunnels', key: 'tunnels' },
  { path: '/topology', key: 'topology' },
  { path: '/activity', key: 'activity' },
  { path: '/monitoring', key: 'monitoring' },
  { path: '/docker', key: 'docker' },
  { path: '/sources', key: 'sources' },
  { path: '/servers', key: 'servers' },
  { path: '/users', key: 'users' },
  { path: '/about', key: 'about' },
  { path: '/settings', key: 'settings.account' },
  ...SETTINGS_SECTION_IDS.map((section) => ({ path: '/settings', search: `?section=${section}`, key: `settings.${section}` })),
  { path: '/somewhere-else', key: 'general' },
];

function resolveKey(pathname: string, params: URLSearchParams): string {
  // Detail routes read their tab from the query string and fall back to the
  // page's landing topic for unknown tab values.
  if (pathname.startsWith('/services/')) {
    const tab = params.get('tab') ?? '';
    return (SERVICE_TAB_IDS as readonly string[]).includes(tab) ? `service.${tab}` : 'service.overview';
  }
  if (pathname.startsWith('/databases/')) {
    const tab = params.get('tab') ?? '';
    return (DATABASE_TAB_IDS as readonly string[]).includes(tab) ? `database.${tab}` : 'database.overview';
  }
  if (pathname.startsWith('/settings')) {
    const section = params.get('section') ?? '';
    return (SETTINGS_SECTION_IDS as readonly string[]).includes(section) ? `settings.${section}` : 'settings.account';
  }
  // Longest matching prefix wins (the table is ordered longest-first for the
  // overlapping prefixes; the bare '/' entry must be checked last).
  const ordered = [...PATH_KEYS].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, key] of ordered) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return key;
  }
  return 'general';
}

/**
 * Help topic id for the given location. Always returns a key that exists in
 * HELP_TOPICS — unknown routes/topics degrade to 'general' instead of
 * breaking the drawer when new pages ship without a topic yet.
 */
export function helpKeyForLocation(pathname: string, search: string): string {
  const key = resolveKey(pathname, new URLSearchParams(search));
  return key in HELP_TOPICS ? key : 'general';
}
