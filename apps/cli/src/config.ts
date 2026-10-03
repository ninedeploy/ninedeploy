import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(homedir(), '.ninedeploy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  baseUrl: string;
  token?: string;
  /** Long-lived token used to mint fresh access tokens (see client.ts). */
  refreshToken?: string;
}

const DEFAULTS: CliConfig = { baseUrl: 'http://localhost:3000' };

export function loadConfig(): CliConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return { ...DEFAULTS, ...(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<CliConfig>) };
    }
  } catch (err) {
    // A torn/partial write used to fall back to defaults SILENTLY — the user
    // was logged out with no hint the file was ever corrupt. Say so.
    // eslint-disable-next-line no-console
    console.error(`⚠ Could not read ${CONFIG_FILE} (${err instanceof Error ? err.message : String(err)}); using defaults.`);
  }
  return { ...DEFAULTS };
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Temp-file + rename: a crash mid-write must never leave a half-written
  // config behind (the previous direct write could, logging the user out on
  // the next command with no explanation).
  const tmp = `${CONFIG_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  // writeFileSync's mode only applies at CREATION — re-assert 0600 so a file
  // that ever ended up group/world-readable (restore, copy, old version)
  // holding the bearer token is tightened on every save.
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best-effort on exotic filesystems */
  }
}
