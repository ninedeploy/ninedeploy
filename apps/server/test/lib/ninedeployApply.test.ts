import { describe, expect, it } from 'vitest';
import type { BuildConfig } from '@ninedeploy/db';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import { applyManifestToBuildConfig, findMissingRequiredEnv } from '../../src/lib/ninedeployApply.js';

const baseBuildConfig = (over: Partial<BuildConfig> = {}): BuildConfig => ({
  id: 1,
  serviceId: 1,
  buildPack: 'auto',
  baseDir: '/',
  installCmd: null,
  buildCmd: null,
  startCmd: null,
  dockerfilePath: null,
  preDeployCmd: null,
  postDeployCmd: null,
  preStopCmd: null,
  restartPolicy: 'unless-stopped',
  stopGraceSeconds: 5,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...over,
});

const manifest = (over: Partial<NinedeployManifest>): NinedeployManifest => ({
  version: '1',
  ...over,
});

describe('applyManifestToBuildConfig', () => {
  it('returns the same config when the manifest has no build fields', () => {
    const cfg = baseBuildConfig();
    const result = applyManifestToBuildConfig(manifest({}), cfg);
    expect(result.installCmd).toBeNull();
    expect(result.buildCmd).toBeNull();
    expect(result.startCmd).toBeNull();
    expect(result.baseDir).toBe('/');
    expect(result.dockerfilePath).toBeNull();
  });

  it('fills in install/build/start from the manifest when DB is empty', () => {
    const result = applyManifestToBuildConfig(
      manifest({
        build: { install: 'npm ci', build: 'npm run build', start: 'node server.js' },
      }),
      baseBuildConfig(),
    );
    expect(result.installCmd).toBe('npm ci');
    expect(result.buildCmd).toBe('npm run build');
    expect(result.startCmd).toBe('node server.js');
  });

  it('does NOT overwrite an install command already set in the panel', () => {
    const result = applyManifestToBuildConfig(
      manifest({ build: { install: 'npm ci' } }),
      baseBuildConfig({ installCmd: 'pnpm install --frozen-lockfile' }),
    );
    expect(result.installCmd).toBe('pnpm install --frozen-lockfile');
  });

  it('does NOT overwrite a baseDir that the panel has set to a real sub-path', () => {
    const result = applyManifestToBuildConfig(
      manifest({ build: { baseDir: 'apps/web' } }),
      baseBuildConfig({ baseDir: 'apps/admin' }),
    );
    expect(result.baseDir).toBe('apps/admin');
  });

  it('DOES overwrite the default baseDir "/" from a manifest value', () => {
    const result = applyManifestToBuildConfig(
      manifest({ build: { baseDir: 'apps/web' } }),
      baseBuildConfig({ baseDir: '/' }),
    );
    expect(result.baseDir).toBe('apps/web');
  });

  it('fills in a dockerfilePath from the manifest when DB is empty', () => {
    const result = applyManifestToBuildConfig(
      manifest({ build: { dockerfile: 'docker/Dockerfile.prod' } }),
      baseBuildConfig(),
    );
    expect(result.dockerfilePath).toBe('docker/Dockerfile.prod');
  });

  it('does NOT overwrite a dockerfilePath already set in the panel', () => {
    const result = applyManifestToBuildConfig(
      manifest({ build: { dockerfile: 'docker/Dockerfile.prod' } }),
      baseBuildConfig({ dockerfilePath: 'Dockerfile' }),
    );
    expect(result.dockerfilePath).toBe('Dockerfile');
  });

  it('leaves the rest of the build config untouched', () => {
    const cfg = baseBuildConfig({
      restartPolicy: 'on-failure:3',
      stopGraceSeconds: 10,
      preDeployCmd: 'echo before',
    });
    const result = applyManifestToBuildConfig(manifest({}), cfg);
    expect(result.restartPolicy).toBe('on-failure:3');
    expect(result.stopGraceSeconds).toBe(10);
    expect(result.preDeployCmd).toBe('echo before');
  });
});

describe('findMissingRequiredEnv', () => {
  it('returns an empty array when env.required is missing from the manifest', () => {
    expect(findMissingRequiredEnv(manifest({}), { NODE_ENV: 'production' })).toEqual([]);
  });

  it('returns an empty array when every required key is present', () => {
    expect(
      findMissingRequiredEnv(
        manifest({ env: { required: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] } }),
        { DATABASE_URL: 'postgres://db', STRIPE_SECRET_KEY: 'sk_test' },
      ),
    ).toEqual([]);
  });

  it('returns the missing keys in their declared order', () => {
    expect(
      findMissingRequiredEnv(
        manifest({ env: { required: ['A', 'B', 'C', 'D'] } }),
        { A: '1', C: '3' },
      ),
    ).toEqual(['B', 'D']);
  });

  it('treats an empty required array as "nothing required"', () => {
    expect(findMissingRequiredEnv(manifest({ env: { required: [] } }), {})).toEqual([]);
  });
});
