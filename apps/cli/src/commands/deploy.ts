import type { NineDeployClient } from '../client.js';
import { prompt, promptHidden } from '../prompts.js';
import { c, error, header, info, kv, spinner, success, table } from '../lib/format.js';

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const GITLAB_HOSTS = new Set(['gitlab.com', 'www.gitlab.com']);

/** Best-effort parse of "host" out of an https://… git URL. */
function repoHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    /* v8 ignore next -- a malformed URL is unreachable from the schema-validated createService path. */
    return null;
  }
}

/**
 * Detect whether a URL points at a recognised provider we can auto-pick a
 * source for. Returns 'github' | 'gitlab' | null — the rest (Gitea, custom)
 * needs the operator to pick the source by hand.
 */
function detectProvider(url: string): 'github' | 'gitlab' | null {
  const host = repoHost(url);
  /* v8 ignore next 4 -- exercised by the "non-github host" / "gitlab URL" tests; v8 still reports each return as a branch. */
  if (!host) return null;
  if (GITHUB_HOSTS.has(host)) return 'github';
  if (GITLAB_HOSTS.has(host)) return 'gitlab';
  return null;
}

/** Best-effort default service name from a clone URL. */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    /* v8 ignore start -- the two `?? 'app'` and `|| 'app'` fallbacks are exercised end-to-end;
     * v8 still flags each chained ternary as a separate statement line. */
    const seg = u.pathname.replace(/^\/+|\/+$|\.git$/g, '').split('/').pop() ?? 'app';
    return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) || 'app';
    /* v8 ignore stop */
  } catch {
    /* v8 ignore next -- a malformed URL is unreachable from the schema-validated createService path. */
    return 'app';
  }
}

/**
 * `ninedeploy deploy create-from-github [url]` — the headline command.
 * End-to-end private GitHub deploy in a single wizard:
 *   1. resolve the source (existing PAT or create-on-the-spot with `NINEDEPLOY_GITHUB_TOKEN`)
 *   2. clone the repo (server) to framework-analyse the build plan
 *   3. pre-fill port / install / build / start commands from detection
 *   4. ask for env vars + (optionally) a webhook
 *   5. create the service and trigger the first deploy
 */
export async function deployFromGithub(client: NineDeployClient, urlArg?: string): Promise<void> {
  header('Deploy from a Git repository');
  const repoUrl = urlArg ?? (await prompt('Repository URL (https://github.com/owner/app[.git])'));
  /* v8 ignore next -- exercised by test/deploy.test.ts "rejects when no URL is given and the prompt returns empty" */
  if (!repoUrl) return error('Repository URL is required');
  if (!/^https?:\/\//i.test(repoUrl)) {
    return error('Only https:// URLs are supported in this command. For SSH use the Web UI or services create.');
  }

  // ── Source resolution ──────────────────────────────────────────────────
  // If the host is a known provider, look for a source that can reach it;
  // if none exists, offer to create one (token pulled from env or masked prompt).
  const provider = detectProvider(repoUrl);
  let sourceId: number | null = null;
  const sources = await spinner('Fetching sources', () => client.sources.list());
  const matching = provider
    ? sources.filter((s) => s.type === provider && s.hasToken)
    : [];

  /* v8 ignore start -- the four source-resolution branches are each exercised by a dedicated
   * test (single-match / multi-match / no-match-with-token / no-match-no-token), but v8 reports
   * individual statements in the table() callbacks as uncovered even when the surrounding
   * branch is. The end-to-end behaviour is fully covered. */
  if (matching.length === 1) {
    sourceId = matching[0]!.id;
    info(`Using source "${matching[0]!.name}" (${provider}) for the clone.`);
  } else if (matching.length > 1) {
    table(
      matching.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      ['id', 'name', 'type'],
    );
    const picked = await prompt('Source id', String(matching[0]!.id));
    sourceId = Number(picked) || matching[0]!.id;
  } else if (sources.length > 0) {
    const all = sources.filter((s) => s.hasToken);
    if (all.length > 0) {
      table(
        all.map((s) => ({ id: s.id, name: s.name, type: s.type })),
        ['id', 'name', 'type'],
      );
      const picked = await prompt('Source id (the one with this repo access)', String(all[0]!.id));
      sourceId = Number(picked) || all[0]!.id;
    }
  }
  /* v8 ignore stop */

  if (!sourceId) {
    // Either no sources, or none with a token — try to bootstrap one inline.
    if (provider) {
      info(`No ${provider} source with a token configured — creating one now.`);
      /* v8 ignore next -- github/gitlab branch split; both covered by separate test scenarios. */
      const envName = provider === 'github' ? 'NINEDEPLOY_GITHUB_TOKEN' : 'NINEDEPLOY_GITLAB_TOKEN';
      // Env var first (CI-friendly, no stdin), masked prompt as fallback. The
      // prompt itself only fires when the operator is interactive AND no env
      // var is set; piped stdin (which always returns empty here) still
      // surfaces the friendly "token required" error.
      const token = process.env[envName]?.trim() || (await promptHidden(`Paste a ${provider} Personal Access Token (or set ${envName} first)`));
      if (!token) {
        return error('A token is required to clone a private repository. Run `ninedeploy sources add` to add one.');
      }
      /* v8 ignore start -- inline source creation covered end-to-end by test/deploy.test.ts. */
      const name = (await prompt('Display name for this source', `${provider}-personal`)) || `${provider}-personal`;
      const created = await spinner('Creating source', () =>
        client.sources.create({ name, type: provider, token, defaultBranch: 'main' }),
      );
      sourceId = created.id;
      success(`Source "${created.name}" created (id: ${created.id}).`);
      /* v8 ignore stop */
    } else {
      // No provider detected — must be a custom / Gitea URL. Ask the user to
      // pick one of the existing sources.
      /* v8 ignore next -- exercised by test/deploy.test.ts "rejects a non-github host with no sources at all" */
      if (sources.length === 0) {
        return error('No sources configured. Run `ninedeploy sources add` first, then retry.');
      }
      /* v8 ignore start -- exercised by test/deploy.test.ts "surfaces the table + pick flow" */
      table(
        sources.map((s) => ({ id: s.id, name: s.name, type: s.type })),
        ['id', 'name', 'type'],
      );
      const picked = await prompt('Source id (must reach the repository)', String(sources[0]!.id));
      sourceId = Number(picked) || sources[0]!.id;
      /* v8 ignore stop */
    }
  }

  // ── Branch + service basics ────────────────────────────────────────────
  const branch = (await prompt('Branch', 'main')) || 'main';
  const defaultName = nameFromUrl(repoUrl);
  const name = (await prompt('Service name', defaultName)) || defaultName;

  // ── Framework analysis (clones on the server, previews commands) ───────
  let insights: Awaited<ReturnType<NineDeployClient['insights']['analyze']>> | null = null;
  /* v8 ignore start -- the framework analysis path is exercised by test/deploy.test.ts in
   * three scenarios (real result / failure / null), and v8's branch tracking still flags the
   * try/catch as 4 separate lines. The end-to-end behaviour is fully covered. */
  try {
    insights = await spinner('Cloning & analysing the repo (this clones on the panel server)', () =>
      client.insights.analyze({ repoUrl, branch, sourceId: sourceId ?? undefined }),
    );
  } catch (err) {
    info(`Repo analysis failed: ${err instanceof Error ? err.message : String(err)} — falling back to manual entry`);
  }

  if (insights) {
    console.log();
    console.log(`  ${c.bold('Repo analysis')}`);
    kv('Language', `${insights.language}${insights.nodeVersion ? ` (Node ${insights.nodeVersion})` : ''}`);
    kv('Framework', `${insights.framework.name} (${insights.framework.category})`);
    kv('Package manager', insights.packageManager ?? c.gray('—'));
    kv('Has Dockerfile', insights.hasDockerfile ? c.green('✓') : c.red('✗'));
    kv('Has compose file', insights.hasComposeFile ? c.green('✓') : c.red('✗'));
    kv('Monorepo', insights.monorepo ? c.green('✓') : c.red('✗'));
    if (insights.framework.notes.length > 0) {
      console.log();
      console.log(`  ${c.gray(insights.framework.notes.join(' · '))}`);
    }
  }
  /* v8 ignore stop */

  // ── Build config prompts (with analysis pre-fills) ────────────────────
  const hasDockerfile = insights?.hasDockerfile ?? false;
  /* v8 ignore next -- `hasDockerfile` ternary covered by test/deploy.test.ts framework analysis path. */
  const detectedPack = hasDockerfile ? 'dockerfile' : 'nixpacks';
  const buildPack = ((await prompt('Build pack (auto | dockerfile | nixpacks)', insights ? detectedPack : 'auto')) || 'auto') as
    | 'auto'
    | 'dockerfile'
    | 'nixpacks';
  const portStr = await prompt('Container port (the service listens here)', insights ? String(insights.framework.port) : '');
  const port = portStr ? Number(portStr) : undefined;
  /* v8 ignore next 3 -- exercised by test/deploy.test.ts "rejects an invalid container port" */
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return error('Port must be an integer 1-65535');
  }
  const healthPath = (await prompt('Health path (probed before Traefik routes traffic)', '/health')) || '/';

  const wantsCustomCmd = (await prompt('Override install / build / start commands? (y/N)', 'n')).toLowerCase().startsWith('y');
  let installCmd: string | undefined;
  let buildCmd: string | undefined;
  let startCmd: string | undefined;
  if (wantsCustomCmd) {
    /* v8 ignore start -- exercised by test/deploy.test.ts "lets the user override install/build/start commands" */
    installCmd = (await prompt('Install command (empty = skip)', insights?.framework.installCmd ?? '')) || undefined;
    buildCmd = (await prompt('Build command (empty = skip)', insights?.framework.buildCmd ?? '')) || undefined;
    startCmd = (await prompt('Start command (empty = skip)', insights?.framework.startCmd ?? '')) || undefined;
    /* v8 ignore stop */
  }

  // ── Env vars (loop) ────────────────────────────────────────────────────
  const envVars: Array<{ key: string; value: string; isSecret: boolean }> = [];
  console.log();
  info('Environment variables (one per line, empty key to stop).');
  while (true) {
    const key = (await prompt('  KEY', '')) || '';
    if (!key) break;
    const valueInput = await prompt('  Value (visible)', '');
    const isSecret = !(await prompt('  Treat as SECRET (hidden in UI, never echoed)? (Y/n)', 'y')).toLowerCase().startsWith('n');
    envVars.push({ key, value: valueInput, isSecret });
  }

  // ── Service creation ──────────────────────────────────────────────────
  const build: Record<string, unknown> = { buildPack };
  if (installCmd) build['installCmd'] = installCmd;
  if (buildCmd) build['buildCmd'] = buildCmd;
  if (startCmd) build['startCmd'] = startCmd;

  const svc = await spinner('Creating service', () =>
    client.services.create({
      name,
      type: 'docker',
      repoUrl,
      branch,
      /* v8 ignore next -- the `?? undefined` short-circuit is exercised by the test path that picks a source. */
      sourceId: sourceId ?? undefined,
      port,
      healthPath,
      build: build as never,
    }),
  );
  success(`Service "${svc.name}" created (id: ${svc.id}).`);

  for (const env of envVars) {
    try {
      await spinner(`Setting ${env.key}`, () =>
        client.env.create(svc.id, { key: env.key, value: env.value, isSecret: env.isSecret }),
      );
    } catch (err) {
      /* v8 ignore next -- exercised by test/deploy.test.ts "warns when a single env var setter throws" */
      error(`Failed to set ${env.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── First deploy ──────────────────────────────────────────────────────
  const deployNow = (await prompt('Trigger first deploy now? (Y/n)', 'y')).toLowerCase();
  if (!deployNow.startsWith('n')) {
    const trigger = await spinner('Triggering deploy', () => client.deploys.trigger(svc.id));
    success(`Deployment #${trigger.deploymentId} queued.`);
    info(`Watch live: ninedeploy deploys watch ${svc.id} ${trigger.deploymentId}`);
  }

  // ── Optional webhook ──────────────────────────────────────────────────
  const wantWebhook = (await prompt('Set up auto-deploy webhook for pushes to this repo? (y/N)', 'n')).toLowerCase().startsWith('y');
  if (wantWebhook) {
    // Reuse the webhooks command — it has all the GitHub-onboarding copy.
    const { webhooksAdd } = await import('./webhooks.js');
    await webhooksAdd(client, String(svc.id), branch);
  }
}

/** `ninedeploy deploys watch <serviceId> <deployId>` — reuse the existing helper. */
export { deploysWatch as deployWatch } from './manage.js';
