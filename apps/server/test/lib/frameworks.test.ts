import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeRepo, summarizeInsights } from '../../src/lib/frameworks.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nd-frameworks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a fixture file. `rel` is test-controlled and containment-checked so
 * the helper itself enforces the temp-dir boundary. */
const write = (rel: string, content: string) => {
  const root = path.resolve(dir);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`fixture path escapes the temp dir: ${rel}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const pkgJson = (fields: Record<string, unknown>) => write('package.json', JSON.stringify(fields));

describe('analyzeRepo — Node frameworks', () => {
  it('detects Next.js with version, lockfile package manager and node engine', () => {
    pkgJson({
      name: 'web',
      dependencies: { next: '^15.1.2', react: '^19.0.0' },
      devDependencies: { typescript: '^5' },
      scripts: { build: 'next build', start: 'next start' },
      engines: { node: '>=20' },
    });
    write('pnpm-lock.yaml', '');

    const insights = analyzeRepo(dir);
    expect(insights.framework.id).toBe('nextjs');
    expect(insights.framework.name).toBe('Next.js');
    expect(insights.frameworkVersion).toBe('15.1.2');
    expect(insights.packageManager).toBe('pnpm');
    expect(insights.nodeVersion).toBe('>=20');
    expect(insights.framework.port).toBe(3000);
    // Commands adapt to the detected package manager.
    expect(insights.framework.installCmd).toBe('pnpm install --frozen-lockfile');
    expect(insights.framework.buildCmd).toBe('pnpm run build');
    expect(insights.framework.startCmd).toBe('pnpm start');
    expect(insights.dependencyCount).toBe(2);
    expect(insights.devDependencyCount).toBe(1);
    expect(insights.scripts['start']).toBe('next start');
    // Next.js telemetry is part of the preset.
    expect(insights.framework.env.map((e) => e.key)).toContain('NEXT_TELEMETRY_DISABLED');
  });

  it('prefers the packageManager field over the lockfile', () => {
    pkgJson({ dependencies: { express: '^4' }, packageManager: 'yarn@4.1.0' });
    write('package-lock.json', '');

    const insights = analyzeRepo(dir);
    expect(insights.packageManager).toBe('yarn');
    expect(insights.framework.id).toBe('node-backend');
    // The pnpm/yarn/bun runners have no per-lockfile install variant; the
    // suggestion follows the lockfile that is actually present.
    expect(insights.framework.installCmd).toBe('yarn install --immutable');
  });

  it('falls back to npm install without a lockfile', () => {
    pkgJson({ dependencies: { express: '^4' } });

    const insights = analyzeRepo(dir);
    expect(insights.packageManager).toBeNull();
    expect(insights.framework.installCmd).toBe('npm install');
  });

  it('detects Nuxt 3 and suggests the Nitro server start command', () => {
    pkgJson({ dependencies: { nuxt: '^3.12.0', vue: '^3.4.0' } });

    const insights = analyzeRepo(dir);
    expect(insights.framework.id).toBe('nuxt');
    expect(insights.framework.startCmd).toBe('node .output/server/index.mjs');
    expect(insights.framework.env.map((e) => e.key)).toContain('HOST');
  });

  it('treats Vite as a static SPA with no start command', () => {
    pkgJson({
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '^5.0.0' },
      scripts: { build: 'vite build' },
    });

    const insights = analyzeRepo(dir);
    expect(insights.framework.id).toBe('vite');
    expect(insights.framework.category).toBe('spa');
    expect(insights.framework.startCmd).toBeNull();
    expect(insights.framework.port).toBe(4173);
  });

  it('detects NestJS with the dist entrypoint', () => {
    pkgJson({ dependencies: { '@nestjs/core': '^10.0.0' } });

    const insights = analyzeRepo(dir);
    expect(insights.framework.id).toBe('nestjs');
    expect(insights.framework.startCmd).toBe('node dist/main');
  });

  it('recognizes monorepos and Dockerfiles', () => {
    pkgJson({ workspaces: ['apps/*'] });
    write('Dockerfile', 'FROM node:20\n');

    const insights = analyzeRepo(dir);
    expect(insights.monorepo).toBe(true);
    expect(insights.hasDockerfile).toBe(true);
    // A repo Dockerfile re-anchors the notes: suggestions apply to Nixpacks only.
    expect(insights.framework.notes[0]).toContain('Dockerfile');
    expect(insights.detectedFiles).toContain('Dockerfile');
    expect(insights.detectedFiles).toContain('package.json');
  });

  it('enumerates workspace packages with per-package framework labels', () => {
    pkgJson({ private: true, workspaces: ['apps/*', 'packages/*'] });
    write('apps/web/package.json', JSON.stringify({ name: '@acme/web', dependencies: { next: '^15.0.0' } }));
    write('apps/api/package.json', JSON.stringify({ name: '@acme/api', dependencies: { express: '^4.18.0' } }));
    // A directory matching the glob but without a package.json is not a member.
    write('apps/scripts/run.sh', 'echo hi\n');
    // node_modules-looking directories are never descended into.
    write('apps/web/node_modules/next/package.json', JSON.stringify({ name: 'next' }));

    const insights = analyzeRepo(dir);
    expect(insights.monorepo).toBe(true);
    const dirs = insights.workspacePackages.map((p) => p.dir);
    expect(dirs).toEqual(['apps/api', 'apps/web']);
    const web = insights.workspacePackages.find((p) => p.dir === 'apps/web');
    expect(web?.name).toBe('@acme/web');
    expect(web?.framework).toBe('Next.js');
    expect(web?.frameworkVersion).toBe('15.0.0');
    const api = insights.workspacePackages.find((p) => p.dir === 'apps/api');
    expect(api?.framework).toBe('Express');
  });

  it('reads workspace globs from pnpm-workspace.yaml and lerna.json', () => {
    pkgJson({ private: true });
    write('pnpm-workspace.yaml', 'packages:\n  - "packages/**"\n');
    write('packages/ui/package.json', JSON.stringify({ name: '@acme/ui', dependencies: { vite: '^5.0.0' } }));
    expect(analyzeRepo(dir).workspacePackages.map((p) => p.dir)).toEqual(['packages/ui']);
  });

  it('does not list workspace members for a base-dir scoped analysis', () => {
    pkgJson({ private: true, workspaces: ['apps/*'] });
    write('apps/web/package.json', JSON.stringify({ dependencies: { next: '^15.0.0' } }));

    const scoped = analyzeRepo(dir, '/apps/web');
    expect(scoped.framework.id).toBe('nextjs');
    expect(scoped.workspacePackages).toEqual([]);
    expect(scoped.monorepo).toBe(false);
  });
});

describe('analyzeRepo — non-Node stacks', () => {
  it('detects FastAPI from requirements.txt', () => {
    write('requirements.txt', 'fastapi==0.110.0\nuvicorn[standard]\n');

    const insights = analyzeRepo(dir);
    expect(insights.framework.id).toBe('fastapi');
    expect(insights.language).toBe('python');
    expect(insights.framework.port).toBe(8000);
    expect(insights.framework.installCmd).toBe('pip install -r requirements.txt');
    expect(insights.framework.startCmd).toContain('uvicorn');
  });

  it('detects Django and keeps the project placeholder explicit', () => {
    write('requirements.txt', 'django>=5.0\ngunicorn\n');

    const insights = analyzeRepo(dir);
    expect(insights.framework.id).toBe('django');
    expect(insights.framework.startCmd).toContain('PROJECT.wsgi');
    expect(insights.framework.notes.join(' ')).toContain('ALLOWED_HOSTS');
  });

  it('detects Go, Rust and plain static sites', () => {
    write('go.mod', 'module example.com/app\n');
    expect(analyzeRepo(dir).framework.id).toBe('go');

    const rust = mkdtempSync(path.join(tmpdir(), 'nd-rust-'));
    try {
      writeFileSync(path.join(rust, 'Cargo.toml'), '[package]\nname = "app"\n');
      expect(analyzeRepo(rust).framework.id).toBe('rust');
    } finally {
      rmSync(rust, { recursive: true, force: true });
    }

    const staticDir = mkdtempSync(path.join(tmpdir(), 'nd-static-'));
    try {
      writeFileSync(path.join(staticDir, 'index.html'), '<html></html>');
      const insights = analyzeRepo(staticDir);
      expect(insights.framework.id).toBe('static');
      expect(insights.framework.category).toBe('static');
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it('returns a usable unknown preset for an empty directory', () => {
    const insights = analyzeRepo(dir);
    expect(insights.framework.id).toBe('unknown');
    expect(insights.framework.installCmd).toBeNull();
    expect(insights.analyzedAt).toBeTruthy();
  });
});

describe('analyzeRepo — baseDir', () => {
  it('analyzes a monorepo subdirectory as the build context', () => {
    write('apps/web/package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    write('package.json', JSON.stringify({ private: true, workspaces: ['apps/*'] }));

    const root = analyzeRepo(dir);
    expect(root.framework.id).toBe('node');
    const sub = analyzeRepo(dir, '/apps/web');
    expect(sub.framework.id).toBe('nextjs');
    expect(sub.baseDir).toBe('/apps/web');
  });
});

describe('summarizeInsights', () => {
  it('renders a single-line summary for the deploy log', () => {
    pkgJson({ dependencies: { next: '^15.1.2' } });
    write('.nvmrc', '20.11.0\n');
    write('pnpm-lock.yaml', '');

    const line = summarizeInsights(analyzeRepo(dir));
    expect(line).toBe('Detected Next.js 15.1.2 · pnpm · Node 20.11.0');
  });
});
