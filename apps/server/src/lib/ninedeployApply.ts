import type { BuildConfig } from '@ninedeploy/db';
import type { NinedeployManifest } from '@ninedeploy/schemas';

/**
 * Apply a `.ninedeploy` manifest onto an existing `BuildConfig`.
 *
 * Merge rule: **panel/DB > manifest > auto-detect**. Every manifest field is
 * applied only when the matching `BuildConfig` field is null/undefined — a
 * value the operator already set in the panel is never overwritten by the
 * repo. This keeps the panel authoritative while letting the manifest fill
 * in the gaps for the 95% of services where the panel is left empty.
 *
 * What is NOT patched here, and why:
 *
 *   • `runtime` / `phases` — expressed through a generated `nixpacks.toml`
 *     instead (`ninedeployToNixpacks.ts`, rendered by the Docker builder).
 *   • `env.required` — surfaced in the build log as a warning, not a config
 *     value (`findMissingRequiredEnv` below).
 *   • `routes` / `database` / `alerts` — routed through
 *     `applyManifestToService.ts`, which writes real rows.
 *   • **`hooks` — deliberately excluded.** Deploy lifecycle hooks execute on
 *     the HOST (`engine/pipeline.ts:runHook`), which is why
 *     `lib/hostPrivilege.ts` gates them behind the instance-operator flag. That
 *     gate reads the STORED build config before the deploy starts, so honouring
 *     a manifest-supplied hook would let anyone who can push to the repository
 *     run commands on the host — bypassing the boundary entirely, and breaking
 *     container isolation for ordinary Docker services. Hooks stay a panel-only
 *     setting; a manifest that declares them gets a deploy-log warning.
 */
export function applyManifestToBuildConfig(
  manifest: NinedeployManifest,
  buildConfig: BuildConfig,
): BuildConfig {
  return {
    ...buildConfig,
    installCmd: buildConfig.installCmd ?? manifest.build?.install ?? null,
    buildCmd: buildConfig.buildCmd ?? manifest.build?.build ?? null,
    startCmd: buildConfig.startCmd ?? manifest.build?.start ?? null,
    // baseDir in the DB is a non-null string with default '/'; treat '/' as
    // "operator did not customise" so a manifest value can still win.
    baseDir: isUnsetBaseDir(buildConfig.baseDir)
      ? (manifest.build?.baseDir ?? buildConfig.baseDir)
      : buildConfig.baseDir,
    dockerfilePath: buildConfig.dockerfilePath ?? manifest.build?.dockerfile ?? null,
    // `run.restart` maps straight onto `docker --restart`. Safe to accept from
    // the repo: it changes only how the container is supervised, not what runs
    // in it. 'unless-stopped' is the schema default, i.e. "operator untouched".
    restartPolicy:
      buildConfig.restartPolicy === 'unless-stopped'
        ? (manifest.run?.restart ?? buildConfig.restartPolicy)
        : buildConfig.restartPolicy,
  };
}

/**
 * Returns true when the baseDir holds the panel default and the manifest is
 * allowed to override. The DB schema sets `baseDir` to `'/'` by default, so
 * a strict `!== null` check would never trigger. Anything else (a real
 * sub-directory, an empty string set by accident) is treated as deliberate.
 */
function isUnsetBaseDir(value: string): boolean {
  return value === '/' || value === '';
}

/**
 * Validate that every `env.required` key the manifest declares is also
 * present in the runtime env map. Returns the list of missing keys so the
 * build log can warn the operator. Pure function — the caller decides
 * whether missing keys should fail the build or just log.
 */
export function findMissingRequiredEnv(
  manifest: NinedeployManifest,
  env: Record<string, string>,
): string[] {
  const required = manifest.env?.required ?? [];
  return required.filter((key) => !(key in env));
}
