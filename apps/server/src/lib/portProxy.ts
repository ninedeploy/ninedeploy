import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ServicePortMapping } from '@ninedeploy/db';
import { config } from '../config.js';
import { TRAEFIK_IMAGE } from '../engine/dockerNames.js';
import { ensureDockerImage } from './dockerPull.js';
import { capture, run } from './exec.js';
import { hostPathFor } from './hostPath.js';
import { serviceBridgeName } from './serviceBridge.js';

/**
 * 0.16.1 restricted port mappings: a TCP port mapping with `allowFrom` is not
 * published by the service container. A small Traefik sidecar
 * (`nd-portproxy-<slug>`) publishes it instead, on the service's own bridge,
 * and forwards only connections from the listed addresses (`ipAllowList`).
 *
 * Docker's own `-p` goes around a host firewall such as ufw, so this is the
 * one way the panel can limit who reaches a raw TCP port. The pattern is the
 * database public-access sidecar's (lib/publicDatabaseAccess.ts): a read-only
 * config directory, every capability dropped, a fingerprint label so only a
 * changed port list recreates the container. Routes follow the service's
 * deploys through the watched dynamic file, without a restart.
 *
 * UDP is never restricted this way (Traefik's UDP routers take no
 * middlewares); the schema refuses `allowFrom` on UDP and on ranges.
 */

export const PORT_PROXY_PREFIX = 'nd-portproxy-';
export const PORT_PROXY_SERVICE_LABEL = 'ninedeploy.portproxy.service';
export const PORT_PROXY_CONFIG_LABEL = 'ninedeploy.portproxy.config';
/** First port inside the sidecar; entrypoint i listens on FIRST_INNER_PORT + i (unprivileged, every capability is dropped). */
export const FIRST_INNER_PORT = 7100;

export const portProxyName = (slug: string): string => `${PORT_PROXY_PREFIX}${slug}`;

/** `<data>/portproxy/<slug>`; the slug is re-checked so it can never leave that directory. */
export function portProxyDir(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error(`invalid service slug for a port proxy directory: ${slug}`);
  return path.join(config.paths.dataDir, 'portproxy', slug);
}

/** The mappings the sidecar carries: TCP, one port, with an allow list. */
export function restrictedMappings(mappings: readonly ServicePortMapping[] | null | undefined): ServicePortMapping[] {
  return (mappings ?? []).filter((m) => (m.allowFrom?.length ?? 0) > 0);
}

const q = (s: string) => JSON.stringify(s);

/** Static config: one entrypoint per restricted mapping, nothing else. */
export function renderPortProxyStatic(count: number): string {
  const entry = (i: number) => `  p${i}:\n    address: ":${FIRST_INNER_PORT + i}"\n`;
  return (
    '# Managed by NineDeploy — do not edit by hand.\n' +
    `entryPoints:\n${Array.from({ length: count }, (_, i) => entry(i)).join('')}` +
    'providers:\n  file:\n    directory: /etc/traefik/dynamic\n    watch: true\n' +
    'api:\n  dashboard: false\nlog:\n  level: ERROR\n'
  );
}

/** Dynamic config: per mapping a HostSNI(*) router behind an ipAllowList, to every running container of the service. */
export function renderPortProxyDynamic(mappings: readonly ServicePortMapping[], targets: readonly string[]): string {
  const lines = ['# Managed by NineDeploy — do not edit by hand.', 'tcp:', '  routers:'];
  mappings.forEach((_, i) => {
    lines.push(`    p${i}:`, `      entryPoints: [p${i}]`, '      rule: "HostSNI(`*`)"', `      service: s${i}`, `      middlewares: [a${i}]`);
  });
  lines.push('  middlewares:');
  mappings.forEach((m, i) => {
    lines.push(`    a${i}:`, '      ipAllowList:', '        sourceRange:', ...(m.allowFrom ?? []).map((e) => `          - ${q(e)}`));
  });
  lines.push('  services:');
  mappings.forEach((m, i) => {
    lines.push(`    s${i}:`, '      loadBalancer:', '        servers:', ...targets.map((t) => `          - address: ${q(`${t}:${m.containerPort}`)}`));
  });
  return `${lines.join('\n')}\n`;
}

/** The `-p` operand of mapping i: the host side as the user set it, the sidecar's entrypoint inside. */
export function portProxyPublish(m: ServicePortMapping, i: number): string {
  const ip = m.hostIp ? (m.hostIp.includes(':') ? `[${m.hostIp}]:` : `${m.hostIp}:`) : '';
  return `${ip}${m.hostPort}:${FIRST_INNER_PORT + i}/tcp`;
}

/** sha256 over everything that requires recreating the sidecar (not the routes, which are watched). */
export function portProxyFingerprint(mappings: readonly ServicePortMapping[], image: string = TRAEFIK_IMAGE): string {
  return createHash('sha256')
    .update(renderPortProxyStatic(mappings.length))
    .update(mappings.map(portProxyPublish).join('\n'))
    .update(`\n${image}`)
    .digest('hex');
}

export interface PortProxyRunSpec {
  slug: string;
  serviceId: number;
  mappings: readonly ServicePortMapping[];
  fingerprint: string;
  /** The config directory as the Docker daemon sees it (`hostPathFor`). */
  hostDir: string;
  /** `uid:gid` the sidecar runs as (the owner of its 0600 config files). */
  user?: string | null;
}

/** The `docker run` argv of the sidecar. */
export function portProxyRunArgs(spec: PortProxyRunSpec): string[] {
  return [
    'run', '-d',
    '--name', portProxyName(spec.slug),
    '--network', serviceBridgeName(spec.slug),
    '--restart', 'unless-stopped',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--cpus', '0.5',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    ...(spec.user ? ['--user', spec.user] : []),
    '--label', `${PORT_PROXY_SERVICE_LABEL}=${spec.serviceId}`,
    '--label', `${PORT_PROXY_CONFIG_LABEL}=${spec.fingerprint}`,
    ...spec.mappings.flatMap((m, i) => ['-p', portProxyPublish(m, i)]),
    '-v', `${spec.hostDir}:/etc/traefik:ro`,
    TRAEFIK_IMAGE,
  ];
}

function panelUser(): string | null {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

const readIfExists = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);

async function runningFingerprint(name: string): Promise<string | null> {
  try {
    const out = await capture('docker', ['inspect', name, '--format', `{{.State.Running}} {{ index .Config.Labels "${PORT_PROXY_CONFIG_LABEL}" }}`], { timeoutMs: 10_000 });
    const [running, fingerprint] = out.trim().split(' ');
    return running === 'true' ? (fingerprint ?? '') : '';
  } catch {
    return null;
  }
}

/** Remove the sidecar and its config directory (a service without restricted ports, or deleted). Idempotent. */
export async function removePortProxy(slug: string, log: (line: string) => void = () => undefined): Promise<void> {
  const name = portProxyName(slug);
  if ((await runningFingerprint(name)) !== null) {
    await run('docker', ['rm', '-f', name], {}, () => undefined).catch(() => undefined);
    log(`Removed port proxy ${name}`);
  }
  rmSync(portProxyDir(slug), { recursive: true, force: true });
}

/**
 * Make the sidecar match the service: routes to `targets` (the running
 * containers) for its restricted mappings, the container recreated only when
 * the port list changed. No restricted mapping: the sidecar is removed.
 */
export async function syncPortProxy(
  service: { id: number; slug: string; portMappings?: ServicePortMapping[] | null },
  targets: readonly string[],
  log: (line: string) => void,
): Promise<void> {
  const mappings = restrictedMappings(service.portMappings);
  if (mappings.length === 0) return removePortProxy(service.slug, log);
  const dir = portProxyDir(service.slug);
  const staticFile = path.join(dir, 'traefik.yml');
  const dynamicFile = path.join(dir, 'dynamic', 'routes.yml');
  const staticText = renderPortProxyStatic(mappings.length);
  const dynamicText = renderPortProxyDynamic(mappings, targets);
  if (readIfExists(staticFile) !== staticText) writeAtomic(staticFile, staticText);
  if (readIfExists(dynamicFile) !== dynamicText) writeAtomic(dynamicFile, dynamicText);

  const fingerprint = portProxyFingerprint(mappings);
  const name = portProxyName(service.slug);
  if ((await runningFingerprint(name)) === fingerprint) return;
  await ensureDockerImage(TRAEFIK_IMAGE, log);
  await run('docker', ['rm', '-f', name], {}, () => undefined).catch(() => undefined);
  await run(
    'docker',
    portProxyRunArgs({ slug: service.slug, serviceId: service.id, mappings, fingerprint, hostDir: await hostPathFor(dir), user: panelUser() }),
    {},
    log,
  );
  log(`Port proxy ${name} publishes ${mappings.map((m) => `${m.hostIp ? `${m.hostIp}:` : ''}${m.hostPort}/tcp`).join(', ')} for the allowed addresses only`);
}
