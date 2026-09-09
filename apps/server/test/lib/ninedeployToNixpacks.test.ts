import { describe, expect, it } from 'vitest';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import {
  NIXPACKS_TARGET_VERSION,
  generateNixpacksToml,
} from '../../src/lib/ninedeployToNixpacks.js';

const manifest = (overrides: Partial<NinedeployManifest>): NinedeployManifest => ({
  version: '1',
  ...overrides,
});

/** Convenience: most assertions only care about the file contents. */
const toml = (overrides: Partial<NinedeployManifest>): string | null =>
  generateNixpacksToml(manifest(overrides)).toml;

const warnings = (overrides: Partial<NinedeployManifest>): string[] =>
  generateNixpacksToml(manifest(overrides)).warnings;

describe('generateNixpacksToml', () => {
  it('returns null when the manifest has no Nixpacks-relevant fields', () => {
    expect(toml({})).toBeNull();
    expect(toml({ env: { required: ['X'] } })).toBeNull();
    expect(toml({ watch: { paths: ['apps/**'] } })).toBeNull();
  });

  it('emits [phases.install] from build.install', () => {
    const out = toml({ build: { install: 'npm ci' } });
    expect(out).toContain('[phases.install]');
    expect(out).toContain('cmds = [');
    expect(out).toContain('"npm ci"');
  });

  it('emits [phases.build] from build.build', () => {
    expect(toml({ build: { build: 'npm run build' } })).toContain('"npm run build"');
  });

  it('concatenates build.build with phases.build.cmds in [phases.build]', () => {
    const out = toml({
      build: { build: 'npm run build' },
      phases: { build: { cmds: ['npm run build:assets', 'npm run build:server'] } },
    });
    expect(out).toContain('"npm run build"');
    expect(out).toContain('"npm run build:assets"');
    expect(out).toContain('"npm run build:server"');
  });

  it('emits [phases.start] with the start command', () => {
    const out = toml({ build: { start: 'node server.js' } });
    expect(out).toContain('[phases.start]');
    expect(out).toContain('cmd = "node server.js"');
  });

  it('escapes embedded double quotes and backslashes in command values', () => {
    expect(toml({ build: { build: 'echo "hi" \\path' } })).toContain(
      '"echo \\"hi\\" \\\\path"',
    );
  });

  it('escapes newlines and control characters inside command strings', () => {
    // The values come from a repo-controlled manifest. A raw newline must not
    // terminate the TOML string and let the next line parse as a fresh key —
    // otherwise a commit rewrites the structure of the generated file.
    const hostile = 'echo one\n[phases.pwn]\nflag = true\tand\rdone\x00.';
    const out = toml({ build: { build: hostile } })!;
    expect(out).toContain('echo one\\n[phases.pwn]\\nflag = true\\tand\\rdone\\u0000.');
    // The hostile payload stays inside the one quoted string: no raw newline
    // directly precedes what would otherwise be a new TOML table header.
    expect(out).not.toContain('\n[phases.pwn]');
  });
});

describe('generateNixpacksToml — extra nix packages', () => {
  // Nixpacks REPLACES the provider's package list unless the sentinel "..." is
  // present. Without it, declaring one extra package deletes the toolchain
  // the provider selected, and the build fails with no compiler.
  it('keeps the provider toolchain by leading nixPkgs with the "..." sentinel', () => {
    const out = toml({ phases: { setup: { pkgs: ['imagemagick'] } } });
    expect(out).toContain('[phases.setup]');
    expect(out).toContain('"..."');
    expect(out).toContain('"imagemagick"');
    const sentinelAt = (out ?? '').indexOf('"..."');
    const pkgAt = (out ?? '').indexOf('"imagemagick"');
    expect(sentinelAt).toBeGreaterThan(-1);
    expect(sentinelAt).toBeLessThan(pkgAt);
  });

  it('preserves the order of several declared packages', () => {
    const out = toml({ phases: { setup: { pkgs: ['python310', 'imagemagick'] } } }) ?? '';
    expect(out.indexOf('"python310"')).toBeLessThan(out.indexOf('"imagemagick"'));
  });

  it('omits [phases.setup] entirely when no extra packages are declared', () => {
    // The runtime toolchain is never named here — that is the provider's job.
    expect(toml({ runtime: { type: 'node', version: '24' } })).not.toContain('[phases.setup]');
  });
});

describe('generateNixpacksToml — runtime version pins', () => {
  it('does not pin anything for type=auto or a missing version', () => {
    expect(toml({ runtime: { type: 'auto' } })).toBeNull();
    expect(toml({ runtime: { type: 'node' } })).toBeNull();
    expect(warnings({ runtime: { type: 'auto', version: '24' } })).toEqual([]);
  });

  it('emits NIXPACKS_NODE_VERSION for a supported Node major', () => {
    const out = toml({ runtime: { type: 'node', version: '24' } });
    expect(out).toContain('[variables]');
    expect(out).toContain('NIXPACKS_NODE_VERSION = "24"');
    expect(warnings({ runtime: { type: 'node', version: '24' } })).toEqual([]);
  });

  it('passes a Node range through untouched — Nixpacks parses semver itself', () => {
    expect(toml({ runtime: { type: 'node', version: '24.4.1' } })).toContain(
      'NIXPACKS_NODE_VERSION = "24.4.1"',
    );
  });

  it('refuses a Node major Nixpacks would silently downgrade to 18', () => {
    const result = generateNixpacksToml(manifest({ runtime: { type: 'node', version: '26' } }));
    expect(result.toml).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('26');
    expect(result.warnings[0]).toContain('silently fall back to 18');
  });

  it('emits NIXPACKS_PYTHON_VERSION as a major.minor series', () => {
    expect(toml({ runtime: { type: 'python', version: '3.13' } })).toContain(
      'NIXPACKS_PYTHON_VERSION = "3.13"',
    );
    expect(toml({ runtime: { type: 'python', version: '3.13.2' } })).toContain(
      'NIXPACKS_PYTHON_VERSION = "3.13"',
    );
  });

  it('refuses a Python series Nixpacks cannot resolve', () => {
    const result = generateNixpacksToml(
      manifest({ runtime: { type: 'python', version: '3.14' } }),
    );
    expect(result.toml).toBeNull();
    expect(result.warnings[0]).toContain('3.7 to 3.13');
  });

  it('treats a bare Python major as an unresolvable series', () => {
    // "3" has no minor, so it cannot map onto a python3N package.
    expect(warnings({ runtime: { type: 'python', version: '3' } })).toHaveLength(1);
  });

  it('emits NIXPACKS_RUBY_VERSION only for an exact rbenv version', () => {
    expect(toml({ runtime: { type: 'ruby', version: '3.4.10' } })).toContain(
      'NIXPACKS_RUBY_VERSION = "3.4.10"',
    );
    expect(warnings({ runtime: { type: 'ruby', version: '3.4' } })[0]).toContain('rbenv');
  });

  it('emits NIXPACKS_RUST_VERSION only for a full version', () => {
    expect(toml({ runtime: { type: 'rust', version: '1.98.0' } })).toContain(
      'NIXPACKS_RUST_VERSION = "1.98.0"',
    );
    expect(warnings({ runtime: { type: 'rust', version: '1.98' } })[0]).toContain('1.98.0');
  });

  it('emits NIXPACKS_JDK_VERSION as a bare major for a shipped JDK', () => {
    expect(toml({ runtime: { type: 'java', version: '21' } })).toContain(
      'NIXPACKS_JDK_VERSION = "21"',
    );
    expect(toml({ runtime: { type: 'java', version: '17.0.9' } })).toContain(
      'NIXPACKS_JDK_VERSION = "17"',
    );
  });

  it('never emits a JDK version outside the set — Nixpacks fails the build on those', () => {
    const result = generateNixpacksToml(manifest({ runtime: { type: 'java', version: '25' } }));
    expect(result.toml).toBeNull();
    expect(result.warnings[0]).toContain('fails the build');
  });

  it('warns that Go and PHP versions must come from the repo, not the manifest', () => {
    const go = warnings({ runtime: { type: 'go', version: '1.27' } });
    expect(go[0]).toContain('go.mod');
    expect(go[0]).toContain(NIXPACKS_TARGET_VERSION);

    const php = warnings({ runtime: { type: 'php', version: '8.4' } });
    expect(php[0]).toContain('composer.json');
  });

  it('warns without a suggested alternative for a runtime with no pin path at all', () => {
    expect(warnings({ runtime: { type: 'static', version: '1' } })[0]).toContain(
      'cannot pin a static version',
    );
  });

  it('still emits the build phases when a version pin is refused', () => {
    // A rejected pin must not cost the operator their build commands.
    const result = generateNixpacksToml(
      manifest({
        runtime: { type: 'go', version: '1.27' },
        build: { install: 'go mod download', start: './app' },
      }),
    );
    expect(result.toml).toContain('"go mod download"');
    expect(result.toml).toContain('cmd = "./app"');
    expect(result.warnings).toHaveLength(1);
  });

  it('emits a complete nixpacks.toml for a full Node manifest', () => {
    const result = generateNixpacksToml(
      manifest({
        runtime: { type: 'node', version: '24' },
        build: { install: 'npm ci', build: 'npm run build', start: 'node server.js' },
        phases: {
          setup: { pkgs: ['imagemagick'] },
          build: { cmds: ['npm run build:assets'] },
        },
      }),
    );
    const out = result.toml ?? '';
    expect(out).toContain('[phases.setup]');
    expect(out).toContain('"..."');
    expect(out).toContain('"imagemagick"');
    expect(out).toContain('[phases.install]');
    expect(out).toContain('"npm ci"');
    expect(out).toContain('[phases.build]');
    expect(out).toContain('"npm run build"');
    expect(out).toContain('"npm run build:assets"');
    expect(out).toContain('[phases.start]');
    expect(out).toContain('"node server.js"');
    expect(out).toContain('[variables]');
    expect(out).toContain('NIXPACKS_NODE_VERSION = "24"');
    expect(result.warnings).toEqual([]);
  });
});
