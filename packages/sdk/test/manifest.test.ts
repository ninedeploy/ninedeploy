import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { recommendedRuntimeVersion, runtimeVersionAdvisory } from '@ninedeploy/schemas';
import {
  detectProjectKind,
  formatManifestYaml,
  ManifestParseError,
  ManifestValidationError,
  parseManifestYaml,
  starterManifest,
  buildManifestFromTemplate,
} from '../src/manifest.js';

describe('parseManifestYaml', () => {
  it('parses a minimal manifest', () => {
    const m = parseManifestYaml('version: "1"\n');
    expect(m.version).toBe('1');
  });

  it('parses a full Node manifest', () => {
    const yaml = `
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
`;
    const m = parseManifestYaml(yaml);
    expect(m.runtime?.type).toBe('node');
    expect(m.build?.install).toBe('npm ci');
    expect(m.run?.port).toBe(3000);
  });

  it('throws ManifestParseError on malformed YAML', () => {
    expect(() => parseManifestYaml('a: b: c\n  d: : :\n')).toThrow(ManifestParseError);
  });

  it('coerces a non-Error parse cause into a string in the message', () => {
    // Drive the parse path through the loader's js-yaml integration so the
    // internal cause can be a non-Error. We exercise this by stubbing
    // yaml.load to throw a string.
    const spy = vi.spyOn(yaml, 'load').mockImplementation(() => {
      throw 'just a string';
    });
    try {
      try {
        parseManifestYaml('version: "1"\n');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ManifestParseError);
        expect((err as ManifestParseError).message).toContain('just a string');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('throws ManifestValidationError on schema mismatch', () => {
    expect(() => parseManifestYaml('version: "1"\nbogus: 1\n')).toThrow(
      ManifestValidationError,
    );
  });

  it('throws ManifestValidationError on empty document', () => {
    expect(() => parseManifestYaml('')).toThrow(ManifestValidationError);
  });

  it('error carries structured issues for downstream consumers', () => {
    try {
      parseManifestYaml('version: "1"\nruntime:\n  type: node\n  version: twenty\n');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestValidationError);
      const issues = (err as ManifestValidationError).issues;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.path).toMatch(/version/);
    }
  });
});

describe('formatManifestYaml', () => {
  it('emits a header comment and the version field', () => {
    const out = formatManifestYaml({ version: '1' });
    expect(out).toMatch(/^# \.ninedeploy/);
    expect(out).toContain('version: "1"');
  });

  it('round-trips a full manifest through parse → format → parse', () => {
    const original = parseManifestYaml(`
version: "1"
runtime:
  type: node
  version: "20"
build:
  install: npm ci
  build: npm run build
  start: node server.js
  baseDir: apps/web
  dockerfile: docker/Dockerfile.prod
run:
  port: 3000
  healthcheck: /healthz
  restart: on-failure:3
env:
  required:
    - DATABASE_URL
  aliases:
    DATABASE_URL: POSTGRES_URL
routes:
  - host: app.example.com
    path: /
    ssl: true
    redirectWww: true
    headers:
      X-Frame-Options: DENY
alerts:
  - when: highMemory
    channel: oncall
    thresholdPct: 90
network:
  publishPort: 8080
  aliases:
    - internal-mesh
notifications:
  onDeploy:
    - ops
  onFailure:
    - oncall
  onAlert:
    - oncall
volume:
  mount: /data
  backups:
    schedule: "0 3 * * *"
    retention: 7
`);
    const formatted = formatManifestYaml(original);
    const reparsed = parseManifestYaml(formatted);
    expect(reparsed).toEqual(original);
  });

  it('round-trips notification channels containing YAML-special characters', () => {
    // ` #` starts a comment in a plain scalar and `a: b` turns a list item
    // into a map — the emitter must quote scalars that are not provably safe,
    // or the re-parse silently corrupts (first) or fails (second).
    const original = parseManifestYaml(`
version: "1"
notifications:
  onDeploy:
    - "https://hook.example.com/a?x=1#frag"
    - "a: b"
`);
    const m = parseManifestYaml(formatManifestYaml(original));
    expect(m.notifications?.onDeploy).toEqual(['https://hook.example.com/a?x=1#frag', 'a: b']);
  });

  it('quotes YAML-ambiguous scalars so string header values round-trip as strings', () => {
    // `true`, `8080` and `007` sit inside the plain-safe charset but YAML
    // resolves them to boolean/integer — emitting them bare turned a legal
    // string header into a different type on the next parse (r023).
    const original = parseManifestYaml(`
version: "1"
routes:
  - host: app.example.com
    path: /
    ssl: true
    headers:
      X-Frame-Options: DENY
      X-Flag: "true"
      X-Port: "8080"
      X-Zero: "007"
`);
    const out = formatManifestYaml(original);
    expect(out).toContain('X-Flag: "true"');
    expect(out).toContain('X-Port: "8080"');
    expect(out).toContain('X-Zero: "007"');
    // Unambiguous strings keep their plain (unquoted) form.
    expect(out).toContain('X-Frame-Options: DENY');
    const reparsed = parseManifestYaml(out);
    expect(reparsed.routes?.[0]?.headers).toEqual(original.routes?.[0]?.headers);
  });

  it('keeps newlines inside quoted scalar values without YAML folding corruption', () => {
    const original = parseManifestYaml('version: "1"\nbuild:\n  build: "echo one\\ntwo"\n');
    expect(original.build?.build).toBe('echo one\ntwo');
    const out = formatManifestYaml(original);
    // A raw newline inside the emitted double quotes would fold to a space.
    const m = parseManifestYaml(out);
    expect(m.build?.build).toBe('echo one\ntwo');
  });

  it('emits volume without backups when only mount is set', () => {
    const out = formatManifestYaml({ version: '1', volume: { mount: '/data' } });
    expect(out).toContain('volume:');
    expect(out).toContain('mount: /data');
    expect(out).not.toMatch(/backups:/);
  });

  it('omits the empty-array branch when arrays are present but empty', () => {
    // The schema applies defaults so the fields are always arrays here.
    // Empty arrays are still emitted (the `if length > 0` branch is the
    // false path on these specific constructs).
    const parsed = parseManifestYaml(`
version: "1"
network:
  publishPort: 8080
  aliases: []
notifications:
  onDeploy: []
  onFailure: []
  onAlert: []
`);
    const out = formatManifestYaml(parsed);
    expect(out).toContain('network:');
    expect(out).toContain('publishPort: 8080');
    expect(out).toContain('notifications:');
  });

  it('omits build and runtime sub-fields when not present', () => {
    // Build with no install/build/start/baseDir/dockerfile.
    const buildEmpty = formatManifestYaml({ version: '1', build: {} });
    expect(buildEmpty).toContain('build:');
    expect(buildEmpty).not.toMatch(/install:/);
    expect(buildEmpty).not.toMatch(/baseDir:/);
    expect(buildEmpty).not.toMatch(/dockerfile:/);

    // Runtime with no version.
    const runtimeNoVersion = formatManifestYaml({
      version: '1',
      runtime: { type: 'node' },
    });
    expect(runtimeNoVersion).toContain('runtime:');
    expect(runtimeNoVersion).toContain('type: node');
    // The header comment mentions the word "version" so check more specifically
    // for the indented `  version: "..."` line which is what runtime.version would emit.
    expect(runtimeNoVersion).not.toMatch(/\n {2}version:/);
  });

  it('omits run/static/env sub-fields when not present', () => {
    // Run with no port/healthcheck/restart.
    const runOnly = formatManifestYaml({ version: '1', run: {} });
    expect(runOnly).toContain('run:');
    expect(runOnly).not.toMatch(/port:/);
    expect(runOnly).not.toMatch(/healthcheck:/);
    expect(runOnly).not.toMatch(/restart:/);

    // Static with no root.
    const staticNoRoot = formatManifestYaml({
      version: '1',
      static: { spa: true },
    });
    expect(staticNoRoot).toContain('spa: true');
    expect(staticNoRoot).not.toMatch(/root:/);

    // Env with no required and no aliases.
    const envEmpty = formatManifestYaml({ version: '1', env: { required: [] } });
    expect(envEmpty).toContain('env:');
    expect(envEmpty).not.toMatch(/required:/);
    expect(envEmpty).not.toMatch(/aliases:/);
  });

  it('emits env with only required, and phases with only one of setup/build', () => {
    const onlyRequired = formatManifestYaml({
      version: '1',
      env: { required: ['A'] }, // no aliases
    });
    expect(onlyRequired).toContain('env:');
    expect(onlyRequired).toContain('required:');
    expect(onlyRequired).not.toMatch(/aliases:/);

    const onlySetup = formatManifestYaml({
      version: '1',
      phases: { setup: { pkgs: ['python310'] } }, // no build
    });
    expect(onlySetup).toContain('phases:');
    expect(onlySetup).toContain('setup:');
    expect(onlySetup).not.toMatch(/build:/);

    const onlyBuild = formatManifestYaml({
      version: '1',
      phases: { build: { cmds: ['npm run a'] } }, // no setup
    });
    expect(onlyBuild).toContain('phases:');
    expect(onlyBuild).toContain('build:');
    expect(onlyBuild).not.toMatch(/setup:/);
  });

  it('omits optional sub-fields when not present', () => {
    const out = formatManifestYaml({
      version: '1',
      routes: [{ host: 'a.example.com', path: '/', ssl: true }], // no redirectWww, headers, ipAllowlist, rateLimit
      previews: { enabled: true }, // no pattern
      volume: { backups: { schedule: '0 3 * * *', retention: 7 } }, // no mount
      network: { aliases: ['only-alias'] }, // no publishPort
      resources: {}, // no cpuShares, no memMb
      hooks: {}, // no preBuild, no postBuild, no preStop
    });
    expect(out).not.toMatch(/redirectWww/);
    expect(out).not.toMatch(/headers:/);
    expect(out).not.toMatch(/ipAllowlist:/);
    expect(out).not.toMatch(/rateLimit:/);
    expect(out).not.toMatch(/pattern:/);
    expect(out).not.toMatch(/mount:/);
    expect(out).not.toMatch(/publishPort:/);
    expect(out).not.toMatch(/cpuShares/);
    expect(out).not.toMatch(/memMb/);
    expect(out).not.toMatch(/preBuild/);
    expect(out).not.toMatch(/postBuild/);
    expect(out).not.toMatch(/preStop/);
  });

  it('omits the thresholdPct branch when an alert has no threshold', () => {
    const out = formatManifestYaml({
      version: '1',
      alerts: [{ when: 'deployFailed', channel: 'oncall' }],
    });
    expect(out).toContain('when: deployFailed');
    expect(out).not.toMatch(/thresholdPct/);
  });

  it('emits route ipAllowlist and rateLimit when present', () => {
    const out = formatManifestYaml({
      version: '1',
      routes: [
        {
          host: 'a.example.com',
          path: '/',
          ssl: true,
          ipAllowlist: ['1.2.3.4/32', '10.0.0.0/8'],
          rateLimit: { average: 50, burst: 100 },
        },
      ],
    });
    expect(out).toContain('ipAllowlist:');
    expect(out).toContain('1.2.3.4/32');
    expect(out).toContain('rateLimit:');
    expect(out).toContain('average: 50');
  });

  it('emits the static, phases, resources, hooks, watch, previews, volume and database sections', () => {
    const out = formatManifestYaml({
      version: '1',
      static: { spa: true, root: 'dist' },
      phases: {
        setup: { pkgs: ['python310'] },
        build: { cmds: ['npm run a', 'npm run b'] },
      },
      resources: { cpuShares: 1024, memMb: 512 },
      hooks: { preBuild: './a.sh', postBuild: './b.sh', preStop: './c.sh' },
      watch: { paths: ['apps/web/**'] },
      previews: { enabled: true, pattern: 'pr-{n}.example.com' },
      volume: { mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } },
      database: { ref: 'app-db', env: 'DATABASE_URL' },
    });
    expect(out).toContain('static:');
    expect(out).toContain('phases:');
    expect(out).toContain('resources:');
    expect(out).toContain('hooks:');
    expect(out).toContain('watch:');
    expect(out).toContain('previews:');
    expect(out).toContain('volume:');
    expect(out).toContain('database:');
  });

  it('quotes values that contain shell-special characters', () => {
    const out = formatManifestYaml({
      version: '1',
      build: { install: 'echo "hi" > /tmp/x' },
    });
    expect(out).toContain('"echo \\"hi\\" > /tmp/x"');
  });
});

describe('detectProjectKind', () => {
  it('returns node-pnpm when pnpm-lock.yaml is present', () => {
    expect(detectProjectKind(['pnpm-lock.yaml', 'package.json'])).toBe('node-pnpm');
  });

  it('returns node-npm when only package.json is present', () => {
    expect(detectProjectKind(['package.json'])).toBe('node-npm');
  });

  it('returns python when pyproject.toml is present', () => {
    expect(detectProjectKind(['pyproject.toml'])).toBe('python');
  });

  it('returns go when go.mod is present', () => {
    expect(detectProjectKind(['go.mod'])).toBe('go');
  });

  it('returns static when a Vite config is present', () => {
    expect(detectProjectKind(['vite.config.ts', 'package.json'])).toBe('static');
  });

  it('returns unknown for an empty file list', () => {
    expect(detectProjectKind([])).toBe('unknown');
  });
});

describe('starterManifest', () => {
  // Versions are asserted against the runtime catalog rather than literals:
  // these starters exist to track the recommended pin, so hard-coding a
  // number here would just recreate the drift the catalog was added to stop.
  it('pins the recommended Node version for node-npm', () => {
    const m = starterManifest('node-npm');
    expect(m.runtime?.type).toBe('node');
    expect(m.runtime?.version).toBe(recommendedRuntimeVersion('node'));
    expect(m.build?.install).toBe('npm ci');
  });

  it('uses pnpm commands for node-pnpm', () => {
    const m = starterManifest('node-pnpm');
    expect(m.build?.install).toBe('pnpm install --frozen-lockfile');
    expect(m.runtime?.version).toBe(recommendedRuntimeVersion('node'));
  });

  it('pins the recommended Python version for python projects', () => {
    const m = starterManifest('python');
    expect(m.runtime?.type).toBe('python');
    expect(m.runtime?.version).toBe(recommendedRuntimeVersion('python'));
  });

  it('pins the recommended Go version for go projects', () => {
    const m = starterManifest('go');
    expect(m.runtime?.type).toBe('go');
    expect(m.runtime?.version).toBe(recommendedRuntimeVersion('go'));
  });

  it('never pins a version that is already end-of-life', () => {
    for (const kind of ['node-npm', 'node-pnpm', 'python', 'go'] as const) {
      const runtime = starterManifest(kind).runtime;
      const advisory = runtimeVersionAdvisory(runtime?.type ?? 'auto', runtime?.version);
      expect(advisory).toBeNull();
    }
  });

  it('declares a static SPA config for vite-style projects', () => {
    const m = starterManifest('static');
    expect(m.static?.spa).toBe(true);
    expect(m.static?.root).toBe('dist');
  });

  it('returns a minimal placeholder for unknown projects', () => {
    const m = starterManifest('unknown');
    expect(m.runtime?.type).toBe('auto');
  });
});

describe('buildManifestFromTemplate (G-04)', () => {
  it('produces a canonical starter with port + healthcheck + restart defaults', () => {
    const manifest = buildManifestFromTemplate({
      id: 'n8n',
      name: 'n8n',
      image: 'n8nio/n8n',
      port: 5678,
    });

    expect(manifest.version).toBe('1');
    expect(manifest.runtime).toEqual({ type: 'auto' });
    expect(manifest.run?.port).toBe(5678);
    expect(manifest.run?.healthcheck).toBe('/');
    expect(manifest.run?.restart).toBe('unless-stopped');
    expect(manifest.env).toBeUndefined();
    expect(manifest.routes).toEqual([{ host: '', path: '/', ssl: true }]);
  });

  it('copies volumeMount into volume.mount when present', () => {
    const manifest = buildManifestFromTemplate({
      id: 'n8n',
      name: 'n8n',
      image: 'n8nio/n8n',
      port: 5678,
      volumeMount: '/home/node/.n8n',
    });
    expect(manifest.volume).toEqual({ mount: '/home/node/.n8n' });
  });

  it('collects env keys but never their values', () => {
    const manifest = buildManifestFromTemplate({
      id: 'activepieces',
      name: 'Activepieces',
      image: 'activepieces/activepieces:latest',
      port: 80,
      env: [
        { key: 'AP_ENCRYPTION_KEY', value: 'should-never-appear', secret: true },
        { key: 'AP_JWT_SECRET', value: 'should-never-appear', secret: true },
      ],
    });

    expect(manifest.env?.required).toEqual(['AP_ENCRYPTION_KEY', 'AP_JWT_SECRET']);
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain('should-never-appear');
  });

  it('omits env entirely when the registry entry has no env vars', () => {
    const manifest = buildManifestFromTemplate({
      id: 'plausible',
      name: 'Plausible',
      image: 'plausible/plausible:latest',
    });
    expect(manifest.env).toBeUndefined();
  });

  it('omits volume when the registry entry has no volumeMount', () => {
    const manifest = buildManifestFromTemplate({
      id: 'plausible',
      name: 'Plausible',
      image: 'plausible/plausible:latest',
    });
    expect(manifest.volume).toBeUndefined();
  });

  it('uses the supplied defaultHost for the starter route', () => {
    const manifest = buildManifestFromTemplate(
      { id: 'n8n', name: 'n8n', image: 'n8nio/n8n', port: 5678 },
      'automation.example.com',
    );
    expect(manifest.routes?.[0]).toEqual({
      host: 'automation.example.com',
      path: '/',
      ssl: true,
    });
  });

  it('produces output that round-trips through the manifest schema', () => {
    const manifest = buildManifestFromTemplate(
      { id: 'plausible', name: 'Plausible', image: 'plausible/plausible:latest', port: 3000 },
      'automation.example.com',
    );
    // The builder must produce data that the schema accepts — otherwise the
    // loader would reject the file at deploy time.
    const yaml = formatManifestYaml(manifest);
    expect(() => parseManifestYaml(yaml)).not.toThrow();
  });
});
