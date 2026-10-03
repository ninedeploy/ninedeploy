import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp } from '../helpers.js';
import staticFilesPlugin, { pickWebDist, registerStaticFiles, resolveWebDistFolder } from '../../src/plugins/staticFiles.js';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'nd-static-test-'));

function makeDist(sub: string, marker: string): string {
  const dir = path.join(tmpRoot, sub);
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), marker);
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['NINEDEPLOY_WEB_DIST'];
});

describe('pickWebDist', () => {
  it('returns the first candidate that contains index.html', () => {
    const a = makeDist('a', 'A');
    const b = makeDist('b', 'B');
    expect(pickWebDist([a, b])).toBe(a);
    expect(pickWebDist([b, a])).toBe(b);
  });

  it('skips undefined and index-less candidates', () => {
    const empty = path.join(tmpRoot, 'empty');
    mkdirSync(empty, { recursive: true });
    const good = makeDist('good', 'G');
    expect(pickWebDist([undefined, empty, good])).toBe(good);
    expect(pickWebDist([undefined, empty])).toBeNull();
  });
});

describe('resolveWebDistFolder', () => {
  it('honours the NINEDEPLOY_WEB_DIST override', () => {
    const dir = makeDist('env', 'E');
    vi.stubEnv('NINEDEPLOY_WEB_DIST', dir);
    expect(resolveWebDistFolder()).toBe(dir);
  });

  it('falls back to a layout candidate when the override is unusable', () => {
    vi.stubEnv('NINEDEPLOY_WEB_DIST', path.join(tmpRoot, 'does-not-exist'));
    const resolved = resolveWebDistFolder();
    expect(resolved).not.toBeNull();
  });
});

describe('registerStaticFiles', () => {
  it('is a no-op when no dist root is resolved', async () => {
    const app = await buildTestApp();
    const log = vi.spyOn(app.log, 'info');
    await registerStaticFiles(app, null);
    expect(log).toHaveBeenCalled();
    // No static plugin registered → Fastify's default 404 (not the SPA entry).
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('dashboard-here');
  });

  it('serves the dashboard with an SPA fallback and JSON 404s for API paths', async () => {
    const app = await buildTestApp();
    const root = makeDist('dash', '<html><body>dashboard-here</body></html>');
    await registerStaticFiles(app, root);

    // index.html at the root.
    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('dashboard-here');
    expect(home.headers['content-type']).toContain('text/html');

    // Real asset from the dist folder.
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');

    // SPA fallback: any non-API GET serves index.html.
    const spa = await app.inject({ method: 'GET', url: '/services/42' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('dashboard-here');

    // API paths never get the SPA entry — they keep Fastify's default 404 body.
    for (const url of ['/v1/nope', '/health/extra', '/hooks/x', '/events/y']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        message: `Route GET:${url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
    }

    // Non-GET stays a JSON 404 (no SPA entry for POSTs).
    const post = await app.inject({ method: 'POST', url: '/anything', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({
      message: 'Route POST:/anything not found',
      error: 'Not Found',
      statusCode: 404,
    });
  });
});

describe('staticFilesPlugin (default export)', () => {
  it('registers the dashboard from the env override', async () => {
    const app = await buildTestApp();
    vi.stubEnv('NINEDEPLOY_WEB_DIST', makeDist('plugin', '<html>plugin-dash</html>'));
    await app.register(staticFilesPlugin);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('plugin-dash');
  });
});
