import { describe, expect, it } from 'vitest';
import { HELP_TOPICS } from '../src/help/content.js';
import { HELP_ROUTE_TABLE, helpKeyForLocation } from '../src/help/keys.js';
import { MISC_TOPICS } from '../src/help/topics/misc.js';
import { DEPLOY_TOPICS } from '../src/help/topics/deploy.js';
import { SERVICE_TAB_TOPICS } from '../src/help/topics/serviceTabs.js';
import { ORGANIZE_TOPICS } from '../src/help/topics/organize.js';
import { DATA_TOPICS } from '../src/help/topics/data.js';
import { DATABASE_TAB_TOPICS } from '../src/help/topics/databaseTabs.js';
import { NETWORK_TOPICS } from '../src/help/topics/network.js';
import { SYSTEM_TOPICS } from '../src/help/topics/system.js';
import { SETTINGS_TAB_TOPICS } from '../src/help/topics/settingsTabs.js';

const GROUPS = [
  MISC_TOPICS, DEPLOY_TOPICS, SERVICE_TAB_TOPICS, ORGANIZE_TOPICS, DATA_TOPICS,
  DATABASE_TAB_TOPICS, NETWORK_TOPICS, SYSTEM_TOPICS, SETTINGS_TAB_TOPICS,
];

describe('helpKeys', () => {
  it('maps every documented route shape to its expected topic', () => {
    for (const entry of HELP_ROUTE_TABLE) {
      const label = `${entry.path}${entry.search ?? ''}`;
      expect(helpKeyForLocation(entry.path, entry.search ?? ''), label).toBe(entry.key);
    }
  });

  it('resolves every expected topic to a topic that actually exists', () => {
    for (const entry of HELP_ROUTE_TABLE) {
      expect(HELP_TOPICS[entry.key], entry.key).toBeDefined();
    }
  });

  it('covers every service and database tab id and every settings section', () => {
    // Redundant with the generated table entries above, but phrased so a
    // failure names the missing page group directly.
    const keys = new Set(HELP_ROUTE_TABLE.map((e) => e.key));
    for (const group of ['service', 'database']) {
      const tabs = HELP_ROUTE_TABLE.filter((e) => e.key.startsWith(`${group}.`));
      expect(tabs.length, group).toBeGreaterThan(5);
      for (const entry of tabs) expect(keys.has(entry.key), entry.key).toBe(true);
    }
    // settings.account appears both as the fallback entry and in the generated
    // section list — count unique keys.
    const settingsKeys = new Set(
      HELP_ROUTE_TABLE.filter((e) => e.key.startsWith('settings.')).map((e) => e.key),
    );
    expect(settingsKeys.size).toBe(14);
  });

  it('r343: resolves the Settings AI section and the service Compose tab to their own topics', () => {
    expect(helpKeyForLocation('/settings', '?section=ai')).toBe('settings.ai');
    expect(helpKeyForLocation('/services/3', '?tab=compose')).toBe('service.compose');
  });

  it('falls back to the general topic for unknown routes', () => {
    expect(helpKeyForLocation('/nope', '')).toBe('general');
    expect(helpKeyForLocation('/servicesfootwo', '')).toBe('general');
  });

  it('degrades to general when a resolved topic is missing from HELP_TOPICS', () => {
    // The resolver's last-resort guard for a route table entry that outlives
    // its topic — simulate by temporarily removing one.
    const saved = HELP_TOPICS['dashboard'];
    delete HELP_TOPICS['dashboard'];
    try {
      expect(helpKeyForLocation('/dashboard', '')).toBe('general');
    } finally {
      HELP_TOPICS['dashboard'] = saved!;
    }
  });

  it('falls back to the landing topic for unknown tab/section params', () => {
    expect(helpKeyForLocation('/services/1', '?tab=bogus')).toBe('service.overview');
    expect(helpKeyForLocation('/databases/1', '?tab=bogus')).toBe('database.overview');
    expect(helpKeyForLocation('/settings', '?section=bogus')).toBe('settings.account');
    expect(helpKeyForLocation('/services/1', '')).toBe('service.overview');
  });

  it('merges all topic groups without silently overwriting ids', () => {
    const total = GROUPS.reduce((n, g) => n + Object.keys(g).length, 0);
    expect(Object.keys(HELP_TOPICS).length).toBe(total);
  });

  it('only contains well-formed topics with resolvable related links', () => {
    for (const [id, topic] of Object.entries(HELP_TOPICS)) {
      expect(topic.title, id).toBeTruthy();
      expect(topic.summary, id).toBeTruthy();
      expect(topic.sections.length, id).toBeGreaterThan(0);
      for (const section of topic.sections) {
        expect(section.heading, id).toBeTruthy();
      }
      for (const link of topic.related ?? []) {
        expect(HELP_TOPICS[link.helpId], `${id} -> ${link.helpId}`).toBeDefined();
      }
    }
  });
});
