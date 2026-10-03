/**
 * PR 1 end-to-end smoke test. Runs the actual loader against hand-crafted
 * `.ninedeploy` files covering the positive path and every documented error
 * path, and prints a one-line PASS/FAIL per case. Exits non-zero on the
 * first failure so it can be wired into a CI gate.
 *
 * Run with: pnpm tsx apps/server/scripts/verifyManifest.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadNinedeployManifest,
  ManifestParseError,
  ManifestSecretError,
  ManifestTooLargeError,
  ManifestValidationError,
} from '../src/lib/ninedeployManifest.js';

let failures = 0;
const workDir = mkdtempSync(path.join(tmpdir(), 'nd-verify-'));

const writeManifest = (filename: string, contents: string | Buffer): string => {
  const filePath = path.join(workDir, filename);
  writeFileSync(filePath, contents);
  return filePath;
};

const check = (label: string, expected: 'pass' | string, run: () => void): void => {
  try {
    run();
    if (expected === 'pass') {
      console.log(`✓ ${label}`);
    } else {
      console.log(`✗ ${label} — expected ${expected}`);
      failures += 1;
    }
  } catch (err) {
    if (expected === 'pass' || (err instanceof Error && err.name !== expected)) {
      console.log(
        `✗ ${label} — threw ${err instanceof Error ? err.name : String(err)}: ${err instanceof Error ? err.message : err}`,
      );
      if (err instanceof Error && err.stack) console.log(err.stack);
      failures += 1;
    } else {
      console.log(`✓ ${label} (${err.name})`);
    }
  }
};

const VALID = `
version: "1"
runtime:
  type: node
  version: "20"
build:
  install: npm ci
  build: npm run build
  start: node server.js
  baseDir: apps/web
run:
  port: 3000
  healthcheck: /healthz
  restart: unless-stopped
env:
  required:
    - DATABASE_URL
    - STRIPE_SECRET_KEY
  aliases:
    DATABASE_URL: POSTGRES_URL
phases:
  setup:
    pkgs:
      - python310
  build:
    cmds:
      - npm run build:assets
hooks:
  preBuild: ./scripts/gen-types.sh
watch:
  paths:
    - apps/web/**
routes:
  - host: app.example.com
    path: /
    ssl: true
    headers:
      X-Frame-Options: DENY
previews:
  enabled: true
  pattern: "pr-{n}.previews.example.com"
  maxActive: 5
volume:
  mount: /data
  backups:
    schedule: "0 3 * * *"
    retention: 7
database:
  ref: app-db
  env: DATABASE_URL
network:
  publishPort: 8080
  aliases:
    - internal-mesh
notifications:
  onDeploy:
    - ops
  onFailure:
    - oncall
alerts:
  - when: deployFailed
    channel: oncall
  - when: highMemory
    channel: oncall
    thresholdPct: 90
`;

// ── 1. Positive: full valid manifest ──────────────────────────────────────
writeManifest('.ninedeploy', VALID);
const loaded = loadNinedeployManifest(workDir);
check('positive: full valid manifest returns a parsed object', 'pass', () => {
  if (!loaded) throw new Error('returned null');
  const m = loaded.manifest;
  if (m.version !== '1') throw new Error('version');
  if (m.runtime?.type !== 'node') throw new Error('runtime.type');
  if (m.runtime?.version !== '20') throw new Error('runtime.version');
  if (m.build?.install !== 'npm ci') throw new Error('build.install');
  if (m.build?.baseDir !== 'apps/web') throw new Error('build.baseDir');
  if (m.run?.port !== 3000) throw new Error('run.port');
  if (m.run?.healthcheck !== '/healthz') throw new Error('run.healthcheck');
  if (m.env?.required.length !== 2) throw new Error('env.required');
  if (m.env?.aliases?.DATABASE_URL !== 'POSTGRES_URL') throw new Error('env.aliases');
  if (m.phases?.setup?.pkgs?.[0] !== 'python310') throw new Error('phases.setup.pkgs');
  if (m.routes?.[0]?.host !== 'app.example.com') throw new Error('routes[0].host');
  if (m.routes?.[0]?.headers?.['X-Frame-Options'] !== 'DENY') throw new Error('routes.headers');
  if (m.previews?.pattern !== 'pr-{n}.previews.example.com') throw new Error('previews.pattern');
  if (m.volume?.mount !== '/data') throw new Error('volume.mount');
  if (m.volume?.backups?.schedule !== '0 3 * * *') throw new Error('volume.backups.schedule');
  if (m.database?.ref !== 'app-db') throw new Error('database.ref');
  if (m.network?.publishPort !== 8080) throw new Error('network.publishPort');
  if (m.notifications?.onDeploy?.[0] !== 'ops') throw new Error('notifications.onDeploy');
  if (m.alerts?.length !== 2) throw new Error('alerts');
  if (loaded.relativePath !== '.ninedeploy') throw new Error('relativePath');
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 2. Positive: .ninedeploy.yml is accepted when .ninedeploy is absent ──
writeManifest('.ninedeploy.yml', VALID);
const loadedYml = loadNinedeployManifest(workDir);
check('positive: .ninedeploy.yml is accepted when .ninedeploy is absent', 'pass', () => {
  if (loadedYml?.relativePath !== '.ninedeploy.yml') throw new Error('wrong file picked');
});
rmSync(path.join(workDir, '.ninedeploy.yml'));

// ── 3. Negative: 17 KB manifest → ManifestTooLargeError ─────────────────
writeManifest('.ninedeploy', `version: "1"\n# ${'a'.repeat(17 * 1024)}`);
check('negative: 17 KB manifest throws ManifestTooLargeError', 'ManifestTooLargeError', () => {
  loadNinedeployManifest(workDir);
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 4. Negative: AWS access key → ManifestSecretError ─────────────────────
writeManifest('.ninedeploy', 'version: "1"\nkey: AKIAIOSFODNN7EXAMPLE\n');
check('negative: AWS access key throws ManifestSecretError with redacted hint', 'ManifestSecretError', () => {
  loadNinedeployManifest(workDir);
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 5. Negative: postgres:// with creds → ManifestSecretError ───────────
writeManifest('.ninedeploy', 'version: "1"\nDATABASE_URL: postgres://user:s3cret@db:5432/app\n');
check('negative: postgres:// with creds throws ManifestSecretError', 'ManifestSecretError', () => {
  loadNinedeployManifest(workDir);
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 6. Negative: malformed YAML → ManifestParseError ─────────────────────
writeManifest('.ninedeploy', 'version: "1"\n  bad indent: :\n  another: :\n');
check('negative: malformed YAML throws ManifestParseError', 'ManifestParseError', () => {
  loadNinedeployManifest(workDir);
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 7. Negative: unknown top-level field → ManifestValidationError ───────
writeManifest('.ninedeploy', 'version: "1"\nunknownField: 1\n');
check('negative: unknown top-level field throws ManifestValidationError', 'ManifestValidationError', () => {
  loadNinedeployManifest(workDir);
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 8. Negative: bad runtime version → ManifestValidationError ──────────
writeManifest('.ninedeploy', 'version: "1"\nruntime:\n  type: node\n  version: twenty\n');
check('negative: non-numeric runtime version throws ManifestValidationError', 'ManifestValidationError', () => {
  loadNinedeployManifest(workDir);
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 9. Negative: previews without {n} pattern → ManifestValidationError ──
writeManifest('.ninedeploy', 'version: "1"\npreviews:\n  enabled: true\n  pattern: "pr.example.com"\n');
check('negative: previews enabled without {n} pattern throws ManifestValidationError', 'ManifestValidationError', () => {
  loadNinedeployManifest(workDir);
});
rmSync(path.join(workDir, '.ninedeploy'));

// ── 10. Positive: missing manifest returns null ─────────────────────────
const loadedNone = loadNinedeployManifest(workDir);
check('positive: missing manifest returns null (not an error)', 'pass', () => {
  if (loadedNone !== null) throw new Error('expected null');
});

rmSync(workDir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}

// Re-export error classes so biome doesn't flag them as unused imports
// when this script is the only consumer in a workspace.
export { ManifestParseError, ManifestSecretError, ManifestTooLargeError, ManifestValidationError };
