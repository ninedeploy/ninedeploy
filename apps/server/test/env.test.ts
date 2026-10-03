import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'NODE_ENV',
  'NINEDEPLOY_HOST',
  'NINEDEPLOY_PORT',
  'NINEDEPLOY_DATA_DIR',
  'NINEDEPLOY_DB_PATH',
  'NINEDEPLOY_PUBLIC_URL',
  'NINEDEPLOY_JWT_SECRET',
  'NINEDEPLOY_JWT_ACCESS_TTL',
  'NINEDEPLOY_JWT_REFRESH_TTL',
  'NINEDEPLOY_MASTER_KEY',
  'NINEDEPLOY_MASTER_KEYS',
] as const;

async function loadEnv() {
  vi.resetModules();
  const mod = await import('../src/env.js');
  return mod.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('env', () => {
  it('applies defaults when nothing is set', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const env = await loadEnv();
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      NINEDEPLOY_HOST: '0.0.0.0',
      NINEDEPLOY_PORT: 3000,
      NINEDEPLOY_DATA_DIR: './.data',
      NINEDEPLOY_DB_PATH: './.data/ninedeploy.db',
      NINEDEPLOY_PUBLIC_URL: 'http://localhost:3000',
      NINEDEPLOY_JWT_SECRET: 'dev-insecure-secret-change-me',
      NINEDEPLOY_JWT_ACCESS_TTL: '15m',
      NINEDEPLOY_JWT_REFRESH_TTL: '7d',
    });
    expect('NINEDEPLOY_MASTER_KEY' in env).toBe(false);
  });

  it('parses valid custom values', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_HOST', '127.0.0.1');
    vi.stubEnv('NINEDEPLOY_PORT', '8080');
    vi.stubEnv('NINEDEPLOY_DATA_DIR', '/tmp/ninedeploy-data');
    vi.stubEnv('NINEDEPLOY_DB_PATH', '/tmp/ninedeploy.db');
    vi.stubEnv('NINEDEPLOY_PUBLIC_URL', 'https://deploy.example.com');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'x'.repeat(32));
    vi.stubEnv('NINEDEPLOY_JWT_ACCESS_TTL', '30m');
    vi.stubEnv('NINEDEPLOY_JWT_REFRESH_TTL', '30d');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2');

    const env = await loadEnv();
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      NINEDEPLOY_HOST: '127.0.0.1',
      NINEDEPLOY_PORT: 8080,
      NINEDEPLOY_DATA_DIR: '/tmp/ninedeploy-data',
      NINEDEPLOY_DB_PATH: '/tmp/ninedeploy.db',
      NINEDEPLOY_PUBLIC_URL: 'https://deploy.example.com',
      NINEDEPLOY_JWT_SECRET: 'x'.repeat(32),
      NINEDEPLOY_JWT_ACCESS_TTL: '30m',
      NINEDEPLOY_JWT_REFRESH_TTL: '30d',
      NINEDEPLOY_MASTER_KEY: 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
    });
  });

  it('exits with code 1 and logs the error on invalid input', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.stubEnv('NINEDEPLOY_PORT', 'abc');
    const env = await loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(env).toBeUndefined();
  });

  it('exits when the public url is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.stubEnv('NINEDEPLOY_PUBLIC_URL', 'not-a-url');
    await loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses to boot in production with the insecure default JWT secret', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.stubEnv('NODE_ENV', 'production');
    // NINEDEPLOY_JWT_SECRET left at the default.
    await loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/NINEDEPLOY_JWT_SECRET/);
  });

  it('r177: a node agent boots in production without a panel JWT secret', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_AGENT', '1');
    await loadEnv();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('refuses to boot in production with the .env.example placeholder JWT secret', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.stubEnv('NODE_ENV', 'production');
    // The value shipped in .env.example — copying it verbatim must not boot.
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'change-me-to-a-long-random-string');
    await loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/NINEDEPLOY_JWT_SECRET/);
  });

  it('boots in production when a strong custom JWT secret is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-unique-production-secret');
    const env = await loadEnv();
    expect(env.NINEDEPLOY_JWT_SECRET).toBe('a-strong-unique-production-secret');
  });

  it('refuses to boot in production with a weak/short master key', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-unique-production-secret');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'deadbeef'); // 4 bytes — far too weak
    await loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/NINEDEPLOY_MASTER_KEY/);
  });

  it('refuses to boot in production with a change-me master key placeholder', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-unique-production-secret');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'change-me-to-a-long-random-string');
    await loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('boots in production with a strong 64-hex master key', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-unique-production-secret');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2');
    const env = await loadEnv();
    expect(env.NINEDEPLOY_MASTER_KEY).toBe('c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2');
  });

  // L-7: the rotation key-ring is read straight from process.env by
  // lib/crypto.ts, so it used to skip this guard entirely — an operator could
  // rotate ONTO a weak key with no warning.
  it('refuses to boot in production with a weak key in NINEDEPLOY_MASTER_KEYS', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-unique-production-secret');
    vi.stubEnv(
      'NINEDEPLOY_MASTER_KEYS',
      '0:c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2,1:deadbeef',
    );
    await loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/NINEDEPLOY_MASTER_KEYS version 1/);
  });

  it('boots in production with a fully strong NINEDEPLOY_MASTER_KEYS ring', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-unique-production-secret');
    vi.stubEnv(
      'NINEDEPLOY_MASTER_KEYS',
      '0:c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2,1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const env = await loadEnv();
    expect(env.NODE_ENV).toBe('production');
  });

  it('still rejects an all-zero key (the old regex only matched 0 and a-f)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NINEDEPLOY_JWT_SECRET', 'a-strong-unique-production-secret');
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', '0'.repeat(64));
    await loadEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
