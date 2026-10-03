/**
 * r620 regression guard: the panel never reads a host file through a symlink
 * a member committed to their repository.
 *
 * `POST /v1/insights` (any signed-in user) clones a public repo and returns
 * `analyzeRepo`'s result. Before 0.10.41 every marker read followed symlinks
 * and `.nvmrc` came back verbatim as `nodeVersion`, so a repo with
 * `.nvmrc -> /proc/self/environ` returned the panel's environment — the JWT
 * secret with it, which is enough to forge an operator session. The same
 * value was stored per service and printed in deploy logs.
 *
 * `.ninedeploy` had the same shape on the deploy path: followed through a
 * symlink, read whole before the size cap (`/dev/zero` never ends), and
 * quoted back in the YAML error that lands in the deploy log.
 *
 * Symlinks need a privilege on Windows; the symlink cases skip there and run
 * in CI (Linux).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insightsLeakFinding } from '../src/engine/doctor.js';
import { serializeInsights, storedInsightsLeakSuspected } from '../src/engine/repoInsights.js';
import { analyzeRepo, sanitizeNodeVersion } from '../src/lib/frameworks.js';
import { NINEDEPLOY_MANIFEST_MAX_BYTES } from '@ninedeploy/schemas';
import {
  loadNinedeployManifest,
  ManifestNotRegularFileError,
  ManifestTooLargeError,
} from '../src/lib/ninedeployManifest.js';

let root: string;
let repo: string;
let secretFile: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nd-r620-'));
  repo = path.join(root, 'repo');
  mkdirSync(repo);
  secretFile = path.join(root, 'host-secret.env');
  writeFileSync(secretFile, 'NINEDEPLOY_JWT_SECRET=do-not-leak-me\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create a symlink, or report that this platform/user cannot. */
function link(target: string, at: string, type: 'file' | 'dir' = 'file'): boolean {
  try {
    symlinkSync(target, at, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
    return true;
  } catch {
    return false;
  }
}

describe('r620: repository analysis never follows a symlink out of the checkout', () => {
  it('does not read a symlinked .nvmrc — the host file never becomes nodeVersion', (ctx) => {
    writeFileSync(path.join(repo, 'package.json'), '{}');
    if (!link(secretFile, path.join(repo, '.nvmrc'))) return ctx.skip();
    const insights = analyzeRepo(repo);
    expect(insights.nodeVersion).toBeNull();
    expect(JSON.stringify(insights)).not.toContain('do-not-leak-me');
    expect(insights.detectedFiles).not.toContain('.nvmrc');
  });

  it('does not read a symlinked package.json either', (ctx) => {
    const fakePkg = path.join(root, 'outside.json');
    writeFileSync(fakePkg, JSON.stringify({ name: 'do-not-leak-me', engines: { node: '20' } }));
    if (!link(fakePkg, path.join(repo, 'package.json'))) return ctx.skip();
    expect(JSON.stringify(analyzeRepo(repo))).not.toContain('do-not-leak-me');
  });

  it('skips a symlinked workspace package instead of failing the whole analysis', (ctx) => {
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    mkdirSync(path.join(repo, 'packages', 'real'), { recursive: true });
    writeFileSync(path.join(repo, 'packages', 'real', 'package.json'), JSON.stringify({ name: 'real' }));
    mkdirSync(path.join(repo, 'packages', 'evil'));
    if (!link(secretFile, path.join(repo, 'packages', 'evil', 'package.json'))) return ctx.skip();
    const insights = analyzeRepo(repo);
    expect(insights.workspacePackages?.map((w) => w.name)).toEqual(['real']);
  });

  it('still reads an ordinary .nvmrc', () => {
    writeFileSync(path.join(repo, 'package.json'), '{}');
    writeFileSync(path.join(repo, '.nvmrc'), 'v20.11.1\n');
    expect(analyzeRepo(repo).nodeVersion).toBe('v20.11.1');
  });

  it('drops a .nvmrc whose content is not a Node version', () => {
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ engines: { node: '>=18 <21' } }));
    writeFileSync(path.join(repo, '.nvmrc'), 'HOME=/root\nPATH=/usr/bin\n');
    // Falls back to the package.json range, never to the junk.
    expect(analyzeRepo(repo).nodeVersion).toBe('>=18 <21');
  });
});

describe('r620: sanitizeNodeVersion', () => {
  it.each(['20', 'v20.11.1', '18.x', 'lts/iron', 'lts/*', 'node', '>=18 <21', '^20.0.0', '18 || 20'])(
    'keeps %s',
    (v) => {
      expect(sanitizeNodeVersion(v)).toBe(v);
    },
  );
  it.each([
    'NINEDEPLOY_JWT_SECRET=abc',
    'root:x:0:0:root:/root:/bin/bash',
    'HOME=/root\0PATH=/usr/bin',
    'x'.repeat(65),
    '',
    42,
    null,
  ])('drops %j', (v) => {
    expect(sanitizeNodeVersion(v)).toBeNull();
  });
});

describe('r620: analyses stored before the fix', () => {
  const row = (nodeVersion: unknown) =>
    ({ serviceId: 7, data: { framework: { id: 'node' }, nodeVersion } }) as unknown as Parameters<
      typeof serializeInsights
    >[0];

  it('never returns a stored nodeVersion that is not a version', () => {
    expect(serializeInsights(row('NINEDEPLOY_JWT_SECRET=leaked')).nodeVersion).toBeNull();
    expect(serializeInsights(row('20')).nodeVersion).toBe('20');
  });

  it('flags such rows for Doctor, which tells the operator to rotate secrets', () => {
    expect(storedInsightsLeakSuspected(row('NINEDEPLOY_JWT_SECRET=leaked'))).toBe(true);
    expect(storedInsightsLeakSuspected(row('20'))).toBe(false);
    expect(storedInsightsLeakSuspected(row(null))).toBe(false);
    const finding = insightsLeakFinding([7]);
    expect(finding?.severity).toBe('critical');
    expect(finding?.detail).toMatch(/NINEDEPLOY_JWT_SECRET/);
    expect(insightsLeakFinding([])).toBeNull();
  });
});

describe('r620: .ninedeploy is read only as a regular file, never past the cap', () => {
  it('refuses a symlinked manifest by name instead of reading the target', (ctx) => {
    if (!link(secretFile, path.join(repo, '.ninedeploy'))) return ctx.skip();
    expect(() => loadNinedeployManifest(repo)).toThrow(ManifestNotRegularFileError);
  });

  it('refuses a dangling manifest symlink the same way', (ctx) => {
    if (!link(path.join(root, 'nowhere'), path.join(repo, '.ninedeploy'))) return ctx.skip();
    expect(() => loadNinedeployManifest(repo)).toThrow(ManifestNotRegularFileError);
  });

  it('refuses an oversized manifest from its size, before reading it', () => {
    writeFileSync(path.join(repo, '.ninedeploy'), 'a'.repeat(NINEDEPLOY_MANIFEST_MAX_BYTES + 10));
    expect(() => loadNinedeployManifest(repo)).toThrow(ManifestTooLargeError);
  });

  it('still loads an ordinary manifest', () => {
    writeFileSync(path.join(repo, '.ninedeploy'), 'version: "1"\n');
    expect(loadNinedeployManifest(repo)?.relativePath).toBe('.ninedeploy');
  });
});
