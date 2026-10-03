import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findManifestPath,
  hasNinedeployManifest,
  loadNinedeployManifest,
  ManifestParseError,
  ManifestSecretError,
  ManifestTooLargeError,
  ManifestValidationError,
  parseNinedeployManifest,
} from '../../src/lib/ninedeployManifest.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'nd-manifest-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const writeManifest = (filename: string, contents: string): void => {
  writeFileSync(path.join(workDir, filename), contents, 'utf8');
};

const fullValidManifest = `
version: "1"
runtime:
  type: node
  version: "20"
build:
  install: npm ci
  build: npm run build
  start: node server.js
run:
  port: 3000
  healthcheck: /healthz
  restart: unless-stopped
env:
  required:
    - DATABASE_URL
phases:
  setup:
    pkgs:
      - python310
routes:
  - host: app.example.com
    path: /
    ssl: true
notifications:
  onDeploy:
    - ops
alerts:
  - when: deployFailed
    channel: oncall
`;

describe('parseNinedeployManifest', () => {
  it('parses a valid full manifest', () => {
    const manifest = parseNinedeployManifest(fullValidManifest, 'inline');
    expect(manifest.version).toBe('1');
    expect(manifest.runtime?.type).toBe('node');
    expect(manifest.runtime?.version).toBe('20');
    expect(manifest.build?.install).toBe('npm ci');
    expect(manifest.run?.port).toBe(3000);
    expect(manifest.env?.required).toEqual(['DATABASE_URL']);
    expect(manifest.phases?.setup?.pkgs).toEqual(['python310']);
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.notifications?.onDeploy).toEqual(['ops']);
    expect(manifest.alerts).toHaveLength(1);
  });

  it('parses a minimal manifest (version only)', () => {
    const manifest = parseNinedeployManifest('version: "1"\n', 'inline');
    expect(manifest.version).toBe('1');
    expect(manifest.runtime).toBeUndefined();
  });

  it('throws ManifestParseError on invalid YAML', () => {
    expect(() => parseNinedeployManifest('a: b: c\n  d: : :', 'inline')).toThrow(ManifestParseError);
  });

  it('throws ManifestValidationError on empty document', () => {
    expect(() => parseNinedeployManifest('', 'inline')).toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError when version is missing', () => {
    expect(() => parseNinedeployManifest('runtime:\n  type: node\n', 'inline')).toThrow(
      ManifestValidationError,
    );
  });

  it('throws ManifestValidationError when an unknown field is present', () => {
    expect(() =>
      parseNinedeployManifest('version: "1"\nbogus: 1\n', 'inline'),
    ).toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError on invalid runtime version', () => {
    expect(() =>
      parseNinedeployManifest('version: "1"\nruntime:\n  type: node\n  version: twenty\n', 'inline'),
    ).toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError when previews.enabled is true without {n} pattern', () => {
    expect(() =>
      parseNinedeployManifest(
        'version: "1"\npreviews:\n  enabled: true\n  pattern: "pr.example.com"\n',
        'inline',
      ),
    ).toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError when highMemory alert has no thresholdPct', () => {
    expect(() =>
      parseNinedeployManifest(
        'version: "1"\nalerts:\n  - when: highMemory\n    channel: oncall\n',
        'inline',
      ),
    ).toThrow(ManifestValidationError);
  });

  it('aggregates multiple validation issues into a single error', () => {
    try {
      parseNinedeployManifest('version: "1"\nbuild:\n  install: ""\n', 'inline');
      expect.fail('expected ManifestValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestValidationError);
      const issues = (err as ManifestValidationError).issues;
      expect(issues.length).toBeGreaterThan(0);
    }
  });
});

describe('findManifestPath', () => {
  it('returns null when no manifest is present', () => {
    expect(findManifestPath(workDir)).toBeNull();
  });

  it('finds .ninedeploy (highest priority)', () => {
    writeManifest('.ninedeploy', 'version: "1"\n');
    expect(findManifestPath(workDir)).toBe(path.join(workDir, '.ninedeploy'));
  });

  it('finds .ninedeploy.yml when no .ninedeploy exists', () => {
    writeManifest('.ninedeploy.yml', 'version: "1"\n');
    expect(findManifestPath(workDir)).toBe(path.join(workDir, '.ninedeploy.yml'));
  });

  it('finds ninedeploy.yaml as the lowest-priority filename', () => {
    writeManifest('ninedeploy.yaml', 'version: "1"\n');
    expect(findManifestPath(workDir)).toBe(path.join(workDir, 'ninedeploy.yaml'));
  });

  it('prefers .ninedeploy over .ninedeploy.yml', () => {
    writeManifest('.ninedeploy.yml', 'version: "1"\n');
    writeManifest('.ninedeploy', 'version: "1"\n');
    expect(findManifestPath(workDir)).toBe(path.join(workDir, '.ninedeploy'));
  });
});

describe('hasNinedeployManifest', () => {
  it('returns false when no manifest exists', () => {
    expect(hasNinedeployManifest(workDir)).toBe(false);
  });
  it('returns true when a manifest exists', () => {
    writeManifest('.ninedeploy', 'version: "1"\n');
    expect(hasNinedeployManifest(workDir)).toBe(true);
  });
});

describe('loadNinedeployManifest', () => {
  it('returns null when no manifest is present', () => {
    expect(loadNinedeployManifest(workDir)).toBeNull();
  });

  it('returns a LoadedManifest for a valid file', () => {
    writeManifest('.ninedeploy', fullValidManifest);
    const loaded = loadNinedeployManifest(workDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.filePath).toBe(path.join(workDir, '.ninedeploy'));
    expect(loaded!.relativePath).toBe('.ninedeploy');
    expect(loaded!.manifest.version).toBe('1');
    expect(loaded!.rawSecretHits).toEqual([]);
  });

  it('throws ManifestTooLargeError when the file exceeds 16 KB', () => {
    // Create a 17 KB manifest. The size check runs before the secret scan and
    // before Zod, so an oversized junk file is refused first.
    const big = `version: "1"\n# ${'a'.repeat(17 * 1024)}\n`;
    writeManifest('.ninedeploy', big);
    expect(() => loadNinedeployManifest(workDir)).toThrow(ManifestTooLargeError);
  });

  it('accepts a file exactly at the 16 KB cap', () => {
    // 16 KB = 16384 bytes. Build a file of exactly that size with a valid
    // version header on top and a comment to pad the rest. We trim 1 byte
    // off the filler to leave room for the trailing newline.
    const header = 'version: "1"\n# ';
    const filler = 'a'.repeat(16 * 1024 - header.length - 1);
    writeManifest('.ninedeploy', `${header + filler}\n`);
    const loaded = loadNinedeployManifest(workDir);
    expect(loaded).not.toBeNull();
  });

  it('throws ManifestSecretError when a secret pattern is present', () => {
    writeManifest('.ninedeploy', 'version: "1"\nkey: AKIAIOSFODNN7EXAMPLE\n');
    try {
      loadNinedeployManifest(workDir);
      expect.fail('expected ManifestSecretError');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestSecretError);
      const e = err as ManifestSecretError;
      expect(e.hits).toHaveLength(1);
      expect(e.hits[0]?.patternId).toBe('aws-access-key');
      expect(e.message).toContain('aws-access-key');
    }
  });

  it('throws ManifestParseError on malformed YAML', () => {
    writeManifest('.ninedeploy', 'a: b: c\n  d: : :\n');
    expect(() => loadNinedeployManifest(workDir)).toThrow(ManifestParseError);
  });

  it('throws ManifestValidationError on schema mismatch', () => {
    writeManifest('.ninedeploy', 'version: "1"\nruntime:\n  type: node\n  version: twenty\n');
    expect(() => loadNinedeployManifest(workDir)).toThrow(ManifestValidationError);
  });

  it('loads .ninedeploy.yml when .ninedeploy is absent', () => {
    writeManifest('.ninedeploy.yml', fullValidManifest);
    const loaded = loadNinedeployManifest(workDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.relativePath).toBe('.ninedeploy.yml');
  });
});
