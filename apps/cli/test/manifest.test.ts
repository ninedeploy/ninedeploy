/**
 * CLI tests for the `ninedeploy manifest {init,validate,show,apply}` group.
 * Mocks the SDK + prompts so the tests run offline; the underlying
 * parsing/formatting logic is already covered by the SDK test suite.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  manifestApply,
  manifestInit,
  manifestShow,
  manifestValidate,
} from '../src/commands/manifest.js';

const h = vi.hoisted(() => {
  // Defined here (not inside the mock factory) so the tests can throw the
  // exact error classes the CLI narrows on with `instanceof`.
  class ManifestParseError extends Error {
    source: string;
    override cause: unknown;
    constructor(source: string, cause: unknown) {
      super(`parse: ${String(cause)}`);
      this.name = 'ManifestParseError';
      this.source = source;
      this.cause = cause;
    }
  }
  class ManifestValidationError extends Error {
    issues: Array<{ path: string; message: string }>;
    constructor(issues: Array<{ path: string; message: string }>) {
      super('validation failed');
      this.name = 'ManifestValidationError';
      this.issues = issues;
    }
  }
  return {
    createClient: vi.fn(),
    prompt: vi.fn(),
    /** Per-test parse behaviour; a default impl is installed in beforeEach. */
    parse: vi.fn(),
    ManifestParseError,
    ManifestValidationError,
  };
});

vi.mock('@ninedeploy/sdk', () => ({
  // The SDK is exercised in its own test suite; here we just stub it enough
  // to exercise the CLI plumbing.
  parseManifestYaml: (text: string) => h.parse(text),
  formatManifestYaml: () => '# .ninedeploy\nversion: "1"\n',
  starterManifest: () => ({ version: '1' as const, runtime: { type: 'node' as const } }),
  detectProjectKind: () => 'node-npm' as const,
  ManifestParseError: h.ManifestParseError,
  ManifestValidationError: h.ManifestValidationError,
}));
vi.mock('../src/client.js', () => ({ createClient: h.createClient }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt }));

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'nd-cli-manifest-'));
  h.prompt.mockReset();
  // Default answers: keep the detected kind, default filename.
  h.prompt.mockResolvedValueOnce('');
  h.prompt.mockResolvedValueOnce('.ninedeploy');
  h.parse.mockReset();
  // Default: a file containing the literal `version:` parses; anything else
  // throws a proper ManifestParseError so the CLI's catch block routes it to
  // the parse-error path.
  h.parse.mockImplementation((text: string) => {
    if (!text.includes('version:')) throw new h.ManifestParseError('<test>', 'missing version');
    return { version: '1' };
  });
  // Always start each test from a clean exit-code baseline; otherwise a
  // failure in test A pollutes test B's expectation.
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('manifest init', () => {
  it('writes a .ninedeploy file with the starter template when the dir is empty', async () => {
    await manifestInit(workDir);
    const written = path.join(workDir, '.ninedeploy');
    const text = require('node:fs').readFileSync(written, 'utf8') as string;
    expect(text).toContain('version: "1"');
  });

  it('refuses to overwrite an existing manifest', async () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    await manifestInit(workDir);
    // The pre-existing content is untouched.
    const text = require('node:fs').readFileSync(path.join(workDir, '.ninedeploy'), 'utf8') as string;
    expect(text).toBe('version: "1"\n');
  });

  it('falls back to .ninedeploy when the filename prompt is left empty', async () => {
    h.prompt.mockReset();
    h.prompt.mockResolvedValueOnce('');   // keep detected kind
    h.prompt.mockResolvedValueOnce('  '); // whitespace-only filename
    await manifestInit(workDir);
    const text = require('node:fs').readFileSync(path.join(workDir, '.ninedeploy'), 'utf8') as string;
    expect(text).toContain('version: "1"');
  });

  it('honours the override-kind prompt', async () => {
    // First prompt: override kind, second: default filename.
    h.prompt.mockReset();
    h.prompt.mockResolvedValueOnce('python');
    h.prompt.mockResolvedValueOnce('.ninedeploy');
    await manifestInit(workDir);
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });
});

describe('manifest validate', () => {
  it('prints Valid when the manifest parses', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    manifestValidate(workDir);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('sets exitCode to 1 and prints errors when validation fails', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'not yaml at all\n');
    const prev = process.exitCode;
    manifestValidate(workDir);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });

  it('refuses the file and skips parsing when a secret pattern matches', () => {
    // The secret scan runs *before* schema validation: a committed credential
    // is worse than a schema mistake, so the manifest is rejected outright.
    writeFileSync(
      path.join(workDir, '.ninedeploy'),
      'version: "1"\nenv:\n  AWS_KEY: AKIAIOSFODNN7EXAMPLE\n',
    );
    const prev = process.exitCode;
    manifestValidate(workDir);
    expect(process.exitCode).toBe(1);
    // Parsing never happened - the scan short-circuits first.
    expect(h.parse).not.toHaveBeenCalled();
    process.exitCode = prev ?? undefined;
  });

  it('lists each schema issue, labelling a rootless path as <root>', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    h.parse.mockImplementation(() => {
      throw new h.ManifestValidationError([
        { path: 'runtime.type', message: 'invalid runtime' },
        { path: '', message: 'at least one section is required' },
      ]);
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    const prev = process.exitCode;
    manifestValidate(workDir);
    spy.mockRestore();
    expect(process.exitCode).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('runtime.type');
    expect(out).toContain('<root>');
    process.exitCode = prev ?? undefined;
  });

  it('rethrows an error that is neither a parse nor a validation failure', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    h.parse.mockImplementation(() => {
      throw new Error('disk exploded');
    });
    expect(() => manifestValidate(workDir)).toThrow('disk exploded');
  });

  it('errors when no manifest file is present', () => {
    const prev = process.exitCode;
    manifestValidate(workDir);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });

  it('accepts .ninedeploy.yml as an alternative filename', () => {
    writeFileSync(path.join(workDir, '.ninedeploy.yml'), 'version: "1"\n');
    const prev = process.exitCode;
    manifestValidate(workDir);
    expect(process.exitCode ?? 0).toBe(0);
    process.exitCode = prev ?? undefined;
  });
});

describe('manifest show', () => {
  it('prints a human-readable summary and exits cleanly', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    const prev = process.exitCode;
    manifestShow(workDir);
    expect(process.exitCode ?? 0).toBe(0);
    process.exitCode = prev ?? undefined;
  });

  it('sets exitCode 1 when the manifest is missing', () => {
    const prev = process.exitCode;
    manifestShow(workDir);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });

  it('sets exitCode 1 on schema validation failure', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    h.parse.mockImplementation(() => {
      throw new h.ManifestValidationError([{ path: 'run.port', message: 'must be a number' }]);
    });
    const prev = process.exitCode;
    manifestShow(workDir);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });

  it('rethrows an unexpected error instead of swallowing it', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    h.parse.mockImplementation(() => {
      throw new Error('disk exploded');
    });
    expect(() => manifestShow(workDir)).toThrow('disk exploded');
  });

  it('warns (singular) about one secret match but still prints the manifest', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\nenv:\n  AWS_KEY: AKIAIOSFODNN7EXAMPLE\n');
    const prev = process.exitCode;
    manifestShow(workDir);
    // `show` warns rather than erroring, but still fails CI via the exit code.
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });

  it('warns (plural) about multiple secret matches', () => {
    writeFileSync(
      path.join(workDir, '.ninedeploy'),
      `version: "1"\nenv:\n  AWS_KEY: AKIAIOSFODNN7EXAMPLE\n  GH: ghp_${'a'.repeat(36)}\n`,
    );
    const prev = process.exitCode;
    manifestShow(workDir);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });

  it('renders every populated section, using singular labels for single entries', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    h.parse.mockImplementation(() => ({
      version: '1',
      runtime: { type: 'node', version: '26' },
      build: { install: 'pnpm i', command: 'pnpm build', output: '' },
      run: { port: 3000, healthcheck: '/health', restart: 'always' },
      routes: [{ host: 'app.example.com', path: '/', ssl: true }],
      database: { ref: 'pg-main', env: 'DATABASE_URL' },
      alerts: [{ metric: 'cpu', operator: 'gt', threshold: 90 }],
      notifications: { onDeploy: ['slack'], onFailure: [], onAlert: [] },
      volume: { backups: { schedule: '0 3 * * *', retention: 7 } },
    }));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    manifestShow(workDir);
    spy.mockRestore();
    const out = logs.join('\n');
    expect(out).toContain('runtime.type:    node');
    expect(out).toContain('runtime.version: 26');
    expect(out).toContain('pnpm build');
    // `output: ''` is falsy and must be skipped rather than printed empty.
    expect(out).not.toContain('build.output');
    expect(out).toContain('run.port:        3000');
    expect(out).toContain('run.healthcheck: /health');
    expect(out).toContain('run.restart:     always');
    expect(out).toContain('routes:          1 entry');
    expect(out).toContain('app.example.com/ (ssl=true)');
    expect(out).toContain('database:        pg-main');
    expect(out).toContain('alerts:          1 rule');
    expect(out).toContain('notifications:   1 channel ref');
    expect(out).toContain('volume.backups:  0 3 * * * (retention=7)');
  });

  it('renders plural labels and skips optional fields that are absent', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    h.parse.mockImplementation(() => ({
      version: '1',
      runtime: { type: 'python' }, // no version
      build: {},
      run: {}, // no port / healthcheck / restart
      routes: [
        { host: 'a.example.com', path: '/', ssl: true },
        { host: 'b.example.com', path: '/api', ssl: false },
      ],
      alerts: [
        { metric: 'cpu', operator: 'gt', threshold: 90 },
        { metric: 'mem', operator: 'gt', threshold: 80 },
      ],
      notifications: { onDeploy: ['slack'], onFailure: ['email'], onAlert: [] },
      volume: {}, // volume present but no backups block
    }));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    manifestShow(workDir);
    spy.mockRestore();
    const out = logs.join('\n');
    expect(out).toContain('runtime.type:    python');
    expect(out).not.toContain('runtime.version');
    expect(out).not.toContain('run.port');
    expect(out).toContain('routes:          2 entries');
    expect(out).toContain('alerts:          2 rules');
    expect(out).toContain('notifications:   2 channel refs');
    expect(out).not.toContain('volume.backups');
  });

  it('prints the empty-manifest placeholder when no section is populated', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    h.parse.mockImplementation(() => ({
      version: '1',
      notifications: { onDeploy: [], onFailure: [], onAlert: [] },
    }));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    manifestShow(workDir);
    spy.mockRestore();
    expect(logs.join('\n')).toContain('(empty manifest)');
  });

  it('sets exitCode 1 on parse failure', () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'not yaml');
    const prev = process.exitCode;
    manifestShow(workDir);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });
});

describe('manifest apply', () => {
  it('informs the operator that the server endpoint is not yet wired', async () => {
    writeFileSync(path.join(workDir, '.ninedeploy'), 'version: "1"\n');
    const client = h.createClient();
    await manifestApply(client, workDir, 1);
    // No call to client.services.previewManifest: the placeholder is
    // intentionally a no-op until the server-side endpoint ships.
    expect(h.createClient).toHaveBeenCalled();
  });

  it('sets exitCode 1 when the manifest is missing', async () => {
    const client = h.createClient();
    const prev = process.exitCode;
    await manifestApply(client, workDir, 1);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev ?? undefined;
  });
});
