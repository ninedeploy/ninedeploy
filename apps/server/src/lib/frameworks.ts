import { closeSync, existsSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import type { FrameworkPreset, PackageManagerId, RepoInsights } from '@ninedeploy/schemas';
import { matchesAny } from './glob.js';
import { resolveInRepo } from './repoPath.js';

/**
 * Static repository analysis: reduce a checkout to "what framework is this and
 * how should it deploy". Nothing in this module executes a command — the
 * command strings below are SUGGESTIONS rendered in the UI and only applied
 * when the user accepts them (they then travel through the existing,
 * schema-validated build-config fields).
 */

/** Marker-file read guard: a pathological repo must not OOM the analyzer. */
const MAX_MARKER_BYTES = 2 * 1024 * 1024;

interface ParsedPackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  workspaces?: unknown;
}

const LOCKFILES: Array<{ file: string; pm: PackageManagerId }> = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'bun.lock', pm: 'bun' },
  { file: 'package-lock.json', pm: 'npm' },
];

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** Literal install-command suggestions per package manager (lockfile-aware). */
const INSTALL_CMD: Record<PackageManagerId, { lock: string; noLock: string }> = {
  npm: { lock: 'npm ci', noLock: 'npm install' },
  pnpm: { lock: 'pnpm install --frozen-lockfile', noLock: 'pnpm install' },
  yarn: { lock: 'yarn install --immutable', noLock: 'yarn install' },
  bun: { lock: 'bun install', noLock: 'bun install' },
};

/** Literal build-command suggestions per package manager. */
const BUILD_CMD: Record<PackageManagerId, string> = {
  npm: 'npm run build',
  pnpm: 'pnpm run build',
  yarn: 'yarn build',
  bun: 'bun run build',
};

/** Literal start-command suggestions per package manager (package.json start). */
const START_CMD: Record<PackageManagerId, string> = {
  npm: 'npm start',
  pnpm: 'pnpm start',
  yarn: 'yarn start',
  bun: 'bun start',
};

/**
 * Read a marker file from a checkout the panel does not trust.
 *
 * r620: only a REGULAR file is read, never what a symlink points at. The repo
 * is member-controlled: `.nvmrc -> /proc/self/environ` used to be followed
 * (stat/readFile both follow links, and procfs reports size 0, so the size cap
 * passed) and its content came back to the caller as `nodeVersion` — the
 * panel's own environment, JWT secret included. The open uses O_NOFOLLOW
 * where the platform has it, so swapping the file for a link between the
 * lstat and the open is refused too, and the read never goes past the cap
 * (a FIFO or device would otherwise block or grow without bound).
 */
function readText(file: string): string | null {
  let fd: number | null = null;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) return null;
    const buf = Buffer.alloc(Math.min(st.size, MAX_MARKER_BYTES) + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_MARKER_BYTES) return null;
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * r620: what a Node version marker may contain — `.nvmrc` forms (`20`,
 * `v20.11.1`, `lts/iron`, `node`) or a package.json `engines.node` range
 * (`>=18 <21`, `^20.x`). Anything else is not a version, it is data that must
 * not be stored, logged or returned (it is how host files leaked before).
 */
const NODE_VERSION_RE = /^(?:v?\d+(?:\.(?:\d+|x|\*)){0,2}|lts\/[a-z*-]+|node|stable|latest)$/i;
const NODE_RANGE_RE = /^[0-9vVxX*.^~<>=| -]{1,64}$/;
export function sanitizeNodeVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > 64) return null;
  return NODE_VERSION_RE.test(v) || NODE_RANGE_RE.test(v) ? v : null;
}

function readJson(file: string): unknown | null {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const VERSION_RANGE = /(\d+)\.(\d+)(?:\.(\d+))?/;

/** Normalize a package.json version range to its leading numeric version. */
function versionOf(range: string | undefined): string | null {
  if (!range) return null;
  const m = range.match(VERSION_RANGE);
  if (!m) return null;
  return m[3] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`;
}

function majorOf(version: string | null): number | null {
  const major = version ? Number.parseInt(version.split('.')[0] ?? '', 10) : Number.NaN;
  return Number.isInteger(major) ? major : null;
}

type Preset = FrameworkPreset;

interface NodeCommands {
  install: string;
  build: string;
  start: string;
}

/** Fixed suggestion triple for a package manager — values are pure literals. */
function nodeCommands(pm: PackageManagerId | null, hasLockfile: boolean): NodeCommands {
  const effective: PackageManagerId = pm ?? 'npm';
  const install = hasLockfile ? INSTALL_CMD[effective].lock : INSTALL_CMD[effective].noLock;
  return { install, build: BUILD_CMD[effective], start: START_CMD[effective] };
}

/**
 * Reduce a Node package.json to a framework preset. Detection runs most
 * specific first — e.g. a Next.js repo also depends on react, and a Nuxt repo
 * also depends on vite, but the app framework is what the deploy plan needs.
 */
function detectNodeFramework(
  pkg: ParsedPackageJson,
  pm: PackageManagerId | null,
  hasLockfile: boolean,
): { preset: Preset; frameworkVersion: string | null } {
  const c = nodeCommands(pm, hasLockfile);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const depVersion = (name: string): string | undefined => deps[name];
  const nodeEnv = [{ key: 'NODE_ENV', value: 'production', description: 'Production mode for the Node runtime' }];

  const base = {
    installCmd: c.install,
    buildCmd: c.build,
    startCmd: c.start,
    env: nodeEnv,
    notes: [] as string[],
  };

  if (depVersion('next')) {
    return {
      frameworkVersion: versionOf(depVersion('next')),
      preset: {
        ...base,
        id: 'nextjs',
        name: 'Next.js',
        emoji: '▲',
        category: 'ssr',
        port: 3000,
        env: [
          ...nodeEnv,
          { key: 'NEXT_TELEMETRY_DISABLED', value: '1', description: 'Disables Next.js build telemetry' },
        ],
        notes: [
          'Nixpacks builds Next.js automatically when the repo ships no Dockerfile.',
          'Setting output: "standalone" in next.config produces a smaller runtime image.',
        ],
      },
    };
  }

  if (depVersion('nuxt')) {
    const major = majorOf(versionOf(depVersion('nuxt')));
    return {
      frameworkVersion: versionOf(depVersion('nuxt')),
      preset: {
        ...base,
        id: 'nuxt',
        name: 'Nuxt',
        emoji: '🟩',
        category: 'ssr',
        port: 3000,
        startCmd: major !== null && major < 3 ? c.start : 'node .output/server/index.mjs',
        env: [
          ...nodeEnv,
          { key: 'HOST', value: '0.0.0.0', description: 'Bind the Nitro server to all interfaces' },
        ],
        notes: ['Nuxt 3+ outputs a self-contained Nitro server (.output/server/index.mjs).'],
      },
    };
  }

  if (depVersion('@remix-run/node') || depVersion('@remix-run/react') || depVersion('@remix-run/dev')) {
    return {
      frameworkVersion: versionOf(depVersion('@remix-run/node') ?? depVersion('@remix-run/react')),
      preset: {
        ...base,
        id: 'remix',
        name: 'Remix',
        emoji: '💅',
        category: 'ssr',
        port: 3000,
        notes: ['The start script usually boots @remix-run/serve — keep it bound to process.env.PORT.'],
      },
    };
  }

  if (depVersion('@sveltejs/kit')) {
    const isStatic = Object.keys(deps).some((d) => d.startsWith('@sveltejs/adapter-static'));
    return {
      frameworkVersion: versionOf(depVersion('@sveltejs/kit')),
      preset: {
        ...base,
        id: 'sveltekit',
        name: 'SvelteKit',
        emoji: '🧡',
        category: isStatic ? 'static' : 'ssr',
        port: 3000,
        startCmd: isStatic ? null : 'node build',
        notes: isStatic
          ? ['adapter-static outputs a fully static site — no Node server is started.']
          : ['adapter-node emits a self-contained server (node build) that respects PORT and HOST.'],
      },
    };
  }

  if (depVersion('astro')) {
    const isSsr = Object.keys(deps).some((d) => d === '@astrojs/node' || d.startsWith('@astrojs/adapter-'));
    return {
      frameworkVersion: versionOf(depVersion('astro')),
      preset: {
        ...base,
        id: 'astro',
        name: 'Astro',
        emoji: '🚀',
        category: isSsr ? 'ssr' : 'static',
        port: 4321,
        startCmd: isSsr ? 'node ./dist/server/entry.mjs' : null,
        notes: isSsr
          ? ['The Node adapter emits ./dist/server/entry.mjs; it respects the HOST and PORT variables.']
          : ['Without an adapter Astro is a static site — only the build output (dist/) is served.'],
      },
    };
  }

  if (depVersion('@angular/core')) {
    return {
      frameworkVersion: versionOf(depVersion('@angular/core')),
      preset: {
        ...base,
        id: 'angular',
        name: 'Angular',
        emoji: '🅰️',
        category: 'spa',
        port: 4200,
        startCmd: null,
        notes: ['Angular build output (dist/) is served as static files; client-side routing needs a history fallback.'],
      },
    };
  }

  if (depVersion('gatsby')) {
    return {
      frameworkVersion: versionOf(depVersion('gatsby')),
      preset: {
        ...base,
        id: 'gatsby',
        name: 'Gatsby',
        emoji: '💜',
        category: 'static',
        port: 8080,
        startCmd: null,
        notes: ['Gatsby renders to public/ at build time — no runtime server is needed.'],
      },
    };
  }

  if (depVersion('@nestjs/core')) {
    return {
      frameworkVersion: versionOf(depVersion('@nestjs/core')),
      preset: {
        ...base,
        id: 'nestjs',
        name: 'NestJS',
        emoji: '🦁',
        category: 'backend',
        port: 3000,
        startCmd: 'node dist/main',
        notes: ['NestJS compiles to dist/ — make app.listen use process.env.PORT.'],
      },
    };
  }

  if (depVersion('vite')) {
    const flavor = depVersion('react') ? 'React' : depVersion('vue') ? 'Vue' : '';
    return {
      frameworkVersion: versionOf(depVersion('vite')),
      preset: {
        ...base,
        id: 'vite',
        name: flavor ? `Vite (${flavor})` : 'Vite',
        emoji: '⚡',
        category: 'spa',
        port: 4173,
        startCmd: null,
        notes: [
          'Vite builds a static SPA into dist/ — served without a Node runtime.',
          'Client-side routing requires a history-api-fallback on the proxy for deep links.',
        ],
      },
    };
  }

  if (depVersion('react') || depVersion('vue') || depVersion('svelte')) {
    const name = depVersion('react') ? 'React' : depVersion('vue') ? 'Vue' : 'Svelte';
    return {
      frameworkVersion: versionOf(depVersion('react') ?? depVersion('vue') ?? depVersion('svelte')),
      preset: {
        ...base,
        id: 'spa',
        name,
        emoji: '🧩',
        category: 'spa',
        port: 3000,
        startCmd: null,
        notes: ['Build output is a static SPA — no dedicated runtime server expected.'],
      },
    };
  }

  if (depVersion('express') || depVersion('fastify') || depVersion('koa') || depVersion('@hapi/hapi')) {
    const name = depVersion('express')
      ? 'Express'
      : depVersion('fastify')
        ? 'Fastify'
        : depVersion('koa')
          ? 'Koa'
          : 'Hapi';
    return {
      frameworkVersion: versionOf(
        depVersion('express') ?? depVersion('fastify') ?? depVersion('koa') ?? depVersion('@hapi/hapi'),
      ),
      preset: {
        ...base,
        id: 'node-backend',
        name,
        emoji: '🟨',
        category: 'backend',
        port: 3000,
        notes: ['The server must listen on process.env.PORT so Traefik routing and healthchecks line up.'],
      },
    };
  }

  return {
    frameworkVersion: null,
    preset: {
      ...base,
      id: 'node',
      name: 'Node.js',
      emoji: '🟢',
      category: 'backend',
      port: 3000,
      notes: ['Plain Node project — Nixpacks runs the package.json start script.'],
    },
  };
}

/** Literal Python install suggestions per marker file. */
const PY_INSTALL: Record<string, string> = {
  'requirements.txt': 'pip install -r requirements.txt',
  pyproject: 'pip install -r requirements.txt',
  Pipfile: 'pip install -r requirements.txt',
};

/** Reduce Python marker files to a framework preset. */
function detectPythonFramework(dir: string, marker: string): Preset {
  const contents = readText(path.join(dir, marker)) ?? '';
  const installCmd = PY_INSTALL[marker] ?? PY_INSTALL['requirements.txt']!;
  const notes = ['Nixpacks provisions Python and installs requirements when no Dockerfile exists.'];
  const pyEnv = [{ key: 'PYTHONUNBUFFERED', value: '1', description: 'Stream logs instead of buffering' }];

  const hasDjango = /(^|\n)\s*django([=><~;\s]|\n)/.test(contents) || /dependencies[\s\S]*django/.test(contents);
  const hasFastapi = /(^|\n)\s*fastapi([=><~;\s]|\n)/.test(contents) || /dependencies[\s\S]*fastapi/.test(contents);
  const hasFlask = /(^|\n)\s*flask([=><~;\s]|\n)/.test(contents) || /dependencies[\s\S]*flask/.test(contents);

  if (hasDjango) {
    return {
      id: 'django',
      name: 'Django',
      emoji: '🐍',
      category: 'backend',
      port: 8000,
      installCmd,
      buildCmd: null,
      startCmd: 'gunicorn --bind 0.0.0.0:$PORT PROJECT.wsgi:application',
      env: pyEnv,
      notes: [
        ...notes,
        'Replace PROJECT with your Django package name, and add gunicorn + whitenoise to the requirements.',
        'Set ALLOWED_HOSTS to include the assigned NineDeploy domain.',
      ],
    };
  }

  if (hasFastapi) {
    return {
      id: 'fastapi',
      name: 'FastAPI',
      emoji: '⚡',
      category: 'backend',
      port: 8000,
      installCmd,
      buildCmd: null,
      startCmd: 'python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT',
      env: pyEnv,
      notes: [
        ...notes,
        'Adjust app.main:app if your ASGI entrypoint lives elsewhere, and add uvicorn to the requirements.',
      ],
    };
  }

  if (hasFlask) {
    return {
      id: 'flask',
      name: 'Flask',
      emoji: '🧪',
      category: 'backend',
      port: 8000,
      installCmd,
      buildCmd: null,
      startCmd: 'gunicorn --bind 0.0.0.0:$PORT app:app',
      env: pyEnv,
      notes: [...notes, 'Add gunicorn to the requirements and point app:app at your Flask instance.'],
    };
  }

  return {
    id: 'python',
    name: 'Python',
    emoji: '🐍',
    category: 'backend',
    port: 8000,
    installCmd,
    buildCmd: null,
    startCmd: null,
    env: pyEnv,
    notes,
  };
}

function baseFacts(
  language: string,
  hasDockerfile: boolean,
  hasComposeFile: boolean,
  detectedFiles: string[],
  baseDir: string | undefined,
  commitSha: string | undefined,
) {
  return {
    language,
    packageManager: null as PackageManagerId | null,
    nodeVersion: null as string | null,
    frameworkVersion: null as string | null,
    scripts: {} as Record<string, string>,
    dependencyCount: 0,
    devDependencyCount: 0,
    hasDockerfile,
    hasComposeFile,
    monorepo: false,
    detectedFiles,
    workspacePackages: [] as RepoInsights['workspacePackages'],
    baseDir: baseDir ?? '/',
    commitSha: commitSha ?? null,
  };
}

// ── Monorepo workspace packages ─────────────────────────────────────────────

/** One deployable sub-app of a monorepo (a workspace member with its own
 * package.json), pre-analyzed so the wizard can offer "deploy this directory
 * as its own service" with the right framework label. */
type WorkspacePackage = RepoInsights['workspacePackages'][number];

/** Directories never worth descending into when enumerating members. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage', 'vendor', 'target']);
const MAX_WALK_DEPTH = 4;
const MAX_WORKSPACE_PACKAGES = 100;

/** Workspace glob patterns from package.json `workspaces`, pnpm-workspace.yaml
 * `packages:` and lerna.json — the three conventions Node monorepos use. */
function parseWorkspaceGlobs(pkg: ParsedPackageJson | null, dir: string): string[] {
  const globs: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '') globs.push(v.trim());
  };

  if (pkg?.workspaces) {
    if (Array.isArray(pkg.workspaces)) pkg.workspaces.forEach(add);
    else if (typeof pkg.workspaces === 'object') {
      const packages = (pkg.workspaces as { packages?: unknown }).packages;
      if (Array.isArray(packages)) packages.forEach(add);
    }
  }

  // pnpm-workspace.yaml: line-parse just the `packages:` list — pulling a YAML
  // dependency for one flat list would be overkill.
  const pnpmWs = readText(path.join(dir, 'pnpm-workspace.yaml'));
  if (pnpmWs !== null) {
    const block = pnpmWs.match(/^packages:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (block) {
      for (const line of block[1]!.split('\n')) {
        add(line.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, ''));
      }
    }
  }

  const lerna = readJson(path.join(dir, 'lerna.json')) as { packages?: unknown } | null;
  if (lerna?.packages && Array.isArray(lerna.packages)) lerna.packages.forEach(add);

  return [...new Set(globs)];
}

/** Enumerate the workspace member directories matching the globs, each with a
 * lightweight framework label from its own package.json. */
function enumerateWorkspacePackages(
  dir: string,
  globs: string[],
  pm: PackageManagerId | null,
): WorkspacePackage[] {
  if (globs.length === 0) return [];
  const results: WorkspacePackage[] = [];
  const seen = new Set<string>();

  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || results.length >= MAX_WORKSPACE_PACKAGES) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(resolveInRepo(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const relDir = rel === '' ? entry.name : `${rel}/${entry.name}`;
      // r620: resolveInRepo throws on a symlinked component — skip that one
      // package instead of aborting the whole analysis.
      let subPkgPath: string | null = null;
      try {
        subPkgPath = resolveInRepo(dir, relDir, 'package.json');
      } catch {
        subPkgPath = null;
      }
      if (subPkgPath && !seen.has(relDir) && matchesAny(relDir, globs) && existsSync(subPkgPath)) {
        seen.add(relDir);
        const subPkg = readJson(subPkgPath) as ParsedPackageJson | null;
        if (subPkg) {
          const { preset, frameworkVersion } = detectNodeFramework(subPkg, pm, false);
          results.push({
            dir: relDir,
            name: subPkg.name ?? null,
            framework: preset.name,
            frameworkVersion,
          });
        }
      }
      walk(relDir, depth + 1);
    }
  };

  walk('', 0);
  return results.sort((a, b) => a.dir.localeCompare(b.dir));
}

function finalize(preset: Preset, facts: Omit<RepoInsights, 'framework' | 'analyzedAt'>): RepoInsights {
  const notes = [...preset.notes];
  if (facts.hasDockerfile) {
    notes.unshift(
      "This repo ships a Dockerfile — build pack 'auto' prefers it directly, so the Nixpacks suggestions apply only when you switch the build pack.",
    );
  }
  return {
    framework: { ...preset, notes },
    ...facts,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Inspect a checked-out repository and summarize what it contains: the
 * detected framework with a deploy preset (commands adapted to the detected
 * package manager), plus the raw facts (scripts, engines, marker files).
 *
 * Pure filesystem analysis — never throws for missing markers; unknown repos
 * still produce a usable `unknown` preset.
 */
export function analyzeRepo(workDir: string, baseDir?: string, commitSha?: string): RepoInsights {
  const dir = resolveInRepo(workDir, baseDir);
  const detectedFiles: string[] = [];

  const probe = (file: string): boolean => {
    const exists = existsSync(path.join(dir, file));
    if (exists) detectedFiles.push(file);
    return exists;
  };

  const hasDockerfile = probe('Dockerfile');
  const hasComposeFile = COMPOSE_FILES.some((f) => probe(f));
  const monorepoMarkers = ['pnpm-workspace.yaml', 'turbo.json', 'lerna.json'];

  // ── Node ecosystem ────────────────────────────────────────────────────────
  const pkgRaw = readJson(path.join(dir, 'package.json')) as ParsedPackageJson | null;
  if (pkgRaw) {
    detectedFiles.push('package.json');
    const lockfile = LOCKFILES.find((l) => probe(l.file));
    // The packageManager field ("pnpm@9.1.0") is authoritative when present.
    const declared = pkgRaw.packageManager ? (pkgRaw.packageManager.match(/^(\w+)@/)?.[1] ?? null) : null;
    const pm =
      declared && (['npm', 'pnpm', 'yarn', 'bun'] as const).includes(declared as PackageManagerId)
        ? (declared as PackageManagerId)
        : (lockfile?.pm ?? null);

    const nvmrc = readText(path.join(dir, '.nvmrc'));
    if (nvmrc !== null) detectedFiles.push('.nvmrc');
    // r620: only a value shaped like a Node version survives — see sanitizeNodeVersion.
    const nodeVersion = sanitizeNodeVersion(nvmrc) ?? sanitizeNodeVersion(pkgRaw.engines?.node);

    const workspaceGlobs = parseWorkspaceGlobs(pkgRaw, dir);
    const isRootAnalysis = !baseDir || baseDir === '' || baseDir === '/';
    // Members only exist relative to the workspace root — an analysis scoped
    // to /apps/web must not list the whole tree as its own packages.
    const workspacePackages = isRootAnalysis ? enumerateWorkspacePackages(dir, workspaceGlobs, pm) : [];
    const monorepo = workspaceGlobs.length > 0 || pkgRaw.workspaces != null || monorepoMarkers.some((m) => probe(m));

    const { preset, frameworkVersion } = detectNodeFramework(pkgRaw, pm, lockfile != null);

    return finalize(preset, {
      language: 'javascript',
      packageManager: pm,
      nodeVersion,
      frameworkVersion,
      scripts: pkgRaw.scripts ?? {},
      dependencyCount: Object.keys(pkgRaw.dependencies ?? {}).length,
      devDependencyCount: Object.keys(pkgRaw.devDependencies ?? {}).length,
      hasDockerfile,
      hasComposeFile,
      monorepo,
      detectedFiles,
      workspacePackages,
      baseDir: baseDir ?? '/',
      commitSha: commitSha ?? null,
    });
  }

  // ── Python ────────────────────────────────────────────────────────────────
  const pythonMarker = ['requirements.txt', 'pyproject.toml', 'Pipfile'].find((f) => probe(f));
  if (pythonMarker) {
    return finalize(
      detectPythonFramework(dir, pythonMarker),
      baseFacts('python', hasDockerfile, hasComposeFile, detectedFiles, baseDir, commitSha),
    );
  }

  // ── Go / Rust / static HTML ───────────────────────────────────────────────
  if (probe('go.mod')) {
    const preset: Preset = {
      id: 'go',
      name: 'Go',
      emoji: '🐹',
      category: 'backend',
      port: 8080,
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      env: [],
      notes: ['Nixpacks detects go.mod and builds the module; expose an HTTP listener on $PORT.'],
    };
    return finalize(preset, baseFacts('go', hasDockerfile, hasComposeFile, detectedFiles, baseDir, commitSha));
  }

  if (probe('Cargo.toml')) {
    const preset: Preset = {
      id: 'rust',
      name: 'Rust',
      emoji: '🦀',
      category: 'backend',
      port: 8080,
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      env: [],
      notes: ['Nixpacks detects Cargo.toml and compiles a release binary; bind it to $PORT.'],
    };
    return finalize(preset, baseFacts('rust', hasDockerfile, hasComposeFile, detectedFiles, baseDir, commitSha));
  }

  if (probe('index.html')) {
    const preset: Preset = {
      id: 'static',
      name: 'Static site',
      emoji: '📄',
      category: 'static',
      port: 80,
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      env: [],
      notes: ['Plain HTML — Nixpacks serves the directory statically when no Dockerfile exists.'],
    };
    return finalize(preset, baseFacts('html', hasDockerfile, hasComposeFile, detectedFiles, baseDir, commitSha));
  }

  const unknown: Preset = {
    id: 'unknown',
    name: 'Unknown',
    emoji: '📦',
    category: 'unknown',
    port: 3000,
    installCmd: null,
    buildCmd: null,
    startCmd: null,
    env: [],
    notes: ['No recognizable framework markers — a Dockerfile or explicit build commands are recommended.'],
  };
  return finalize(unknown, baseFacts('unknown', hasDockerfile, hasComposeFile, detectedFiles, baseDir, commitSha));
}

/** One-line deploy-log summary of an analysis result (display text only). */
export function summarizeInsights(insights: RepoInsights): string {
  const parts: string[] = [
    `${insights.framework.name}${insights.frameworkVersion ? ` ${insights.frameworkVersion}` : ''}`,
  ];
  if (insights.packageManager) parts.push(insights.packageManager);
  if (insights.nodeVersion) parts.push(`Node ${insights.nodeVersion}`);
  return `Detected ${parts.join(' · ')}`;
}
