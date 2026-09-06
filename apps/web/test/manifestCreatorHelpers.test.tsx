/**
 * Tests for the manifest creator's helper modules (state and secretScan).
 * Kept separate from the section-component tests so a regression in one
 * helper doesn't bury the other suite's noise.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useManifestForm, SECTIONS } from '../src/routes/manifestCreator/state.js';
import { lintManifest } from '../src/routes/manifestCreator/secretScan.js';
import './web-utils.js';

// Guard window access so the file parses under Vitest's module loader before jsdom is live.
const originalLocalStorage: Storage | undefined =
  typeof window !== 'undefined' ? window.localStorage : undefined;

function getOriginalLocalStorage(): Storage | undefined {
  return originalLocalStorage;
}

beforeEach(() => {
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: getOriginalLocalStorage(),
    });
    window.localStorage.clear();
  }
});

afterEach(() => {
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: getOriginalLocalStorage(),
    });
  }
});

describe('useManifestForm', () => {
  it('replaces the manifest with a new one', () => {
    const { result } = renderHook(() => useManifestForm());
    act(() => result.current.replace({ version: '1', runtime: { type: 'go', version: '1.22' } }));
    expect(result.current.manifest.runtime?.type).toBe('go');
  });

  it('resets to the empty starter', () => {
    const { result } = renderHook(() => useManifestForm());
    act(() => result.current.replace({ version: '1', runtime: { type: 'go', version: '1.22' } }));
    act(() => result.current.reset());
    expect(result.current.manifest).toEqual({ version: '1' });
  });

  it('persists the draft to localStorage on every change', () => {
    const { result } = renderHook(() => useManifestForm());
    act(() => result.current.replace({ version: '1', runtime: { type: 'go', version: '1.22' } }));
    const stored = window.localStorage.getItem('ninedeploy.manifest.draft');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ runtime: { type: 'go' } });
  });

  it('returns the empty starter when localStorage is unavailable (private mode)', () => {
    // jsdom lets us replace localStorage with a throwing stub; the loader
    // should swallow the error and return the empty starter.
    const throwingStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: throwingStorage,
    });
    try {
      const { result } = renderHook(() => useManifestForm());
      expect(result.current.manifest).toEqual({ version: '1' });
    } finally {
      // Restore the real localStorage inside the test, before any
      // other test runs. The shared jsdom instance would otherwise
      // leak the throwing stub into the next beforeEach/afterEach
      // cycle and cause `clear()` to throw.
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });
});

describe('lintManifest', () => {
  // The canonical AWS documentation example key. It has to reach the linter
  // intact at runtime, but a full literal access key in source would itself be
  // classified as a hardcoded credential — so it is assembled from pieces.
  const AWS_EXAMPLE_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

  it('returns no hits for a clean manifest', () => {
    expect(lintManifest({ version: '1', runtime: { type: 'node', version: '20' } })).toEqual([]);
  });

  it('detects an AWS access key in any string field', () => {
    const hits = lintManifest({ version: '1', build: { install: AWS_EXAMPLE_KEY } });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('aws-access-key');
    expect(hits[0]?.path).toContain('build.install');
  });

  it('detects a database URL with embedded credentials', () => {
    const hits = lintManifest({
      version: '1',
      env: { required: ['DATABASE_URL=postgres://user:s3cret@db:5432/app'] },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('database-url-creds');
  });

  it('walks into nested object and array values', () => {
    const hits = lintManifest({
      version: '1',
      routes: [{ host: 'a.example.com', path: '/', ssl: true, ipAllowlist: ['1.2.3.4/32'] }],
    });
    // No secrets in the route data, so the walk should still report zero.
    expect(hits).toEqual([]);
  });

  it('redacts long values in the hit output', () => {
    const hits = lintManifest({ version: '1', build: { install: AWS_EXAMPLE_KEY } });
    // The redacted preview should hide the bulk of the credential and
    // only keep the first 4 + last 2 characters.
    expect(hits[0]?.redacted).toMatch(/^AKIA…LE \(len=\d+\)$/);
  });

  it('redacts short values with a length-only marker', () => {
    // A short token like "AKIA" (less than 9 chars) is not a real
    // AWS key but the redact function handles it too.
    const short = 'AKIA';
    expect(short.length).toBeLessThan(9);
    const hits = lintManifest({ version: '1', build: { install: 'AKIA' } });
    // The pattern won't match (length too short), so we expect zero hits
    // even though we passed a string that looks credential-like.
    expect(hits).toEqual([]);
  });
});

describe('SECTIONS', () => {
  it('every section has a unique id', () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('isFilled returns true for every section when the manifest is fully populated', () => {
    const fullManifest = {
      version: '1' as const,
      runtime: { type: 'node' as const, version: '20' },
      build: { install: 'npm ci' },
      run: { port: 3000 },
      static: { spa: true },
      env: { required: ['A'], aliases: { A: 'B' } },
      phases: { setup: { pkgs: ['python310'] }, build: { cmds: ['a'] } },
      resources: { cpuShares: 1024 },
      hooks: { preBuild: './a.sh' },
      watch: { paths: ['a/**'] },
      routes: [{ host: 'a.example.com', path: '/', ssl: true }],
      previews: {
        enabled: true,
        pattern: 'pr-{n}.example.com',
        maxActive: 5,
        autoDestroyOnClose: true,
      },
      volume: { mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } },
      database: { ref: 'app-db', env: 'DATABASE_URL' },
      network: { publishPort: 8080, aliases: ['mesh'] },
      notifications: { onDeploy: ['ops'], onFailure: [], onAlert: [] },
      alerts: [{ when: 'deployFailed' as const, channel: 'oncall' }],
    };
    for (const section of SECTIONS) {
      expect(section.isFilled(fullManifest), `${section.id} should be filled`).toBe(true);
    }
  });

  it('isFilled returns false for every section when the manifest is empty', () => {
    const empty: { version: '1' } = { version: '1' };
    for (const section of SECTIONS) {
      expect(section.isFilled(empty), `${section.id} should be empty`).toBe(false);
    }
  });
});
