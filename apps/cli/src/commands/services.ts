import { NineDeployError } from '@ninedeploy/sdk';
import { formatPortMapping, type PortMapping, parsePortMapping, portMappingsProblem } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, fmtTime, header, info, kv, spinner, statusColor, success, table } from '../lib/format.js';
import { prompt } from '../prompts.js';

/** `ninedeploy services list` */
export async function servicesList(client: NineDeployClient): Promise<void> {
  header('Services');
  await spinner('Fetching services', async () => {
    const services = await client.services.list();
    if (services.length === 0) { info('No services yet. Run `ninedeploy services create`.'); return; }
    table(
      services.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        status: s.status,
        port: s.port ?? '—',
        updated: fmtTime(s.updatedAt),
      })),
      ['id', 'name', 'type', 'status', 'port', 'updated'],
    );
  });
}

/** `ninedeploy services create` — interactive wizard */
export async function servicesCreate(client: NineDeployClient): Promise<void> {
  header('Create Service');
  console.log(c.dim('  Answer a few questions to deploy your app.\n'));

  const name = await prompt('Service name');
  if (!name) return error('Name is required');

  const mode = await prompt('Deploy from (1) Git repo  (2) Docker image', '1');
  const useRepo = mode !== '2';

  let repoUrl = '';
  let image = '';
  let branch = 'main';
  if (useRepo) {
    repoUrl = await prompt('Repository URL', '');
    if (!repoUrl) return error('Repository URL is required');
    branch = await prompt('Branch', 'main');
  } else {
    image = await prompt('Docker image (e.g. nginx:alpine)');
    if (!image) return error('Image is required');
  }

  const portStr = await prompt('Port (optional)', '');
  const port = portStr ? Number(portStr) : undefined;
  const pubPortStr = await prompt('Direct host port (optional)', '');
  const publishedPort = pubPortStr ? Number(pubPortStr) : undefined;
  const volume = await prompt('Persistent volume path (optional)', '');

  console.log();
  try {
    const svc = await spinner('Creating service', () =>
      client.services.create({
        name, type: 'docker',
        repoUrl: useRepo ? repoUrl : undefined,
        image: useRepo ? undefined : image,
        branch, port, publishedPort, volumeMount: volume || undefined,
      }),
    );
    success(`Service "${svc.name}" created (id: ${svc.id})`);

    const deployNow = await prompt('Deploy now? (y/n)', 'y');
    if (deployNow.toLowerCase().startsWith('y')) {
      const res = await spinner('Deploying', () => client.deploys.trigger(svc.id));
      success(`Deployment #${res.deploymentId} queued. Check logs: ninedeploy services logs ${svc.id}`);
    }
  } catch (err) {
    error(err instanceof NineDeployError ? err.message : String(err));
  }
}

/** `ninedeploy services get <id>` */
export async function servicesGet(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!id) return error('Usage: ninedeploy services get <id>');
  header('Service Details');
  await spinner('Fetching', async () => {
    const svc = await client.services.get(id);
    kv('ID', svc.id);
    kv('Name', svc.name);
    kv('Slug', svc.slug);
    kv('Type', svc.type);
    kv('Status', statusColor(svc.status));
    kv('Repo', svc.repoUrl ?? '—');
    kv('Branch', svc.branch);
    kv('Image', svc.image ?? '—');
    kv('Port', svc.port ?? '—');
    if (svc.publishedPort) kv('Host Port', c.green(`:${svc.publishedPort}`));
    if (svc.portMappings?.length) kv('Port Mappings', c.green(svc.portMappings.map(formatPortMapping).join(', ')));
    kv('Volume', svc.volumeMount ?? '—');
    kv('Health', svc.healthCheck === 'running' ? 'container running (no port probe)' : svc.healthPath);
    kv('Runtime', svc.runtimeId ?? '—');
    kv('Commit', svc.commitSha ?? '—');
    if (svc.autoUrl) kv('URL', c.cyan(`http://${svc.autoUrl}`));
    kv('Created', fmtTime(svc.createdAt));
    kv('Updated', fmtTime(svc.updatedAt));
  });
}

/** `ninedeploy services deploy <id>` */
export async function servicesDeploy(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!id) return error('Usage: ninedeploy services deploy <id>');
  try {
    const res = await spinner('Triggering deploy', () => client.deploys.trigger(id));
    success(`Deployment #${res.deploymentId} queued.`);
    info(`Watch logs: ninedeploy services logs ${id}`);
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/**
 * `ninedeploy services logs <id> [--tail N] [--grep text]`: the newest N lines
 * (default 50, at most 5000), optionally only those containing `text`
 * (case-insensitive). 0.16.3: it used to print the OLDEST 50 of 300.
 */
export async function servicesLogs(client: NineDeployClient, idStr: string, opts: { tail?: string; grep?: string } = {}): Promise<void> {
  const id = Number(idStr);
  if (!id) return error('Usage: ninedeploy services logs <id> [--tail N] [--grep text]');
  const tail = opts.tail === undefined ? 50 : Number(opts.tail);
  if (!Number.isInteger(tail) || tail < 1 || tail > 5000) return error('--tail takes a number of lines from 1 to 5000');
  header('Runtime Logs');
  try {
    const { lines } = await client.services.logs(id, { tail });
    const needle = opts.grep?.toLowerCase();
    // An older panel ignores `tail` and sends 300 lines: keep the newest.
    const shown = lines.split('\n').filter((l) => l.trim() && (!needle || l.toLowerCase().includes(needle))).slice(-tail);
    if (shown.length === 0) { info(needle ? `No line contains "${opts.grep}".` : 'No logs yet.'); return; }
    console.log(shown.map((l) => `  ${c.dim(l)}`).join('\n'));
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy services stop|start|restart <id>` */
export async function servicesLifecycle(client: NineDeployClient, action: 'stop' | 'start' | 'restart', idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!id) return error(`Usage: ninedeploy services ${action} <id>`);
  try {
    await spinner(`${action}ing service`, () => client.services[action](id));
    success(`Service ${action}ed.`);
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy services delete <id>` */
export async function servicesDelete(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!id) return error('Usage: ninedeploy services delete <id>');
  const confirmText = await prompt(`Type the service ID (${id}) to confirm deletion`);
  if (confirmText !== String(id)) return error('Cancelled.');
  try {
    await spinner('Deleting service', () => client.services.remove(id));
    success('Service deleted.');
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** Pure entry point for `ninedeploy services sticky <id> --enable|--disable` (G-28). */
export async function servicesSticky(
  client: NineDeployClient,
  idStr: string,
  opts: { enable?: boolean; disable?: boolean } = {},
): Promise<{ id: number; enabled: boolean; active: boolean }> {
  const id = Number(idStr);
  if (!id) throw new Error('Usage: ninedeploy services sticky <id> --enable|--disable');
  if (opts.enable === undefined && opts.disable === undefined) {
    throw new Error('Specify either --enable or --disable');
  }
  if (opts.enable && opts.disable) {
    throw new Error('Specify only one of --enable or --disable');
  }
  return await client.domains.setStickySession(id, Boolean(opts.enable));
}

/** Formatted wrapper for the CLI. */
export async function servicesStickyAction(
  client: NineDeployClient,
  idStr: string,
  opts: { enable?: boolean; disable?: boolean } = {},
): Promise<void> {
  header('Sticky session');
  let result: Awaited<ReturnType<typeof servicesSticky>>;
  try {
    result = await servicesSticky(client, idStr, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  success(result.enabled
    ? `Sticky session enabled for service #${result.id} (Traefik will pick this up on the next reload)`
    : `Sticky session disabled for service #${result.id}`);
}

/**
 * Pure entry point for `ninedeploy services ports <id> [mappings...]` (0.16.1):
 * no mappings lists them; mappings replace the list; `--clear` removes them.
 * Each mapping is `[ip:]host[-end][:container][/tcp|udp][@allowed,ranges]`.
 */
export async function servicesPorts(
  client: NineDeployClient,
  idStr: string,
  specs: string[] = [],
  opts: { clear?: boolean } = {},
): Promise<{ id: number; mappings: PortMapping[]; changed: boolean }> {
  const id = Number(idStr);
  if (!id) throw new Error('Usage: ninedeploy services ports <id> [mapping...] [--clear]');
  if (opts.clear && specs.length > 0) throw new Error('Give mappings or --clear, not both');
  if (!opts.clear && specs.length === 0) {
    const svc = await client.services.get(id);
    return { id, mappings: svc.portMappings ?? [], changed: false };
  }
  const mappings: PortMapping[] = [];
  for (const spec of specs) {
    const parsed = parsePortMapping(spec);
    if (typeof parsed === 'string') throw new Error(parsed);
    mappings.push(parsed);
  }
  const problem = portMappingsProblem(mappings);
  if (problem) throw new Error(problem);
  const svc = await client.services.update(id, { portMappings: opts.clear ? null : mappings });
  return { id, mappings: svc.portMappings ?? [], changed: true };
}

/** Formatted wrapper for the CLI. */
export async function servicesPortsAction(client: NineDeployClient, idStr: string, specs: string[] = [], opts: { clear?: boolean } = {}): Promise<void> {
  header('Port mappings');
  let result: Awaited<ReturnType<typeof servicesPorts>>;
  try {
    result = await servicesPorts(client, idStr, specs, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.mappings.length === 0) info(result.changed ? `Port mappings removed from service #${result.id}.` : `Service #${result.id} publishes no extra ports.`);
  for (const m of result.mappings) {
    kv(formatPortMapping(m), `${m.hostIp ? `on ${m.hostIp}` : 'on every address'}${m.allowFrom?.length ? `, only from ${m.allowFrom.join(', ')}` : ''}`);
  }
  if (result.changed) success('Saved. Redeploy the service to apply.');
}

/**
 * Pure entry point for `ninedeploy services deploy-hook <id> [--enable|--disable]`:
 * no flag shows the hook; --enable turns it on (or rotates its URL); --disable turns it off.
 */
export async function servicesDeployHook(
  client: NineDeployClient,
  idStr: string,
  opts: { enable?: boolean; disable?: boolean } = {},
): Promise<{ enabled: boolean; url: string | null; mine: boolean; changed: boolean }> {
  const id = Number(idStr);
  if (!id) throw new Error('Usage: ninedeploy services deploy-hook <id> [--enable|--disable]');
  if (opts.enable && opts.disable) throw new Error('Specify only one of --enable or --disable');
  if (opts.enable) return { ...(await client.services.deployHook.enable(id)), changed: true };
  if (opts.disable) return { ...(await client.services.deployHook.disable(id)), changed: true };
  return { ...(await client.services.deployHook.get(id)), changed: false };
}

/** Formatted wrapper for the CLI. */
export async function servicesDeployHookAction(client: NineDeployClient, idStr: string, opts: { enable?: boolean; disable?: boolean } = {}): Promise<void> {
  header('Deploy hook');
  let result: Awaited<ReturnType<typeof servicesDeployHook>>;
  try {
    result = await servicesDeployHook(client, idStr, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (!result.enabled) {
    info(result.changed ? 'Deploy hook off.' : 'No deploy hook. Turn one on with --enable.');
    return;
  }
  if (!result.url) {
    // Only the member a hook deploys as sees its URL.
    info('A deploy hook is on, made by another member. --enable gives you a new URL that deploys as you (the old one stops working).');
    return;
  }
  if (result.changed) success('Deploy hook on. Treat the URL like a password; --enable again gives a new one.');
  info(`curl -fsS -X POST ${result.url}`);
}

/** `ninedeploy services export <id>` */
export async function servicesExport(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!id) return error('Usage: ninedeploy services export <id>');
  const { writeFileSync } = await import('node:fs');
  const { authedFetch } = await import('../client.js');
  try {
    const svc = await client.services.get(id);
    const data = await spinner('Exporting', () =>
      (async () => {
        // r550: refresh-aware and base-path preserving (was a bare fetch).
        const res = await authedFetch(`/v1/services/${id}/export`);
        if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
        return res.text();
      })(),
    );
    const filename = `${svc.slug}-export.json`;
    writeFileSync(filename, data);
    success(`Exported to ${filename}`);
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy services compose <id>` */
export async function servicesCompose(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!id) return error('Usage: ninedeploy services compose <id>');
  header('Runtime Docker Compose Manifest');
  try {
    const svc = await client.services.get(id);
    const container = svc.runtimeId || `nd-svc-${svc.slug}-1`;
    const res = await spinner('Generating manifest', () => client.containers.compose(container));
    console.log(c.dim(`\n  # Container: ${container}\n`));
    console.log(res.yaml.split('\n').map((l) => `  ${c.cyan(l)}`).join('\n'));
    console.log();
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy services inspect <id>` */
export async function servicesInspect(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!id) return error('Usage: ninedeploy services inspect <id>');
  header('Container Runtime Inspection');
  try {
    const svc = await client.services.get(id);
    const container = svc.runtimeId || `nd-svc-${svc.slug}-1`;
    const data = await spinner('Inspecting container', () => client.containers.inspect(container));
    kv('Container ID', data.id);
    kv('Name', data.name);
    kv('Image', data.image);
    kv('Status', statusColor(data.state.status));
    kv('Running', data.state.running ? c.green('true') : c.red('false'));
    if (data.resources.memoryLimitBytes > 0) kv('Memory Limit', `${Math.round(data.resources.memoryLimitBytes / (1024 * 1024))} MB`);
    if (data.resources.cpuShares > 0) kv('CPU Shares', `${data.resources.cpuShares}`);
    kv('Restart Policy', data.resources.restartPolicy);

    if (Object.keys(data.traefikTags).length > 0) {
      console.log(c.dim('\n  Traefik Dynamic Ingress Tags:'));
      for (const [k, v] of Object.entries(data.traefikTags)) {
        console.log(`    ${c.yellow(k)}: ${c.dim(v)}`);
      }
    }
    console.log();
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}
