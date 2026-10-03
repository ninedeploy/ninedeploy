import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect the config module's homedir() to a temp dir before config.ts loads,
// so it never touches the real user's ~/.ninedeploy.
let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

let tmpDir: string;
let mod: typeof import('../src/config.js');

const configFile = () => path.join(fakeHome, '.ninedeploy', 'config.json');

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninedeploy-cli-test-'));
  fakeHome = tmpDir;
  vi.resetModules();
  mod = await import('../src/config.js');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), content);
}

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    expect(mod.loadConfig()).toEqual({ baseUrl: 'http://localhost:3000' });
  });

  it('merges a saved config file over the defaults', () => {
    writeConfig(JSON.stringify({ baseUrl: 'https://x.example', token: 'tok' }));
    expect(mod.loadConfig()).toEqual({ baseUrl: 'https://x.example', token: 'tok' });
  });

  it('fills missing fields from the defaults', () => {
    writeConfig(JSON.stringify({ token: 'tok' }));
    expect(mod.loadConfig()).toEqual({ baseUrl: 'http://localhost:3000', token: 'tok' });
  });

  it('falls back to defaults when the config file is corrupt JSON', () => {
    writeConfig('{ not json');
    expect(mod.loadConfig()).toEqual({ baseUrl: 'http://localhost:3000' });
  });
});

describe('saveConfig', () => {
  it('creates the config directory and writes the file with restrictive permissions', () => {
    expect(fs.existsSync(path.dirname(configFile()))).toBe(false);

    mod.saveConfig({ baseUrl: 'https://x.example', token: 'secret' });

    expect(fs.existsSync(configFile())).toBe(true);
    const stat = fs.statSync(configFile());
    // chmodSync is a no-op on Windows (ACL-based); skip the mode check there.
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8'))).toEqual({
      baseUrl: 'https://x.example',
      token: 'secret',
    });
  });

  it('round-trips through loadConfig', () => {
    mod.saveConfig({ baseUrl: 'https://x.example' });
    expect(mod.loadConfig()).toEqual({ baseUrl: 'https://x.example' });
  });
});
