import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStaticConf, renderStaticDockerfile, resolveStaticOutput, buildStaticSite } from '../../src/engine/builders/staticSite.js';

/**
 * Static build pack: pure renderers get direct tests, and buildStaticSite is
 * exercised end-to-end with a stubbed exec module (the run() calls are the
 * only side effects — everything else is real filesystem work in a temp dir).
 */
vi.mock('../../src/lib/exec.js', () => ({
  run: vi.fn(async () => undefined),
}));
import { run } from '../../src/lib/exec.js';

describe('renderStaticConf / renderStaticDockerfile', () => {
  it('spa conf falls missing paths back to index.html', () => {
    expect(renderStaticConf(true)).toContain('try_files $uri $uri/ /index.html;');
  });

  it('non-spa conf 404s missing paths', () => {
    expect(renderStaticConf(false)).toContain('try_files $uri =404;');
  });

  it('dockerfile copies the requested output dir', () => {
    expect(renderStaticDockerfile('build/output')).toContain('COPY build/output/ /usr/share/nginx/html');
  });
});

describe('resolveStaticOutput', () => {
  const base = path.resolve('/work/apps/web');

  it('resolves a relative dir inside the build context', () => {
    const out = resolveStaticOutput(base, 'build/dist');
    expect(out.abs).toBe(path.resolve(base, 'build/dist'));
    expect(out.relFromBase).toBe('build/dist');
  });

  it('defaults to dist', () => {
    expect(resolveStaticOutput(base, null).relFromBase).toBe('dist');
  });

  it('refuses dirs that escape the build context', () => {
    expect(() => resolveStaticOutput(base, '../../etc')).toThrow('escapes the build context');
  });
});

describe('buildStaticSite', () => {
  let dir: string;

  beforeEach(() => {
    vi.mocked(run).mockClear();
    dir = mkdtempSync(path.join(os.tmpdir(), 'nd-static-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seedOutput = () => {
    const out = path.join(dir, 'dist');
    require('node:fs').mkdirSync(out, { recursive: true });
    require('node:fs').writeFileSync(path.join(out, 'index.html'), '<html></html>');
    return out;
  };

  it('runs install then build commands and generates the image files', async () => {
    seedOutput();
    await buildStaticSite(
      {
        workDir: dir,
        baseDir: dir,
        buildConfig: { installCmd: 'npm ci', buildCmd: 'npm run build', outputDir: 'dist', staticSpa: true },
        env: {},
        log: () => undefined,
      },
      'nd/web:abc',
    );
    const calls = vi.mocked(run).mock.calls.map((c) => c[1]);
    expect(calls[0]).toEqual(['-c', 'npm ci']);
    expect(calls[1]).toEqual(['-c', 'npm run build']);
    expect(calls[2]).toEqual(['build', '-t', 'nd/web:abc', '-f', 'Dockerfile.static', dir]);
    const dockerfile = readFileSync(path.join(dir, 'Dockerfile.static'), 'utf8');
    expect(dockerfile).toContain('COPY dist/ /usr/share/nginx/html');
    const conf = readFileSync(path.join(dir, 'nginx-static.conf'), 'utf8');
    expect(conf).toContain('try_files $uri $uri/ /index.html;');
  });

  it('requires a build command', async () => {
    await expect(
      buildStaticSite({ workDir: dir, baseDir: dir, buildConfig: { buildCmd: null }, env: {}, log: () => undefined }, 't'),
    ).rejects.toThrow('requires a build command');
  });

  it('fails when the build produced no index.html', async () => {
    await expect(
      buildStaticSite(
        { workDir: dir, baseDir: dir, buildConfig: { buildCmd: 'echo skip', outputDir: 'dist' }, env: {}, log: () => undefined },
        't',
      ),
    ).rejects.toThrow('no index.html');
  });
});
