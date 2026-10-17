import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ config: { isProd: true, paths: { dataDir: '' } } }));
vi.mock('../../src/config.js', () => cfg);

import { assertSetupToken, clearSetupTokenFile, requiredSetupToken, setupTokenFile } from '../../src/lib/setupToken.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nd-setup-token-'));
  cfg.config.paths.dataDir = dir;
  cfg.config.isProd = true;
  delete process.env['NINEDEPLOY_SETUP_TOKEN'];
});

afterEach(() => {
  delete process.env['NINEDEPLOY_SETUP_TOKEN'];
  rmSync(dir, { recursive: true, force: true });
});

describe('setup token (0.16)', () => {
  it('development without the env var keeps the open bootstrap', () => {
    cfg.config.isProd = false;
    expect(requiredSetupToken()).toBeNull();
    expect(() => assertSetupToken(undefined)).not.toThrow();
    expect(existsSync(setupTokenFile())).toBe(false);
  });

  it('the env var wins and is required in any mode', () => {
    cfg.config.isProd = false;
    process.env['NINEDEPLOY_SETUP_TOKEN'] = '  from-the-installer  ';
    expect(requiredSetupToken()).toBe('from-the-installer');
    expect(() => assertSetupToken('from-the-installer')).not.toThrow();
    expect(() => assertSetupToken('nope')).toThrow(expect.objectContaining({ statusCode: 403, code: 'setup_token_required' }));
    expect(existsSync(setupTokenFile())).toBe(false);
  });

  it('production without the env var generates a stable 0600 token file', () => {
    const first = requiredSetupToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(readFileSync(setupTokenFile(), 'utf8').trim()).toBe(first);
    if (process.platform !== 'win32') expect(statSync(setupTokenFile()).mode & 0o777).toBe(0o600);
    expect(requiredSetupToken()).toBe(first);
    expect(() => assertSetupToken(undefined)).toThrow(expect.objectContaining({ code: 'setup_token_required' }));
    expect(() => assertSetupToken(first!)).not.toThrow();
  });

  it('a truncated token file is regenerated rather than trusted', () => {
    writeFileSync(setupTokenFile(), 'short\n');
    const token = requiredSetupToken();
    expect(token).not.toBe('short');
    expect(token!.length).toBeGreaterThanOrEqual(16);
  });

  it('clearSetupTokenFile removes the generated file', () => {
    requiredSetupToken();
    clearSetupTokenFile();
    expect(existsSync(setupTokenFile())).toBe(false);
    expect(() => clearSetupTokenFile()).not.toThrow();
  });
});
