import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Builder, DeployRuntime } from '../types.js';
import { capture, run } from '../../lib/exec.js';
import { repoRelative } from '../../lib/repoPath.js';
import { INLINE_COMPOSE_FILE } from '../../lib/composeWorkspace.js';
import { connectTraefikToComposeNetwork } from '../../lib/serviceBridge.js';

const DEPLOY_HEARTBEAT_MS = 20_000;

/**
 * Render one .env VALUE for compose's dotenv parser, verified against
 * docker compose v5 (compose-go). Unquoted values are truncated at the
 * first ` #` (inline-comment strip), so a secret like `abc #def` would
 * reach the container as `abc` while the panel stores the full value.
 * Double-quoting fixes that, but double-quoted values then undergo
 * `$VAR` expansion from the panel's own environment (a secret containing
 * `$HOME` would leak host state), so `$` is escaped as `\$`. Escapes
 * verified byte-exact with `docker compose config --format json`:
 * `\\`, `\"`, `\$`, `\n`, `\r`, `\t`.
 */
function dotenvValue(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Docker Compose builder: `docker compose up -d --build` for multi-container
 * apps. Unlike the docker builder there is NO blue-green — compose replaces
 * the project in place (brief gap, like PM2). Rollback re-checks out the old
 * commit and re-ups. The compose file is `dockerfilePath` from the build
 * config (default docker-compose.yml) — except for an inline stack
 * (`service.composeContent`), which always runs the file the pipeline wrote.
 * `composeService` names the main service for routing/healthchecks.
 */

const PROJECT_PREFIX = 'ndcmp';

function composeProject(slug: string): string {
  return `${PROJECT_PREFIX}-${slug}`;
}

/** The default container name docker compose assigns: <project>-<service>-1. */
function mainContainer(slug: string, composeService: string): string {
  return `${composeProject(slug)}-${composeService}-1`;
}

/**
 * Compose files without an explicit `restart:` policy leave every container
 * unrestartable — they stay dead across daemon restarts and host reboots.
 * Compose `up` offers no policy override, so apply the platform default
 * (unless-stopped, same as the docker builder) to the project's containers
 * after each `up`. `docker update` persists the policy on the container.
 */
async function applyBootRestartPolicy(
  project: string,
  composeFile: string,
  workDir: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    const ids = (
      await capture(
        'docker',
        ['compose', '-p', project, '-f', composeFile, 'ps', '-aq'],
        { cwd: workDir },
      )
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length === 0) return;
    await run('docker', ['update', '--restart', 'unless-stopped', ...ids], {}, log);
    log(`restart policy unless-stopped applied to ${ids.length} compose container(s)`);
  } catch (err) {
    // Best-effort: the deployment itself is up; only reboot persistence is at
    // risk. The next deploy retries this automatically.
    log(`warning: could not apply boot restart policy: ${err instanceof Error ? err.message : err}`);
  }
}

interface ComposePsEntry {
  Name?: string;
  State?: string;
}

/**
 * `docker compose ps --format json` output varies by CLI version: a JSON
 * array, or one JSON object per line. Accept both; null when unparseable.
 */
function parseComposePs(out: string): ComposePsEntry | null {
  const text = out.trim();
  if (!text) return null;
  try {
    const whole: unknown = JSON.parse(text);
    if (Array.isArray(whole)) return (whole[0] ?? null) as ComposePsEntry | null;
    if (whole && typeof whole === 'object') return whole as ComposePsEntry;
  } catch {
    /* fall through to line mode */
  }
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line) as ComposePsEntry;
      if (entry && typeof entry === 'object') return entry;
    } catch {
      /* skip non-JSON line */
    }
  }
  return null;
}

export const composeBuilder: Builder = {
  async buildAndRun(ctx): Promise<DeployRuntime> {
    const { service, buildConfig, workDir, env, log } = ctx;
    const composeService = service.composeService ?? service.slug;
    // An inline stack is always written to INLINE_COMPOSE_FILE by the
    // pipeline, so the build config's path is not a choice here — honouring it
    // would point `-f` at a file nothing writes the moment someone fills in
    // the (Dockerfile-shaped) Settings field.
    //
    // Otherwise: same re-anchoring as the docker builder — `-f` runs with
    // cwd=workDir, so an absolute or climbing path would read a compose file
    // off the host.
    const composeFile = service.composeContent
      ? INLINE_COMPOSE_FILE
      : repoRelative(workDir, buildConfig?.dockerfilePath || INLINE_COMPOSE_FILE);
    const project = composeProject(service.slug);

    log(`Bringing up compose project ${project} (${composeFile}) …`);

    // Materialise a per-deploy override file that adds the user-attached
    // volumes to the main service. Compose merges -f files left-to-right, so
    // the override WINS over the user's compose for any duplicate key — that
    // is the desired behaviour (operators may not have set the volume
    // themselves, and the override is the source of truth for attachments).
    // Without any attachments this is a no-op and the file is omitted.
    const overrides = ctx.volumeAttachments ?? [];
    let overrideFile: string | null = null;
    if (overrides.length > 0) {
      overrideFile = path.join(workDir, '.ninedeploy.compose.override.yml');
      const services: Record<string, { volumes: string[] }> = {
        [composeService]: { volumes: overrides.map((a) => `${a.volumeName}:${a.containerPath}${a.readOnly ? ':ro' : ''}`) },
      };
      // YAML by hand for two known keys — pulling in a YAML dep just to emit
      // this is not worth the install. `yaml.dump` is JS string-safe because
      // volume names / container paths are validated against strict regexes
      // upstream.
      const volumesTopLevel: Record<string, object> = {};
      for (const a of overrides) volumesTopLevel[a.volumeName] = { external: true };
      const body =
        `services:\n` +
        Object.entries(services)
          .map(([svc, def]) => `  ${svc}:\n    volumes:\n${def.volumes.map((v) => `      - "${v}"`).join('\n')}\n`)
          .join('') +
        `volumes:\n` +
        Object.entries(volumesTopLevel)
          .map(([n]) => `  ${n}:\n    external: true\n`)
          .join('');
      writeFileSync(overrideFile, body, { mode: 0o600 });
      log(`Wrote ${overrides.length} volume attachment(s) into ${path.basename(overrideFile)}`);
    }

    // ── Preflight gates (BEFORE touching the running stack) ────────────────
    // Validate interpolation and pre-pull images while the previous revision
    // is still serving: a bad tag or a broken env reference must fail the
    // deployment WITHOUT ever having torn the live stack down.
    const stackArgs = ['compose', '-p', project, '-f', composeFile];
    if (overrideFile) stackArgs.push('-f', overrideFile);

    // Compose reads project env vars from the working directory's .env — we
    // write one so both interpolation below and container creation see the
    // resolved runtime secrets. Put back as it was in `finally`.
    //
    // r352: the repo may commit its own `.env` (interpolation defaults such
    // as `${PG_VERSION}` or `${APP_PORT}`). Overwriting it with panel-only
    // values — and then unlinking it unconditionally, even when the panel had
    // nothing to add — made those defaults resolve blank. Panel values are
    // appended AFTER the repo's lines (compose-go's dotenv parser is
    // last-wins per key, so a panel value overrides the repo's), and the
    // repo's exact bytes are restored afterwards; only a file this builder
    // created is removed.
    const dotEnv = path.join(workDir, '.env');
    let repoDotEnv: Buffer | null = null;
    try {
      repoDotEnv = readFileSync(dotEnv);
    } catch {
      /* no repo .env */
    }
    const wroteDotEnv = Object.keys(env).length > 0;
    if (wroteDotEnv) {
      const panelLines = `${Object.entries(env).map(([k, v]) => `${k}=${dotenvValue(v)}`).join('\n')}\n`;
      const repoText = repoDotEnv?.toString('utf8') ?? '';
      const merged = repoText === '' || repoText.endsWith('\n') ? repoText + panelLines : `${repoText}\n${panelLines}`;
      writeFileSync(dotEnv, merged, { mode: 0o600 });
    }

    try {
      const gateOpts = {
        cwd: workDir,
        // Export the resolved environment into the compose CLI process too:
        // value-less list entries (`- SERVICE_URL_APP_3000`) are read from the
        // parent process environment at config/up time, NOT from .env.
        env: env as unknown as Record<string, string>,
        heartbeatMs: DEPLOY_HEARTBEAT_MS,
        heartbeatLabel: `Validating compose project ${project}`,
      };
      // Every step gets a hard ceiling so ONE hung docker call can never pin
      // the worker's per-server deploy slot for the default 30-minute timeout.
      await run('docker', [...stackArgs, 'config', '--quiet'], { ...gateOpts, timeoutMs: 120_000 }, log);
      try {
        await run('docker', [...stackArgs, 'pull', '--ignore-buildable', '--quiet'], { ...gateOpts, timeoutMs: 900_000, heartbeatLabel: `Pulling images for ${project} (can take minutes on slow links)` }, log);
      } catch (pullErr) {
        // Older compose CLI versions lack --ignore-buildable; retry plainly
        // before giving up (still BEFORE `down`, so the live stack survives).
        log(`retrying image pull without --ignore-buildable (${pullErr instanceof Error ? pullErr.message : pullErr})`);
        await run('docker', [...stackArgs, 'pull', '--quiet'], { ...gateOpts, timeoutMs: 900_000, heartbeatLabel: `Pulling images for ${project} (can take minutes on slow links)` }, log);
      }

      // Stop the previous project revision first — no blue-green for compose.
      // Always pass -f: with a non-default compose file, plain `down` would look
      // at docker-compose.yml and miss the real project.
      const downArgs = [...stackArgs, 'down', '--remove-orphans'];
      await run(
        'docker',
        downArgs,
        { cwd: workDir, timeoutMs: 300_000, heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Stopping previous Compose project ${project}` },
        log,
      ).catch(() => undefined);

      const upArgs = [...stackArgs, 'up', '-d', '--build', '--remove-orphans'];
      await run(
        'docker',
        upArgs,
        // `up` blocks on the stack's own service_healthy chain (compose waits
        // for dependencies before starting dependents) — hence the generous
        // but bounded ceiling.
        { ...gateOpts, timeoutMs: 1_200_000, heartbeatLabel: `Starting Compose project ${project} (waiting for service healthchecks)` },
        log,
      );
    } finally {
      // r352: restore the repo's own .env byte-for-byte, or remove only the
      // file this builder created. Untouched when the panel had no values.
      try {
        if (wroteDotEnv && repoDotEnv !== null) writeFileSync(dotEnv, repoDotEnv);
        else if (wroteDotEnv) unlinkSync(dotEnv);
      } catch {
        /* best-effort cleanup */
      }
      try {
        if (overrideFile) unlinkSync(overrideFile);
      } catch {
        /* best-effort cleanup */
      }
    }
    await applyBootRestartPolicy(project, composeFile, workDir, log);

    // Route-ability: Traefik must share the project's default network to reach
    // the stack's containers by DNS. Tolerant — routing failures surface as
    // the finalize PROXY_SWAP warning instead of failing a live deployment.
    try {
      await connectTraefikToComposeNetwork(service.slug, log);
    } catch (err) {
      log(`warning: could not attach traefik to ${project}_default: ${err instanceof Error ? err.message : err}`);
    }

    // Resolve the ACTUAL main container. Compose's default suffix is `-1`,
    // but templates that pin `container_name:` (or scale changes) produce a
    // different name — routing must target what really runs. Strict JSON
    // validation: anything unparseable falls back to the deterministic name.
    let runtimeId = mainContainer(service.slug, composeService);
    try {
      const psOut = await capture('docker', [...stackArgs, 'ps', '--format', 'json', composeService], { cwd: workDir });
      const parsed = parseComposePs(psOut);
      if (parsed?.Name && parsed.State === 'running') {
        runtimeId = parsed.Name.replace(/^\//, '');
        if (runtimeId !== mainContainer(service.slug, composeService)) {
          log(`main container resolved as ${runtimeId}`);
        }
      }
    } catch (err) {
      log(`warning: could not resolve main container name, using ${runtimeId}: ${err instanceof Error ? err.message : err}`);
    }

    return {
      runtimeId,
      port: service.port ?? null,
      healthPath: service.healthPath || '/',
      imageDigest: undefined, // multi-container: digest pinning is per-service
    };
  },

  async isHealthy(runtime, timeoutMs = 60_000, _directGraceMs, log): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let baselineRestarts: number | undefined;
    while (Date.now() < deadline) {
      try {
        // Compose stacks author their own healthchecks; when present wait for
        // Docker's Health.Status instead of a bare `running` process state —
        // an app that boots, stays `running`, and fails its own healthcheck
        // forever must NOT deploy green. FailingStreak + RestartCount ride
        // along so a crash-looping app fails EARLY instead of burning the
        // whole window.
        const out = await capture('docker', [
          'inspect',
          runtime.runtimeId,
          '--format',
          '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}|{{.State.Health.FailingStreak}}{{else}}none|0{{end}}|{{.RestartCount}}',
        ]);
        const [status, health, failingStreak, restartCount] = out.trim().split('|');
        if (status === 'running' && health === 'none') return true; // no healthcheck defined
        if (status === 'running' && health === 'healthy') return true;
        if (status === 'healthy') return true; // defensive: alternate inspect shapes
        if (status === 'exited') {
          log?.(`${runtime.runtimeId} exited before becoming healthy`);
          return false;
        }
        // `running` with health `starting`/`unhealthy` keeps polling; the
        // failing-streak check below fails fast instead of waiting out the
        // full deadline on a healthcheck that will never pass.
        const restarts = Number(restartCount);
        if (Number.isFinite(restarts)) {
          baselineRestarts ??= restarts;
          if (restarts - baselineRestarts >= 3) {
            log?.(`${runtime.runtimeId} is crash-looping (restart count ${restarts}) — failing fast`);
            return false;
          }
        }
        if (Number(failingStreak) >= 15) {
          log?.(`${runtime.runtimeId} healthcheck keeps failing (streak ${failingStreak}) — failing fast`);
          return false;
        }
      } catch {
        /* container not up yet */
      }
      log?.(`waiting for ${runtime.runtimeId} …`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  },

  async stop(runtimeId): Promise<void> {
    // runtimeId is <project>-<service>-1, but both project (ndcmp-<slug>) and
    // service names contain hyphens, so the project cannot be recovered by
    // string surgery. Ask the container itself via compose's own labels —
    // that also yields the config file so `down` targets the right project.
    try {
      const labels = await capture('docker', [
        'inspect',
        runtimeId,
        '--format',
        '{{ index .Config.Labels "com.docker.compose.project" }}\t{{ index .Config.Labels "com.docker.compose.project.config_files" }}',
      ]);
      const [project, configFiles] = labels.trim().split('\t');
      if (!project) throw new Error('no compose project label');
      const args = ['compose', '-p', project];
      // Only pass config files that still exist: the deploy path deletes its
      // per-deploy override in `finally`, and a `down` referencing the dead
      // path exits nonzero without stopping anything — the stack would keep
      // running while stop() reports success.
      if (configFiles) {
        for (const f of configFiles.split(',')) {
          const candidate = f.trim();
          if (candidate && existsSync(candidate)) args.push('-f', candidate);
        }
      }
      args.push('down', '--remove-orphans');
      await run('docker', args, {}, () => {});
    } catch {
      // Container already gone — nothing to stop.
    }
  },
};
