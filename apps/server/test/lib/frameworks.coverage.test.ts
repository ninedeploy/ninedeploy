import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeRepo, sanitizeNodeVersion, summarizeInsights } from '../../src/lib/frameworks.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nd-frameworks-cov-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  const root = path.resolve(dir);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`fixture path escapes the temp dir: ${rel}`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};
const pkgJson = (fields: unknown) => write('package.json', JSON.stringify(fields));
const detect = (deps: Record<string, string>, dev: Record<string, string> = {}) => {
  pkgJson({ dependencies: deps, devDependencies: dev });
  return analyzeRepo(dir);
};

describe('analyzeRepo — every Node framework branch', () => {
  it('Nuxt 2 keeps the package start script; Nuxt without a version uses Nitro', () => {
    const nuxt2 = detect({ nuxt: '^2.17.0' });
    expect(nuxt2.framework.id).toBe('nuxt');
    expect(nuxt2.frameworkVersion).toBe('2.17.0');
    expect(nuxt2.framework.startCmd).toBe('npm start');
    const latest = detect({ nuxt: 'latest' });
    expect(latest.frameworkVersion).toBeNull();
    expect(latest.framework.startCmd).toBe('node .output/server/index.mjs');
  });

  it('Remix from any of its packages, versioned from node or react', () => {
    expect(detect({ '@remix-run/node': '2.9.1' })).toMatchObject({ framework: { id: 'remix', name: 'Remix' }, frameworkVersion: '2.9.1' });
    expect(detect({ '@remix-run/react': '^2.8' }).frameworkVersion).toBe('2.8');
    const devOnly = detect({}, { '@remix-run/dev': '2.0.0' });
    expect(devOnly.framework.id).toBe('remix');
    expect(devOnly.frameworkVersion).toBeNull();
  });

  it('SvelteKit: static adapter vs node adapter', () => {
    const stat = detect({ '@sveltejs/kit': '2.5.0' }, { '@sveltejs/adapter-static': '3.0.0' });
    expect(stat.framework).toMatchObject({ id: 'sveltekit', category: 'static', startCmd: null });
    expect(stat.framework.notes[0]).toContain('adapter-static');
    const node = detect({ '@sveltejs/kit': '2.5.0', '@sveltejs/adapter-node': '5.0.0' });
    expect(node.framework).toMatchObject({ category: 'ssr', startCmd: 'node build' });
  });

  it('Astro: SSR with a node or named adapter, static otherwise', () => {
    expect(detect({ astro: '4.1.0', '@astrojs/node': '8.0.0' }).framework).toMatchObject({ id: 'astro', category: 'ssr', startCmd: 'node ./dist/server/entry.mjs', port: 4321 });
    expect(detect({ astro: '4.1.0', '@astrojs/adapter-x': '1.0.0' }).framework.category).toBe('ssr');
    expect(detect({ astro: '4.1.0' }).framework).toMatchObject({ category: 'static', startCmd: null });
  });

  it('Angular, Gatsby', () => {
    expect(detect({ '@angular/core': '^17.3.0' })).toMatchObject({ framework: { id: 'angular', port: 4200, startCmd: null }, frameworkVersion: '17.3.0' });
    expect(detect({ gatsby: '5.13.1' })).toMatchObject({ framework: { id: 'gatsby', port: 8080, category: 'static' }, frameworkVersion: '5.13.1' });
  });

  it('Vite flavors: Vue and plain', () => {
    expect(detect({ vue: '3.4.0' }, { vite: '5.0.0' }).framework.name).toBe('Vite (Vue)');
    expect(detect({}, { vite: '5.0.0' }).framework.name).toBe('Vite');
  });

  it('plain React, Vue and Svelte SPAs', () => {
    expect(detect({ react: '18.2.0' })).toMatchObject({ framework: { id: 'spa', name: 'React' }, frameworkVersion: '18.2.0' });
    expect(detect({ vue: '3.4.0' }).framework.name).toBe('Vue');
    expect(detect({ svelte: '4.2.0' })).toMatchObject({ framework: { name: 'Svelte' }, frameworkVersion: '4.2.0' });
  });

  it('Node backends: Fastify, Koa, Hapi', () => {
    expect(detect({ fastify: '4.26.0' })).toMatchObject({ framework: { id: 'node-backend', name: 'Fastify' }, frameworkVersion: '4.26.0' });
    expect(detect({ koa: '2.15.0' }).framework.name).toBe('Koa');
    expect(detect({ '@hapi/hapi': '21.3.0' })).toMatchObject({ framework: { name: 'Hapi' }, frameworkVersion: '21.3.0' });
  });

  it('a package.json with no known framework is plain Node', () => {
    const r = detect({ lodash: '4.17.21' });
    expect(r.framework).toMatchObject({ id: 'node', name: 'Node.js' });
    expect(r.frameworkVersion).toBeNull();
  });
});

describe('analyzeRepo — package.json narrowing and package managers', () => {
  it('drops non-string fields from member-controlled JSON (F124)', () => {
    pkgJson({ name: 5, scripts: { build: {}, start: 'node .' }, dependencies: ['x'], engines: { node: 20 }, packageManager: 1 });
    const r = analyzeRepo(dir);
    expect(r.scripts).toEqual({ start: 'node .' });
    expect(r.dependencyCount).toBe(0);
    expect(r.nodeVersion).toBeNull();
    expect(r.packageManager).toBeNull();
  });

  it('a JSON array package.json is analyzed as an empty Node project; JSON null and broken JSON are not Node', () => {
    pkgJson([1, 2]);
    expect(analyzeRepo(dir).framework.id).toBe('node');
    write('package.json', 'null');
    expect(analyzeRepo(dir).language).toBe('unknown');
    write('package.json', '{ not json');
    expect(analyzeRepo(dir).language).toBe('unknown');
  });

  it('an unknown packageManager falls back to the lockfile, which keeps the frozen install', () => {
    pkgJson({ dependencies: { express: '4.0.0' }, packageManager: 'deno@1.0.0' });
    write('yarn.lock', '');
    const r = analyzeRepo(dir);
    expect(r.packageManager).toBe('yarn');
    expect(r.framework.installCmd).toBe('yarn install --immutable');
    expect(r.framework.buildCmd).toBe('yarn build');
    expect(r.framework.startCmd).toBe('yarn start');
  });

  it('a packageManager without @version is ignored; bun.lock and package-lock map to bun and npm', () => {
    pkgJson({ dependencies: {}, packageManager: 'pnpm' });
    write('bun.lock', '');
    const bun = analyzeRepo(dir);
    expect(bun.packageManager).toBe('bun');
    expect(bun.framework).toMatchObject({ installCmd: 'bun install', buildCmd: 'bun run build', startCmd: 'bun start' });
    rmSync(path.join(dir, 'bun.lock'));
    write('package-lock.json', '{}');
    expect(analyzeRepo(dir).framework.installCmd).toBe('npm ci');
  });

  it('reads the node version from .nvmrc first, ignoring a non-version .nvmrc', () => {
    pkgJson({ engines: { node: '^20.x' } });
    write('.nvmrc', 'lts/iron\n');
    let r = analyzeRepo(dir);
    expect(r.nodeVersion).toBe('lts/iron');
    expect(r.detectedFiles).toContain('.nvmrc');
    write('.nvmrc', 'JWT_SECRET=leaked\n');
    r = analyzeRepo(dir);
    expect(r.nodeVersion).toBe('^20.x');
  });

  it('a directory named .nvmrc and an oversized marker are not read', () => {
    pkgJson({});
    mkdirSync(path.join(dir, '.nvmrc'));
    expect(analyzeRepo(dir).detectedFiles).not.toContain('.nvmrc');
    rmSync(path.join(dir, '.nvmrc'), { recursive: true });
    write('.nvmrc', `20${' '.repeat(2 * 1024 * 1024 + 10)}`);
    const r = analyzeRepo(dir);
    expect(r.nodeVersion).toBeNull();
    expect(r.detectedFiles).not.toContain('.nvmrc');
  });

  it('detects compose files and monorepo markers', () => {
    pkgJson({});
    write('compose.yaml', 'services: {}\n');
    write('turbo.json', '{}');
    const r = analyzeRepo(dir, '', 'abc123');
    expect(r.hasComposeFile).toBe(true);
    expect(r.monorepo).toBe(true);
    expect(r.commitSha).toBe('abc123');
  });
});

describe('analyzeRepo — workspaces', () => {
  it('reads workspaces.packages objects and lerna.json, skipping empty globs and broken members', () => {
    pkgJson({ workspaces: { packages: ['apps/*', '  ', 7] } });
    write('lerna.json', JSON.stringify({ packages: ['libs/*'] }));
    write('apps/web/package.json', JSON.stringify({ dependencies: { gatsby: '5.0.0' } }));
    write('apps/broken/package.json', '{ nope');
    write('libs/core/package.json', JSON.stringify({ name: 'core' }));
    write('apps/.hidden/package.json', JSON.stringify({ name: 'hidden' }));
    const r = analyzeRepo(dir);
    expect(r.monorepo).toBe(true);
    expect(r.workspacePackages).toEqual([
      { dir: 'apps/web', name: null, framework: 'Gatsby', frameworkVersion: '5.0.0' },
      { dir: 'libs/core', name: 'core', framework: 'Node.js', frameworkVersion: null },
    ]);
  });

  it('a workspaces object without packages and a pnpm list that ends early', () => {
    pkgJson({ workspaces: { nohoist: ['x'] } });
    write('pnpm-workspace.yaml', "packages:\n\n  - 'a/*'\nonlyBuiltDependencies:\n  - 'b/*'\n");
    write('a/one/package.json', JSON.stringify({ dependencies: { koa: '2.0.0' } }));
    write('b/two/package.json', JSON.stringify({}));
    const r = analyzeRepo(dir);
    expect(r.monorepo).toBe(true);
    expect(r.workspacePackages.map((p) => p.dir)).toEqual(['a/one']);
  });

  it('a pnpm-workspace.yaml without a packages key adds nothing', () => {
    pkgJson({});
    write('pnpm-workspace.yaml', 'catalog:\n  react: 18\n');
    const r = analyzeRepo(dir);
    expect(r.workspacePackages).toEqual([]);
    expect(r.monorepo).toBe(true); // the marker file itself
  });
});

describe('analyzeRepo — Python', () => {
  it('Flask from requirements.txt, case-insensitive and at end of file', () => {
    write('requirements.txt', 'gunicorn\nFlask');
    const r = analyzeRepo(dir);
    expect(r.framework).toMatchObject({ id: 'flask', startCmd: 'gunicorn --bind 0.0.0.0:$PORT app:app' });
  });

  it('plain Python without a framework', () => {
    write('requirements.txt', 'requests==2.31.0\n');
    expect(analyzeRepo(dir).framework).toMatchObject({ id: 'python', startCmd: null });
  });

  it('pyproject.toml dependencies section and Pipfile', () => {
    write('pyproject.toml', '[project]\nname = "x"\ndependencies = ["fastapi>=0.110", "uvicorn"]\n');
    const r = analyzeRepo(dir);
    expect(r.framework.id).toBe('fastapi');
    expect(r.framework.installCmd).toBe('pip install -r requirements.txt');
    expect(r.detectedFiles).toContain('pyproject.toml');
    rmSync(path.join(dir, 'pyproject.toml'));
    write('Pipfile', '[packages]\ndjango = "*"\n');
    expect(analyzeRepo(dir).framework.id).toBe('django');
  });
});

describe('sanitizeNodeVersion and summarizeInsights', () => {
  it('accepts versions and ranges, refuses everything else', () => {
    expect(sanitizeNodeVersion(20)).toBeNull();
    expect(sanitizeNodeVersion('   ')).toBeNull();
    expect(sanitizeNodeVersion('1'.repeat(65))).toBeNull();
    expect(sanitizeNodeVersion(' v20.11.1 ')).toBe('v20.11.1');
    expect(sanitizeNodeVersion('node')).toBe('node');
    expect(sanitizeNodeVersion('>=18 <21')).toBe('>=18 <21');
    expect(sanitizeNodeVersion('/proc/self/environ')).toBeNull();
  });

  it('summarizes a bare detection with only the framework name', () => {
    pkgJson({});
    expect(summarizeInsights(analyzeRepo(dir))).toBe('Detected Node.js');
  });
});
