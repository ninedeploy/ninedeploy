import type { HelpTopic } from './types.js';
import { MISC_TOPICS } from './topics/misc.js';
import { DEPLOY_TOPICS } from './topics/deploy.js';
import { SERVICE_TAB_TOPICS } from './topics/serviceTabs.js';
import { ORGANIZE_TOPICS } from './topics/organize.js';
import { DATA_TOPICS } from './topics/data.js';
import { DATABASE_TAB_TOPICS } from './topics/databaseTabs.js';
import { NETWORK_TOPICS } from './topics/network.js';
import { SYSTEM_TOPICS } from './topics/system.js';
import { SETTINGS_TAB_TOPICS } from './topics/settingsTabs.js';

/**
 * Every help topic, keyed by the ids `helpKeyForLocation` produces (see
 * keys.ts). The per-page integrity test asserts the two stay in sync.
 */
export const HELP_TOPICS: Record<string, HelpTopic> = {
  ...MISC_TOPICS,
  ...DEPLOY_TOPICS,
  ...SERVICE_TAB_TOPICS,
  ...ORGANIZE_TOPICS,
  ...DATA_TOPICS,
  ...DATABASE_TAB_TOPICS,
  ...NETWORK_TOPICS,
  ...SYSTEM_TOPICS,
  ...SETTINGS_TAB_TOPICS,
};
