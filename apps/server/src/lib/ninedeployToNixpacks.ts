import type { NinedeployManifest, RuntimeType } from '@ninedeploy/schemas';

/**
 * Translate a `.ninedeploy` manifest into a Nixpacks-compatible `nixpacks.toml`
 * string, plus the warnings an operator needs to see when the manifest asks
 * for something Nixpacks cannot express.
 *
 * NOT YET WIRED INTO THE BUILD. Nothing calls this function: the deploy
 * pipeline (`engine/pipeline.ts`) applies only the manifest's *operational*
 * sections — routes, alerts, database — and the Nixpacks builder
 * (`engine/builders/docker.ts`) invokes the CLI with `--install-cmd` /
 * `--build-cmd` / `--start-cmd` and never writes a `nixpacks.toml`. Until it
 * does, `runtime`, `phases` and `build.*` in a manifest have no effect on a
 * build. See `docs/NINEDEPLOY_MANIFEST.md` §4.1.
 *
 * The function is pure: same input, same output, no I/O.
 *
 * Why version pins go through environment variables
 * -------------------------------------------------
 * An earlier version of this file emitted hand-built nixpkgs attribute names
 * (`go_127`, `ruby_34`, `nodejs_20`) into `[phases.setup] nixPkgs`. That is
 * wrong in three compounding ways, all checked against the Nixpacks release
 * the installer pins (v1.41.0):
 *
 *   1. `nixPkgs` REPLACES the provider's package list rather than extending
 *      it, unless the list contains the literal `"..."` sentinel. A pin
 *      therefore deleted the toolchain the provider had already selected.
 *   2. The name resolves against the archive the *provider* pinned, not
 *      current nixpkgs. Those archives are old (the fallback is from
 *      September 2023), so modern attributes are simply absent.
 *   3. An attribute that does not resolve is a hard `undefined variable` Nix
 *      evaluation error during `docker build` — a late, opaque failure.
 *
 * So version pins are expressed only through the provider environment
 * variables Nixpacks actually reads, and a pin it cannot express becomes a
 * warning instead of a silently-wrong or broken build.
 *
 * Field mapping:
 *   - `runtime.version`   -> NIXPACKS_<TYPE>_VERSION, when the provider has one
 *   - `phases.setup.pkgs` -> nixPkgs, extending the provider's list via `"..."`
 *   - `phases.build.cmds` -> [phases.build].cmds
 *   - `build.install`     -> [phases.install].cmds
 *   - `build.build`       -> [phases.build].cmds (prepended)
 *   - `build.start`       -> [phases.start].cmd
 */

/** Nixpacks release the installer pins; the support sets below track it. */
export const NIXPACKS_TARGET_VERSION = '1.41.0';

type PinResolution = { value: string } | { reason: string };

interface RuntimePin {
  /** Environment variable name as it appears in `[variables]`. */
  variable: string;
  /** Turn a manifest version into the value to emit, or explain why not. */
  resolve: (version: string) => PinResolution;
}

/** Leading numeric segment, e.g. "24.4.1" -> "24". */
const major = (version: string): string => version.split('.')[0] ?? '';

/** First two segments, e.g. "3.14.2" -> "3.14"; "" when there is no minor. */
const series = (version: string): string => {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : '';
};

const isExactPatch = (version: string): boolean => version.split('.').length === 3;

/**
 * How each runtime's version reaches Nixpacks v1.41.0. The supported sets are
 * read from the provider sources rather than the docs, which are stale on
 * both Node and PHP.
 *
 * Go and PHP are absent on purpose: neither provider reads a configuration
 * variable in v1.41.0. Their versions come from `go.mod` and `composer.json`
 * respectively, which is the repository's job, not the manifest's.
 */
const RUNTIME_PINS: Partial<Record<RuntimeType, RuntimePin>> = {
  // `src/providers/node/mod.rs`, AVAILABLE_NODE_VERSIONS. Nixpacks parses the
  // value as a semver range, so the manifest string passes through as-is;
  // only the major has to be one it can resolve. An unsupported major falls
  // back to Node 18 silently, which is exactly the surprise we warn about.
  node: {
    variable: 'NIXPACKS_NODE_VERSION',
    resolve: (version) =>
      ['14', '16', '18', '20', '22', '24'].includes(major(version))
        ? { value: version }
        : {
            reason: `Nixpacks ${NIXPACKS_TARGET_VERSION} can only build Node 14, 16, 18, 20, 22 or 24, and would silently fall back to 18`,
          },
  },
  // `src/providers/python.rs`, the (major, minor) match arm.
  python: {
    variable: 'NIXPACKS_PYTHON_VERSION',
    resolve: (version) => {
      const value = series(version) || `${major(version)}.0`;
      return ['2.7', '3.7', '3.8', '3.9', '3.10', '3.11', '3.12', '3.13'].includes(value)
        ? { value }
        : {
            reason: `Nixpacks ${NIXPACKS_TARGET_VERSION} can only build Python 2.7 and 3.7 to 3.13, and would silently fall back to its default python3`,
          };
    },
  },
  // `src/providers/ruby.rs`: the value is handed to `rbenv install`, which
  // needs a full version rather than a series.
  ruby: {
    variable: 'NIXPACKS_RUBY_VERSION',
    resolve: (version) =>
      isExactPatch(version)
        ? { value: version }
        : { reason: 'Ruby is installed through rbenv, which needs an exact version like 3.4.10' },
  },
  // `src/providers/rust.rs`: interpolated into `rust-bin.stable."<v>".default`,
  // an attribute that only exists for full versions.
  rust: {
    variable: 'NIXPACKS_RUST_VERSION',
    resolve: (version) =>
      isExactPatch(version)
        ? { value: version }
        : { reason: 'The Rust overlay only has full versions, so use 1.98.0 rather than 1.98' },
  },
  // `src/providers/java.rs`: a bare major, and the only provider that *bails*
  // on an unsupported value rather than falling back. Emitting an out-of-set
  // version would fail the build outright, so we refuse to emit it.
  java: {
    variable: 'NIXPACKS_JDK_VERSION',
    resolve: (version) =>
      ['8', '11', '17', '19', '20', '21'].includes(major(version))
        ? { value: major(version) }
        : {
            reason: `Nixpacks ${NIXPACKS_TARGET_VERSION} only ships JDK 8, 11, 17, 19, 20 and 21, and fails the build on anything else`,
          },
  },
};

/** Runtimes Nixpacks v1.41.0 cannot pin from a manifest at all. */
const NO_PIN_PATH: Partial<Record<RuntimeType, string>> = {
  go: 'set the `go` directive in go.mod instead',
  php: 'set `require.php` in composer.json instead',
};

/**
 * `nixPkgs` replaces the provider's package list unless this sentinel is
 * present, in which case it expands to whatever the provider chose. Every
 * list we emit starts with it so extra packages are additive, as documented.
 */
const KEEP_PROVIDER_PKGS = '...';

function formatTomlString(value: string): string {
  // TOML basic strings: escape backslash, double-quote and every control
  // character (TOML v1.0 §2.1 — raw control chars are illegal in basic
  // strings). The values serialized here are repo-controlled command lines
  // and version strings: without the escapes, a literal newline inside a
  // manifest command would terminate the string and let the next line parse
  // as a fresh TOML key, rewriting the generated file's structure.
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\f': out += '\\f'; break;
      case '\r': out += '\\r'; break;
      default: {
        const code = ch.codePointAt(0)!;
        out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
      }
    }
  }
  return `"${out}"`;
}

function formatTomlArray(values: string[]): string {
  if (values.length === 0) return '[]';
  const lines = values.map((v) => `    ${formatTomlString(v)}`);
  return `[\n${lines.join(',\n')},\n  ]`;
}

export interface NixpacksTomlResult {
  /** The file contents, or `null` when the manifest has nothing to express. */
  toml: string | null;
  /** Operator-facing notes about pins that could not be honoured. */
  warnings: string[];
}

export function generateNixpacksToml(manifest: NinedeployManifest): NixpacksTomlResult {
  const sections: string[] = [];
  const variables: string[] = [];
  const warnings: string[] = [];

  // [phases.setup] nixPkgs — only the operator's explicit extra packages. The
  // runtime toolchain is the provider's job; see the header for why we no
  // longer name it here.
  const extraPkgs = manifest.phases?.setup?.pkgs ?? [];
  if (extraPkgs.length > 0) {
    sections.push(
      `[phases.setup]\nnixPkgs = ${formatTomlArray([KEEP_PROVIDER_PKGS, ...extraPkgs])}`,
    );
  }

  // [phases.install] (manifest.build.install)
  const installCmds: string[] = [];
  if (manifest.build?.install) installCmds.push(manifest.build.install);
  if (installCmds.length > 0) {
    sections.push(`[phases.install]\ncmds = ${formatTomlArray(installCmds)}`);
  }

  // [phases.build] (manifest.build.build + manifest.phases.build.cmds)
  const buildCmds: string[] = [];
  if (manifest.build?.build) buildCmds.push(manifest.build.build);
  for (const cmd of manifest.phases?.build?.cmds ?? []) {
    buildCmds.push(cmd);
  }
  if (buildCmds.length > 0) {
    sections.push(`[phases.build]\ncmds = ${formatTomlArray(buildCmds)}`);
  }

  // [phases.start] (manifest.build.start)
  if (manifest.build?.start) {
    sections.push(`[phases.start]\ncmd = ${formatTomlString(manifest.build.start)}`);
  }

  // [variables] (NIXPACKS_<TYPE>_VERSION)
  const runtime = manifest.runtime;
  if (runtime?.type && runtime.type !== 'auto' && runtime.version) {
    const pin = RUNTIME_PINS[runtime.type];
    if (!pin) {
      const alternative = NO_PIN_PATH[runtime.type];
      warnings.push(
        alternative
          ? `runtime.version "${runtime.version}" is not applied: Nixpacks ${NIXPACKS_TARGET_VERSION} has no ${runtime.type} version variable, so ${alternative}.`
          : `runtime.version "${runtime.version}" is not applied: Nixpacks ${NIXPACKS_TARGET_VERSION} cannot pin a ${runtime.type} version.`,
      );
    } else {
      const resolved = pin.resolve(runtime.version);
      if ('value' in resolved) {
        variables.push(`${pin.variable} = ${formatTomlString(resolved.value)}`);
      } else {
        warnings.push(`runtime.version "${runtime.version}" is not applied: ${resolved.reason}.`);
      }
    }
  }
  if (variables.length > 0) {
    sections.push(`[variables]\n${variables.join('\n')}`);
  }

  // Two blank lines between sections is the Nixpacks-recommended style.
  const toml = sections.length === 0 ? null : `${sections.join('\n\n')}\n`;
  return { toml, warnings };
}
