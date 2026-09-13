/**
 * Starter presets shown at the top of the Manifest Creator. Each preset
 * is a fully-populated `NinedeployManifest` plus UI metadata (icon, meta
 * chips); selecting one in `PresetSelector` replaces the form state
 * wholesale — and, since every replace is undoable, applying a preset is
 * always a single ⮰ away from the previous draft.
 *
 * The values are intentionally opinionated, but the *versions* are not
 * written here — they come from `RUNTIME_VERSION_CATALOG` in
 * `@ninedeploy/schemas`, which is the single place any runtime version is
 * maintained. Bumping a default is a one-line change in that catalog and it
 * lands here, in the CLI's `starterManifest`, and in the version picker at
 * the same time. Runtimes without a catalog (ruby, php, java, rust) ship
 * unpinned on purpose: Nixpacks resolves a current default at build time.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Boxes,
  Coffee,
  Cog,
  Database,
  FileCode,
  Flame,
  FolderKanban,
  Gem,
  Globe,
  Package,
  Server,
  Terminal,
  Zap,
} from 'lucide-react';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import { recommendedRuntimeVersion } from '@ninedeploy/schemas';

export interface ManifestPreset {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Short chips under the description: runtime, port, the key command. */
  meta: readonly string[];
  manifest: NinedeployManifest;
}

/**
 * Read a recommended version out of the catalog. Throws rather than falling
 * back to an unpinned runtime: a preset that silently stopped pinning a
 * version would be a much subtler bug than a loud one at module load.
 */
function pin(type: 'node' | 'python' | 'go'): string {
  const version = recommendedRuntimeVersion(type);
  /* c8 ignore next -- unreachable: the catalog always carries these three. */
  if (!version) throw new Error(`runtime catalog has no recommended version for "${type}"`);
  return version;
}

const NODE_VERSION = pin('node');
const PYTHON_VERSION = pin('python');
const GO_VERSION = pin('go');

const EMPTY: NinedeployManifest = { version: '1' };

const NODE_NPM: NinedeployManifest = {
  version: '1',
  runtime: { type: 'node', version: NODE_VERSION },
  build: { install: 'npm ci', build: 'npm run build', start: 'npm start' },
  run: { port: 3000, restart: 'unless-stopped' },
};

const NODE_PNPM: NinedeployManifest = {
  version: '1',
  runtime: { type: 'node', version: NODE_VERSION },
  build: {
    install: 'pnpm install --frozen-lockfile',
    build: 'pnpm build',
    start: 'pnpm start',
  },
  run: { port: 3000, restart: 'unless-stopped' },
};

const NODE_API: NinedeployManifest = {
  version: '1',
  runtime: { type: 'node', version: NODE_VERSION },
  build: { install: 'npm ci', start: 'node server.js' },
  run: { port: 3000, healthcheck: '/healthz', restart: 'on-failure:5' },
};

const NEXTJS: NinedeployManifest = {
  version: '1',
  runtime: { type: 'node', version: NODE_VERSION },
  build: { install: 'npm ci', build: 'next build', start: 'next start -p 3000' },
  run: { port: 3000, restart: 'unless-stopped' },
};

const PYTHON_PIP: NinedeployManifest = {
  version: '1',
  runtime: { type: 'python', version: PYTHON_VERSION },
  build: { install: 'pip install -r requirements.txt', start: 'python main.py' },
  run: { port: 8000, restart: 'unless-stopped' },
};

const FASTAPI: NinedeployManifest = {
  version: '1',
  runtime: { type: 'python', version: PYTHON_VERSION },
  build: {
    install: 'pip install -r requirements.txt',
    start: 'uvicorn main:app --host 0.0.0.0 --port 8000',
  },
  run: { port: 8000, healthcheck: '/health', restart: 'unless-stopped' },
};

const DJANGO: NinedeployManifest = {
  version: '1',
  runtime: { type: 'python', version: PYTHON_VERSION },
  build: {
    install: 'pip install -r requirements.txt',
    start: 'gunicorn myproject.wsgi --bind 0.0.0.0:8000',
  },
  phases: {
    build: { cmds: ['python manage.py migrate --noinput', 'python manage.py collectstatic --noinput'] },
  },
  run: { port: 8000, restart: 'unless-stopped' },
};

const GO: NinedeployManifest = {
  version: '1',
  runtime: { type: 'go', version: GO_VERSION },
  build: { build: 'go build -o app .', start: './app' },
  run: { port: 8080, restart: 'unless-stopped' },
};

const RUST: NinedeployManifest = {
  version: '1',
  runtime: { type: 'rust' },
  build: { build: 'cargo build --release', start: './target/release/app' },
  run: { port: 8080, restart: 'unless-stopped' },
};

const RAILS: NinedeployManifest = {
  version: '1',
  runtime: { type: 'ruby' },
  build: { install: 'bundle install', start: 'bundle exec rails server -b 0.0.0.0 -p 3000' },
  run: { port: 3000, restart: 'unless-stopped' },
};

const LARAVEL: NinedeployManifest = {
  version: '1',
  runtime: { type: 'php' },
  build: { install: 'composer install --optimize-autoloader --no-dev' },
  phases: { build: { cmds: ['php artisan config:cache', 'php artisan route:cache'] } },
  run: { port: 8080, restart: 'unless-stopped' },
};

const JAVA_GRADLE: NinedeployManifest = {
  version: '1',
  runtime: { type: 'java' },
  build: { build: './gradlew clean bootJar', start: 'java -jar build/libs/app.jar' },
  run: { port: 8080, restart: 'unless-stopped' },
};

const STATIC_VITE: NinedeployManifest = {
  version: '1',
  static: { spa: true, root: 'dist' },
  build: { install: 'npm ci', build: 'npm run build' },
  run: { port: 3000, restart: 'unless-stopped' },
};

const MONOREPO: NinedeployManifest = {
  version: '1',
  runtime: { type: 'node', version: NODE_VERSION },
  build: {
    install: 'pnpm install --frozen-lockfile',
    build: 'pnpm build',
    start: 'pnpm start',
    baseDir: 'apps/web',
  },
  watch: { paths: ['apps/web/**', 'packages/**'] },
  previews: {
    enabled: true,
    pattern: 'pr-{n}.previews.example.com',
    maxActive: 5,
    autoDestroyOnClose: true,
  },
  run: { port: 3000, restart: 'unless-stopped' },
};

const WORKER: NinedeployManifest = {
  version: '1',
  runtime: { type: 'node', version: NODE_VERSION },
  build: { install: 'npm ci', start: 'node worker.js' },
  resources: { cpuShares: 512, memMb: 512 },
  hooks: { preStop: './scripts/drain.sh' },
  notifications: { onDeploy: [], onFailure: ['oncall'], onAlert: [] },
  alerts: [{ when: 'restartLoop', channel: 'oncall' }],
  run: { restart: 'unless-stopped' },
};

const API_WITH_DB: NinedeployManifest = {
  version: '1',
  runtime: { type: 'node', version: NODE_VERSION },
  build: { install: 'npm ci', build: 'npm run build', start: 'npm start' },
  env: { required: ['DATABASE_URL'] },
  database: { ref: 'app-db', env: 'DATABASE_URL' },
  volume: { mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } },
  alerts: [
    { when: 'deployFailed', channel: 'oncall' },
    { when: 'highMemory', channel: 'oncall', thresholdPct: 90 },
  ],
  run: { port: 3000, healthcheck: '/healthz', restart: 'unless-stopped' },
};

export const PRESETS: readonly ManifestPreset[] = [
  {
    id: 'empty',
    label: 'Blank',
    description: 'Start from scratch — just the version field',
    icon: FileCode,
    meta: [],
    manifest: EMPTY,
  },
  {
    id: 'node-npm',
    label: `Node ${NODE_VERSION} (npm)`,
    description: 'Active LTS Node with npm ci + npm run build',
    icon: Package,
    meta: [`Node ${NODE_VERSION}`, ':3000'],
    manifest: NODE_NPM,
  },
  {
    id: 'node-pnpm',
    label: `Node ${NODE_VERSION} (pnpm)`,
    description: 'pnpm with frozen lockfile',
    icon: Boxes,
    meta: [`Node ${NODE_VERSION}`, ':3000'],
    manifest: NODE_PNPM,
  },
  {
    id: 'node-api',
    label: 'Node API (Express)',
    description: 'No build step — node server.js with a health endpoint',
    icon: Server,
    meta: [`Node ${NODE_VERSION}`, ':3000', '/healthz'],
    manifest: NODE_API,
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    description: 'next build + next start behind the router',
    icon: Zap,
    meta: [`Node ${NODE_VERSION}`, ':3000'],
    manifest: NEXTJS,
  },
  {
    id: 'static',
    label: 'Static SPA (Vite)',
    description: 'Pre-built dist/ served as a static SPA',
    icon: Globe,
    meta: ['SPA fallback', 'dist/'],
    manifest: STATIC_VITE,
  },
  {
    id: 'python',
    label: `Python ${PYTHON_VERSION}`,
    description: 'pip + requirements.txt',
    icon: Terminal,
    meta: [':8000', 'pip'],
    manifest: PYTHON_PIP,
  },
  {
    id: 'fastapi',
    label: 'FastAPI',
    description: 'uvicorn ASGI server with a /health probe',
    icon: Flame,
    meta: [`Python ${PYTHON_VERSION}`, ':8000', '/health'],
    manifest: FASTAPI,
  },
  {
    id: 'django',
    label: 'Django',
    description: 'gunicorn WSGI; migrate + collectstatic on build',
    icon: Server,
    meta: [`Python ${PYTHON_VERSION}`, ':8000'],
    manifest: DJANGO,
  },
  {
    id: 'go',
    label: `Go ${GO_VERSION}`,
    description: 'go build → ./app binary',
    icon: Cog,
    meta: [':8080', 'go build'],
    manifest: GO,
  },
  {
    id: 'rust',
    label: 'Rust',
    description: 'cargo build --release → release binary',
    icon: Cog,
    meta: ['cargo', ':8080'],
    manifest: RUST,
  },
  {
    id: 'rails',
    label: 'Ruby on Rails',
    description: 'bundle install + rails server (unpinned)',
    icon: Gem,
    meta: ['ruby', ':3000'],
    manifest: RAILS,
  },
  {
    id: 'laravel',
    label: 'Laravel (PHP)',
    description: 'composer --no-dev with config/route cache',
    icon: Flame,
    meta: ['php', ':8080'],
    manifest: LARAVEL,
  },
  {
    id: 'java',
    label: 'Java (Gradle)',
    description: './gradlew bootJar → java -jar',
    icon: Coffee,
    meta: ['java', ':8080'],
    manifest: JAVA_GRADLE,
  },
  {
    id: 'monorepo',
    label: 'Monorepo service',
    description: 'baseDir + watch paths + PR previews wired up',
    icon: FolderKanban,
    meta: ['apps/web', 'watch paths', 'PR previews'],
    manifest: MONOREPO,
  },
  {
    id: 'worker',
    label: 'Background worker',
    description: 'No port — queue consumer with drain hook + alerts',
    icon: Bot,
    meta: ['no port', '512 MiB'],
    manifest: WORKER,
  },
  {
    id: 'api-db',
    label: 'API + managed DB',
    description: 'DB attach, backups, alerts — the full ops setup',
    icon: Database,
    meta: [':3000', 'backups', 'alerts'],
    manifest: API_WITH_DB,
  },
] as const;
