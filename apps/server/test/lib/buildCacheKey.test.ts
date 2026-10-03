import { describe, expect, it } from 'vitest';
import { buildCacheKey } from '../../src/lib/buildCacheKey.js';

describe('buildCacheKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.' });
    const b = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.' });
    expect(a).toBe(b);
  });

  it('changes when commit changes', () => {
    const a = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.', commitSha: 'aaa' });
    const b = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.', commitSha: 'bbb' });
    expect(a).not.toBe(b);
  });

  it('changes when the dockerfile path changes', () => {
    const a = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.' });
    const b = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile.dev', baseDir: '.' });
    expect(a).not.toBe(b);
  });

  it('changes when the lastBuildDigest changes (chained cache)', () => {
    const a = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.', lastBuildDigest: 'sha256:aaa' });
    const b = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.', lastBuildDigest: 'sha256:bbb' });
    expect(a).not.toBe(b);
  });

  it('normalizes trailing slashes and windows back-slashes', () => {
    const a = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: './' });
    const b = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.' });
    const c = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.\\' });
    expect(a).toBe(b);
    expect(c).toBe(b);
  });

  it('falls back to stable sentinels when optional inputs are missing', () => {
    const a = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.' });
    expect(a).toMatch(/^ndbuild:[0-9a-f]{24}$/);
  });

  it('uses the optional commit + digest when supplied', () => {
    const a = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.', commitSha: 'aaa', lastBuildDigest: 'sha256:bbb' });
    const b = buildCacheKey({ serviceId: 1, dockerfilePath: 'Dockerfile', baseDir: '.', commitSha: 'aaa', lastBuildDigest: 'sha256:ccc' });
    expect(a).not.toBe(b);
  });
});
