import { z } from 'zod';
import { autoscaleConfig } from './autoscale.js';

/** 0.16.11 scale to zero: the bounds of `sleepAfterMinutes`. */
export const SLEEP_AFTER_MIN = 5;
export const SLEEP_AFTER_MAX = 1440;
import { canaryConfig } from './canary.js';
import { dockerLabels } from './dockerLabels.js';
import { containerPath, dockerVolumeName, envVarName, gitBranch, gitRepoUrl, httpPath, providerBaseUrl, repoBaseDir, repoRelativePath, slug } from './common.js';

export const serviceType = z.enum(['pm2', 'docker', 'compose']);
export const serviceOrchestrator = z.enum(['container', 'swarm']);
/** G4.4 added paketo and heroku (Cloud Native Buildpacks, panel host only). */
export const buildPack = z.enum(['auto', 'nixpacks', 'dockerfile', 'railpack', 'static', 'paketo', 'heroku']);

/**
 * 0.16.1: names of the service's environment variables a Dockerfile build
 * receives as `--build-arg` (the Dockerfile reads them with `ARG`). Opt-in per
 * name: a build gets none unless listed. Nixpacks and Railpack builds already
 * see the whole environment.
 */
export const buildArgNames = z.array(envVarName.max(100)).max(100);

/** 0.16.3: the most runtime-log lines one read returns (search and download in the panel). */
export const RUNTIME_LOG_TAIL_MAX = 5000;
/** The runtime-log lines a read returns when none are asked for, as before 0.16.3. */
export const RUNTIME_LOG_TAIL_DEFAULT = 300;

/**
 * 0.16.3 `GET /v1/services/:id/logs?tail=N`. Query params arrive as strings:
 * an unusable `tail` reads as the default, and any number is clamped to
 * 1..RUNTIME_LOG_TAIL_MAX.
 */
export const runtimeLogsQuery = z.object({
  tail: z
    .unknown()
    .optional()
    .transform((v) => Math.min(Math.max(Math.trunc(Number(v ?? RUNTIME_LOG_TAIL_DEFAULT)) || RUNTIME_LOG_TAIL_DEFAULT, 1), RUNTIME_LOG_TAIL_MAX)),
});

/**
 * 0.16.2: the stage of a multi-stage Dockerfile to build (`docker build
 * --target`), e.g. `runtime` or `prod`. Docker's own stage-name rule: a letter
 * first, then letters, digits, `_`, `.` or `-` (so it can never read as a flag).
 */
export const dockerBuildTarget = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/, 'A stage name starts with a letter and holds letters, digits, _ . or -');

/**
 * 0.16.1: capabilities a docker service may add. Deliberately short: the ones
 * real workloads ask for (VPNs, packet capture, profilers, realtime audio,
 * mlock). SYS_ADMIN, SYS_MODULE, DAC_READ_SEARCH and the like are left out —
 * each is a known path out of the container.
 */
export const runtimeCapability = z.enum(['NET_ADMIN', 'NET_RAW', 'SYS_PTRACE', 'SYS_NICE', 'SYS_RESOURCE', 'IPC_LOCK', 'SYS_TIME']);

/**
 * 0.16.1 advanced container options for docker services (operator only):
 * structured fields, never free-form `docker run` flags, so nothing outside
 * this list (privileged, host mounts, host network…) can be asked for.
 */
export const runtimeOptions = z
  .object({
    /** `--gpus all` or `--gpus <n>` (needs the NVIDIA container toolkit on the host). */
    gpus: z.union([z.literal('all'), z.number().int().min(1).max(16)]).nullable().optional(),
    /** `--shm-size` in MiB; browsers and PyTorch data loaders outgrow Docker's 64. */
    shmSizeMb: z.number().int().min(1).max(65_536).nullable().optional(),
    /** `--init`: reaps zombie processes and forwards signals to the app. */
    init: z.boolean().optional(),
    /** `--ulimit nofile=N:N`. */
    ulimitNofile: z.number().int().min(1024).max(1_048_576).nullable().optional(),
    /** `--cap-add`. */
    capAdd: z.array(runtimeCapability).max(7).optional(),
  })
  .strict();
export type RuntimeOptions = z.infer<typeof runtimeOptions>;

/**
 * 0.16.1: the most host ports one service may publish through `portMappings`.
 * Docker starts one userland proxy process per published port and protocol,
 * so a 10 000-port range costs 10 000 processes on the host.
 */
export const MAX_MAPPED_PORTS = 1000;
/** Most port-mapping rules per service. */
export const MAX_PORT_MAPPINGS = 20;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * A literal IPv4 or IPv6 address a port can be bound to (no zone, no CIDR).
 * The unspecified addresses are refused: an empty IP already means "every
 * address", and two spellings of it would dodge the overlap check.
 */
export function isBindableIp(ip: string): boolean {
  if (IPV4.test(ip)) return ip !== '0.0.0.0';
  if (ip.length > 45) return false;
  const halves = ip.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === '' ? [] : h.split(':')));
  let width = groups.length;
  if (groups.length > 0 && IPV4.test(groups[groups.length - 1]!)) {
    groups.pop();
    width += 1; // an embedded IPv4 fills two groups
  }
  if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  if (halves.length === 2 ? width > 7 : width !== 8) return false;
  // `::`, `0::0`, `0:0:0:0:0:0:0:0`: the unspecified address.
  return width !== groups.length || groups.some((g) => Number.parseInt(g, 16) !== 0);
}

/**
 * 0.16.1 extra host-port mappings of a docker service: one port or a range,
 * TCP or UDP, on every host address or one dedicated IP
 * (`docker run -p 203.0.113.7:27015-27030:27015-27030/udp`). The container
 * range starts at `containerPort` and is as long as the host range.
 */
export const portMapping = z
  .object({
    /** Host address to bind; null or omitted = every address of the host. */
    hostIp: z
      .string()
      .max(45)
      .refine(isBindableIp, 'hostIp must be one IPv4 or IPv6 address of the host (leave it empty for every address)')
      .nullable()
      .optional(),
    hostPort: z.number().int().min(1).max(65535),
    /** Last host port of a range; null or omitted = the single `hostPort`. */
    hostPortEnd: z.number().int().min(1).max(65535).nullable().optional(),
    containerPort: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    /**
     * TCP, one port: only these addresses or CIDR ranges may connect. The port
     * is then published by a small Traefik proxy in front of the service
     * instead of Docker's `-p`, which a host firewall cannot restrict.
     */
    allowFrom: z.array(z.string().trim().min(1).max(64)).min(1).max(100).nullable().optional(),
  })
  .strict();
export type PortMapping = z.infer<typeof portMapping>;
type PortMappingLike = Pick<PortMapping, 'hostPort' | 'hostPortEnd' | 'containerPort'> & {
  hostIp?: string | null;
  protocol?: 'tcp' | 'udp';
  allowFrom?: readonly string[] | null;
};

/** How many host ports a mapping publishes. */
export const mappedPortCount = (m: Pick<PortMapping, 'hostPort' | 'hostPortEnd'>): number =>
  Math.max(1, (m.hostPortEnd ?? m.hostPort) - m.hostPort + 1);

/**
 * Whether two mappings would bind the same host socket: same protocol,
 * overlapping ports, and the same IP (or either on every address).
 */
export function portMappingsOverlap(a: PortMappingLike, b: PortMappingLike): boolean {
  if ((a.protocol ?? 'tcp') !== (b.protocol ?? 'tcp')) return false;
  if (a.hostIp && b.hostIp && a.hostIp.toLowerCase() !== b.hostIp.toLowerCase()) return false;
  return a.hostPort <= (b.hostPortEnd ?? b.hostPort) && b.hostPort <= (a.hostPortEnd ?? a.hostPort);
}

/** Why a list of mappings cannot be published, or null. Shared by the server, the panel and the CLI. */
export function portMappingsProblem(list: readonly PortMappingLike[]): string | null {
  let total = 0;
  for (const [i, m] of list.entries()) {
    const end = m.hostPortEnd ?? m.hostPort;
    const label = formatPortMapping(m);
    if (end < m.hostPort) return `Mapping ${i + 1} (${label}): the range ends before it starts.`;
    if (m.containerPort + (end - m.hostPort) > 65535) return `Mapping ${i + 1} (${label}): the container range runs past 65535.`;
    total += end - m.hostPort + 1;
    if (m.allowFrom?.length && ((m.protocol ?? 'tcp') !== 'tcp' || end !== m.hostPort)) {
      return `Mapping ${i + 1} (${label}): an allow list works on one TCP port (UDP and ranges cannot be filtered by source).`;
    }
    const other = list.slice(0, i).find((o) => portMappingsOverlap(o, m));
    if (other) {
      return `Mapping ${i + 1} (${label}) overlaps ${formatPortMapping(other)}: a host port can be published once per address and protocol.`;
    }
  }
  if (total > MAX_MAPPED_PORTS) {
    return `${total} host ports requested; at most ${MAX_MAPPED_PORTS} per service (Docker runs one proxy process per published port).`;
  }
  return null;
}

/** The `docker run -p` operand: `27015-27030:27015-27030/udp`, `203.0.113.7:53:53/udp`, `[2001:db8::7]:53:53/udp`. */
export function formatPortMapping(m: PortMappingLike): string {
  const span = (m.hostPortEnd ?? m.hostPort) - m.hostPort;
  const range = (start: number) => (span > 0 ? `${start}-${start + span}` : String(start));
  const ip = m.hostIp ? (m.hostIp.includes(':') ? `[${m.hostIp}]:` : `${m.hostIp}:`) : '';
  return `${ip}${range(m.hostPort)}:${range(m.containerPort)}/${m.protocol ?? 'tcp'}`;
}

/**
 * Parse `27015-27030:27015/udp`, `8080:80`, `5432@10.0.0.0/8`, `53/udp`, `10000-10100/udp`
 * (no colon = the same ports inside the container), optionally after an IP:
 * `203.0.113.7:53/udp`, `[2001:db8::7]:8080:80`. A container range must be as
 * long as the host range. Returns the mapping, or why the text is not one.
 */
export function parsePortMapping(text: string): PortMapping | string {
  // `…@10.0.0.0/8,203.0.113.4`: the allow list of a TCP port.
  const parts = text.trim().split('@');
  const t = parts[0]!;
  const allowText = parts[1];
  if (parts.length > 2) return `"${text.trim()}" has more than one @.`;
  const allowFrom = allowText === undefined ? null : allowText.split(',').map((e) => e.trim()).filter(Boolean);
  if (allowFrom && allowFrom.length === 0) return `"${text.trim()}": list the addresses after @ (10.0.0.0/8,203.0.113.4).`;
  const m = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:.]+)\]):(\d{1,5})(?:-(\d{1,5}))?(?::(\d{1,5})(?:-(\d{1,5}))?)?(?:\/(tcp|udp))?$/i.exec(t)
    ?? /^()()(\d{1,5})(?:-(\d{1,5}))?(?::(\d{1,5})(?:-(\d{1,5}))?)?(?:\/(tcp|udp))?$/i.exec(t);
  if (!m) return `"${t}" is not a port mapping (examples: 8080:80, 27015-27030:27015/udp, 203.0.113.7:53/udp).`;
  const hostIp = m[1] || m[2] || null;
  if (hostIp && !isBindableIp(hostIp)) return `"${t}": ${hostIp} is not an address a port can be bound to.`;
  const hostPort = Number(m[3]);
  const hostPortEnd = m[4] ? Number(m[4]) : null;
  const containerPort = m[5] ? Number(m[5]) : hostPort;
  const ports = [hostPort, hostPortEnd ?? hostPort, containerPort];
  if (ports.some((p) => p < 1 || p > 65535)) return `"${t}": ports run from 1 to 65535.`;
  if (hostPortEnd !== null && hostPortEnd < hostPort) return `"${t}": the range ends before it starts.`;
  if (m[6] && Number(m[6]) - containerPort !== (hostPortEnd ?? hostPort) - hostPort) {
    return `"${t}": the container range must be as long as the host range.`;
  }
  return {
    hostIp,
    hostPort,
    hostPortEnd: hostPortEnd !== null && hostPortEnd !== hostPort ? hostPortEnd : null,
    containerPort,
    protocol: (m[7]?.toLowerCase() ?? 'tcp') as 'tcp' | 'udp',
    ...(allowFrom ? { allowFrom } : {}),
  };
}

/** The PATCH field: rules checked together (ranges, overlaps, the port budget). */
export const portMappings = z
  .array(portMapping)
  .max(MAX_PORT_MAPPINGS)
  .superRefine((list, ctx) => {
    const problem = portMappingsProblem(list);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/**
 * 0.16.1 deploy healthcheck: `http` probes the container port (an HTTP answer
 * below 500, then a TCP connect); `running` only waits for the container to
 * stay up, for services with no HTTP or TCP port to probe (UDP game servers,
 * VoIP, queue workers). 0.16.3 `command`: a shell command run inside the
 * container (`sh -c`) must exit 0, e.g. `pg_isready` or `curl -f localhost/up`.
 */
export const healthCheckMode = z.enum(['http', 'running', 'command', 'http-strict', 'tcp']);
export type HealthCheckMode = z.infer<typeof healthCheckMode>;

/** 0.16.3: the `command` healthcheck's shell command (one line). */
export const healthCommand = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((v) => !/[\r\n\0]/.test(v), 'must be a single line');

/** Optional project/workspace/label tag IDs for new service creation. */
const tagIds = z.array(z.number().int().positive()).optional();

export const createService = z.object({
  /** Bundled/remote Hub template ID. The server resolves privileged template
   * settings (cmd, Docker socket and database env mapping) from the trusted
   * registry; clients cannot submit those settings directly. */
  templateId: z.string().min(1).max(100).optional(),
  /**
   * Project / workspace / label tagging (N-N). `tagProjectIds` replaces the
   * removed `projectId` field. `tagWorkspaceIds` defaults to all workspaces
   * the caller belongs to when omitted (so a freshly-created service is
   * visible from the operator's workspaces). `tagLabelIds` is optional.
   */
  tagProjectIds: tagIds,
  tagWorkspaceIds: tagIds,
  tagLabelIds: tagIds,
  name: z.string().min(1).max(100),
  slug: slug.optional(), // derived from name if omitted
  /** Resume an idle, caller-owned service left by an interrupted Hub deploy. */
  reuseExisting: z.boolean().optional(),
  type: serviceType.default('docker'),
  repoUrl: gitRepoUrl.optional(),
  branch: gitBranch.default('main'),
  sourceId: z.number().int().positive().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  image: z.string().optional(),
  volumeMount: z.string().optional(),
  /** Compose deploys: the main service in the compose file (health/routing
   * target). Defaults to the service slug when omitted — or, for an inline
   * `composeContent` stack, to the main service the server derives from the
   * YAML itself. */
  composeService: z.string().min(1).max(200).optional(),
  /** Inline Docker Compose stack: the whole YAML, pasted instead of cloned.
   * The server stores it on the service row and re-materialises it into the
   * workspace before every deploy, so there is no repository to check out.
   * Same 256 KiB cap as a Hub template's `composeContent`. */
  composeContent: z.string().min(1).max(262_144).optional(),
  cpuShares: z.number().int().min(0).max(262144).optional(),
  /** Hard CPU cap in millicores (500 = 0.5 cores); maps to docker --cpus. */
  cpuLimitMilli: z.number().int().min(0).max(512_000).optional(),
  memLimitMb: z.number().int().min(0).optional(),
  /** Horizontal replica count for docker services (Traefik load-balances). */
  replicas: z.number().int().min(1).max(10).optional(),
  healthPath: httpPath.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
  previewDeploymentsEnabled: z.boolean().optional(),
  previewAutoDestroyOnClose: z.boolean().optional(),
  /** 0.16.12: each PR preview gets its own copy of the attached databases (postgres and the redis family on the panel host). */
  previewDatabaseCopy: z.boolean().optional(),
  /** 0.16.14: build previews of PRs from forks too; each of their deploys waits for approval, and they clone with no credential. */
  previewForks: z.boolean().optional(),
  previewDomainPattern: z.string().nullable().optional(),
  previewMaxActive: z.number().int().min(1).max(50).optional(),
  /** Deployment lane at create time (production / staging / …). */
  environmentId: z.number().int().positive().optional(),
  build: z
    .object({
      buildPack: buildPack.default('auto'),
      baseDir: repoBaseDir.default('/'),
      installCmd: z.string().optional(),
      buildCmd: z.string().optional(),
      startCmd: z.string().optional(),
      dockerfilePath: repoRelativePath.optional(),
      /** Static build pack: build output dir (relative to baseDir). */
      outputDir: repoRelativePath.optional(),
      preDeployCmd: z.string().nullable().optional(),
      postDeployCmd: z.string().nullable().optional(),
      preStopCmd: z.string().nullable().optional(),
      // docker --restart policy: fixed values plus on-failure:N (restart-loop cap).
      restartPolicy: z.string().regex(/^(no|always|unless-stopped|on-failure(?::\d{1,3})?)$/).optional(),
      // Seconds between SIGTERM and SIGKILL on stop (docker stop -t).
      stopGraceSeconds: z.number().int().min(0).max(300).optional(),
      /** Env-var names passed to a Dockerfile build as `--build-arg`. */
      buildArgs: buildArgNames.optional(),
      /** Stage of a multi-stage Dockerfile to build (`--target`); absent = the last stage. */
      buildTarget: dockerBuildTarget.optional(),
    })
    .default({ buildPack: 'auto', baseDir: '/' }),
}).superRefine((value, ctx) => {
  if (!value.composeContent) return;
  // An inline stack IS a compose deploy — every other type ignores the field
  // entirely, so accepting it would store YAML that never runs.
  if (value.type !== 'compose') {
    ctx.addIssue({
      code: 'custom',
      path: ['composeContent'],
      message: "composeContent requires type 'compose'",
    });
  }
  // A repository would be cloned into the same workspace the YAML is written
  // to, and the first clone wipes that directory (lib/git.ts) — the pasted
  // stack would silently disappear. One source of truth or the other.
  if (value.repoUrl) {
    ctx.addIssue({
      code: 'custom',
      path: ['repoUrl'],
      message: 'composeContent and repoUrl are mutually exclusive — a git checkout would overwrite the pasted stack',
    });
  }
});
export type CreateService = z.infer<typeof createService>;

/** PATCH shape — every field optional, including individual build-config keys.
 * Built explicitly (NOT via createService.partial()): in Zod v4 `partial()`
 * still applies `.default()` values for absent keys, which would silently
 * rewrite `type` back to 'docker' and `branch` to 'main' on every PATCH. */
export const updateService = z.object({
  // r335: no tag fields. Tags change only through `PUT /v1/services/:id/tags`
  // (admin-gated, with the r156 foreign-link rules). The PATCH route used to
  // accept tagProjectIds/tagWorkspaceIds/tagLabelIds here and then silently
  // drop them; it now answers 400 `tags_via_put` when a body carries them.
  name: z.string().min(1).max(100).optional(),
  slug: slug.optional(),
  type: serviceType.optional(),
  repoUrl: gitRepoUrl.optional(),
  branch: gitBranch.optional(),
  /** Attached Git credential (source) for private-repo cloning. null clears it. */
  sourceId: z.number().int().positive().nullable().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  image: z.string().optional(),
  volumeMount: z.string().optional(),
  composeService: z.string().min(1).max(200).optional(),
  /** Watchtower-style image auto-update. Only meaningful on image-based
   * docker services — the route refuses it otherwise. */
  autoUpdate: z.boolean().optional(),
  /** Replace an inline stack's YAML. Only meaningful on a service that
   * already stores one — the route refuses it otherwise, because `type`
   * alone cannot tell an inline stack from a git-repo compose service. */
  composeContent: z.string().min(1).max(262_144).optional(),
  cpuShares: z.number().int().min(0).max(262144).optional(),
  /** Hard CPU cap in millicores (500 = 0.5 cores); maps to docker --cpus. */
  cpuLimitMilli: z.number().int().min(0).max(512_000).optional(),
  memLimitMb: z.number().int().min(0).optional(),
  /** Horizontal replica count for docker services (Traefik load-balances). */
  replicas: z.number().int().min(1).max(10).optional(),
  healthPath: httpPath.optional(),
  /** Seconds a deploy waits for the healthcheck (10–3600); null restores the 300 s default. */
  healthTimeoutSeconds: z.number().int().min(10).max(3600).nullable().optional(),
  /** 'running' = the deploy only waits for the container to stay up (UDP and other non-HTTP services); 'http' or null = the HTTP/TCP probe. */
  healthCheck: healthCheckMode.nullable().optional(),
  /** 0.16.3: the command of the 'command' healthcheck; null clears it. */
  healthCommand: healthCommand.nullable().optional(),
  /** 0.16.3: custom container labels; {} or null clears them. */
  dockerLabels: dockerLabels.nullable().optional(),
  /** 0.16.3: fetch Git LFS files after checkout (builds on the panel host; 0.16.5: a node service with no placement builds there too). */
  gitLfs: z.boolean().optional(),
  /** Operator only: advanced container options; null clears them all. */
  runtimeOptions: runtimeOptions.nullable().optional(),
  /** 0.16.9: release new versions as a canary (docker services on the panel host); null turns it off. */
  canary: canaryConfig.nullable().optional(),
  /** 0.16.10: scale between min and max replicas on a metric (docker services on the panel host); null turns it off. */
  autoscale: autoscaleConfig.nullable().optional(),
  /** 0.16.11: stop the service after this many minutes without a request, wake it on the next one (5–1440); null turns it off. */
  sleepAfterMinutes: z.number().int().min(SLEEP_AFTER_MIN).max(SLEEP_AFTER_MAX).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
  /** Extra host ports, TCP or UDP, single or ranges (docker services on the panel host); null or [] clears them. */
  portMappings: portMappings.nullable().optional(),
  previewDeploymentsEnabled: z.boolean().optional(),
  previewAutoDestroyOnClose: z.boolean().optional(),
  /** 0.16.12: each PR preview gets its own copy of the attached databases (postgres and the redis family on the panel host). */
  previewDatabaseCopy: z.boolean().optional(),
  /** 0.16.14: build previews of PRs from forks too; each of their deploys waits for approval, and they clone with no credential. */
  previewForks: z.boolean().optional(),
  previewDomainPattern: z.string().nullable().optional(),
  previewMaxActive: z.number().int().min(1).max(50).optional(),
  /** Deployment lane (production / staging / …). null clears the assignment. */
  environmentId: z.number().int().positive().nullable().optional(),
  build: z
    .object({
      buildPack: buildPack.optional(),
      baseDir: repoBaseDir.optional(),
      installCmd: z.string().optional(),
      buildCmd: z.string().optional(),
      startCmd: z.string().optional(),
      dockerfilePath: repoRelativePath.optional(),
      /** Static build pack: build output dir, relative to baseDir. */
      outputDir: repoRelativePath.optional(),
      /** Static build pack: SPA history fallback in the generated nginx conf. */
      staticSpa: z.boolean().optional(),
      preDeployCmd: z.string().nullable().optional(),
      postDeployCmd: z.string().nullable().optional(),
      preStopCmd: z.string().nullable().optional(),
      restartPolicy: z.string().regex(/^(no|always|unless-stopped|on-failure(?::\d{1,3})?)$/).optional(),
      stopGraceSeconds: z.number().int().min(0).max(300).optional(),
      /** Env-var names passed to a Dockerfile build as `--build-arg`; [] clears. */
      buildArgs: buildArgNames.optional(),
      /** Stage of a multi-stage Dockerfile to build (`--target`); '' or null clears. */
      buildTarget: z.union([dockerBuildTarget, z.literal('')]).nullable().optional(),
    })
    .optional(),
});
export type UpdateService = z.infer<typeof updateService>;

/** Input shapes (what a client sends) — defaults make `build` optional. */
export type CreateServiceInput = z.input<typeof createService>;
export type UpdateServiceInput = z.input<typeof updateService>;

export const service = z.object({
  id: z.number().int(),
  /**
   * Project / workspace / label tag lists (N-N). The legacy single
   * `projectId` field is gone; consumers compose the three arrays to decide
   * what shows up in the top-bar filter chips.
   */
  projectIds: z.array(z.number().int()),
  workspaceIds: z.array(z.number().int()),
  labelIds: z.array(z.number().int()),
  /** Resolved display objects — present on detail responses, may be omitted on list. */
  projects: z
    .array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() }))
    .optional(),
  workspaces: z
    .array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() }))
    .optional(),
  labels: z
    .array(z.object({ id: z.number().int(), name: z.string(), color: z.string() }))
    .optional(),
  serverId: z.number().int().nullable().optional(),
  name: z.string(),
  slug: z.string(),
  type: serviceType,
  status: z.enum(['idle', 'deploying', 'running', 'stopped', 'error', 'deleting']),
  repoUrl: z.string().nullable(),
  branch: z.string(),
  sourceId: z.number().int().nullable(),
  /** Display name of the attached Git credential (source), for the UI. */
  sourceName: z.string().nullable().optional(),
  image: z.string().nullable(),
  /** Watchtower-style digest watch (image-based docker services only). */
  autoUpdate: z.boolean().optional(),
  volumeMount: z.string().nullable(),
  composeService: z.string().nullable(),
  /** The stored YAML of an inline compose stack; null for every other
   * service (a git-repo compose service keeps its file in the repository). */
  composeContent: z.string().nullable().optional(),
  commitSha: z.string().nullable(),
  runtimeId: z.string().nullable(),
  /** Additive in 0.18.0; absent/null on older panel responses. */
  orchestrator: serviceOrchestrator.nullable().optional(),
  healthPath: z.string(),
  /** Healthcheck deadline in seconds; null = the 300 s default (0.16.1). */
  healthTimeoutSeconds: z.number().int().nullable().optional(),
  /** How a deploy decides the new container is ready (0.16.1). */
  healthCheck: healthCheckMode.optional(),
  /** The 'command' healthcheck's shell command (0.16.3); null = none. */
  healthCommand: z.string().nullable().optional(),
  /** Custom container labels (0.16.3); {} = none. */
  dockerLabels: z.record(z.string(), z.string()).optional(),
  /** Git LFS files are fetched after checkout (0.16.3). */
  gitLfs: z.boolean().optional(),
  /** Advanced container options (0.16.1); null = none. */
  runtimeOptions: runtimeOptions.nullable().optional(),
  /** Canary releases (0.16.9); null = every deploy switches all traffic at once. */
  canary: canaryConfig.nullable().optional(),
  /** Autoscaling (0.16.10); null = `replicas` containers. */
  autoscale: autoscaleConfig.nullable().optional(),
  /** Scale to zero (0.16.11): minutes without a request before the service sleeps; null = never. */
  sleepAfterMinutes: z.number().int().nullable().optional(),
  /** When the service went to sleep; null = awake. Its first request wakes it. */
  asleepAt: z.string().nullable().optional(),
  autoUrl: z.string().nullable(),
  port: z.number().int().nullable(),
  publishedPort: z.number().int().nullable().optional(),
  /** Extra host-port mappings, TCP or UDP (0.16.1); [] = none. */
  portMappings: z.array(portMapping).optional(),
  cpuShares: z.number().int(),
  cpuLimitMilli: z.number().int(),
  memLimitMb: z.number().int(),
  replicas: z.number().int(),
  previewDeploymentsEnabled: z.boolean().optional(),
  previewAutoDestroyOnClose: z.boolean().optional(),
  /** 0.16.12: each PR preview gets its own copy of the attached databases (postgres and the redis family on the panel host). */
  previewDatabaseCopy: z.boolean().optional(),
  /** 0.16.14: build previews of PRs from forks too; each of their deploys waits for approval, and they clone with no credential. */
  previewForks: z.boolean().optional(),
  previewDomainPattern: z.string().nullable().optional(),
  previewMaxActive: z.number().int().optional(),
  isEphemeralPreview: z.boolean().optional(),
  previewParentServiceId: z.number().int().nullable().optional(),
  /** 0.16.14: this preview's PR comes from a fork (absent on older panels). */
  previewFromFork: z.boolean().optional(),
  prNumber: z.number().int().nullable().optional(),
  /** Deployment lane id (production / staging / …). Null = ungrouped. */
  environmentId: z.number().int().nullable().optional(),
  build: z
    .object({
      buildPack: buildPack,
      baseDir: z.string(),
      installCmd: z.string().nullable(),
      buildCmd: z.string().nullable(),
      startCmd: z.string().nullable(),
      dockerfilePath: z.string().nullable(),
      /** Static build pack: build output dir (relative to baseDir). */
      outputDir: z.string().nullable().optional(),
      /** Static build pack: SPA history fallback in the generated nginx conf. */
      staticSpa: z.boolean().optional(),
      preDeployCmd: z.string().nullable().optional(),
      postDeployCmd: z.string().nullable().optional(),
      preStopCmd: z.string().nullable().optional(),
      restartPolicy: z.string(),
      stopGraceSeconds: z.number().int(),
      /** Env-var names a Dockerfile build receives as `--build-arg` (0.16.1). */
      buildArgs: z.array(z.string()).optional(),
      /** Stage of a multi-stage Dockerfile the build stops at; null = the last (0.16.2). */
      buildTarget: z.string().nullable().optional(),
    })
    .nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Service = z.infer<typeof service>;

// ── Sources (private repo credentials) ─────────────────────────────────────
/** r512: a registry host a `registry` credential may be sent to (`ghcr.io`, `registry.local:5000`). */
export const registryHost = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/, 'Expected a registry host such as ghcr.io or registry.local:5000');
export const createSource = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['github', 'gitlab', 'gitea', 'bitbucket', 'custom', 'registry']),
  token: z.string().optional(),
  deployKey: z.string().optional(),
  // Registry-type sources: username for `docker login` (token = password).
  registryUsername: z.string().max(255).optional(),
  /** r512: registry hosts this credential may be sent to (Docker Hub = docker.io). */
  registryHosts: z.array(registryHost).max(20).optional(),
  defaultBranch: z.string().optional(),
  /**
   * 0.13: self-hosted provider base (Gitea; GitLab since G1.2, where absent means gitlab.com), e.g. `https://git.example.com`.
   * The server refuses `http:` unless private egress is allowed.
   * `github_app` is deliberately NOT in `type`: only installation sync creates those sources.
   */
  baseUrl: providerBaseUrl.optional(),
});
export type CreateSourceInput = z.input<typeof createSource>;

export const source = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.string(),
  hasToken: z.boolean(),
  hasDeployKey: z.boolean(),
  registryUsername: z.string().nullable().optional(),
  /** r512: hosts a registry credential is bound to (registry sources only). */
  registryHosts: z.array(z.string()).optional(),
  defaultBranch: z.string().nullable(),
  /** 0.13: self-hosted provider base URL (Gitea, or a self-hosted GitLab); null/absent = not set. */
  baseUrl: z.string().nullable().optional(),
  // ── 0.16 T8 surfaces ── multi-node (0.15.2, additive): this PAT or deploy key
  // may be sent to a node for one clone. Absent on older panels.
  allowOnNodes: z.boolean().optional(),
  // ── end 0.16 T8 ──
  /** 0.15.8: the panel pins this source's git host SSH keys (absent on older panels). */
  pinHostKeys: z.boolean().optional(),
  /** 0.15.8: what the pin holds, as fingerprints only. */
  pinnedHostKeys: z.array(z.object({ host: z.string(), type: z.string(), fingerprint: z.string().nullable() })).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});
export type Source = z.infer<typeof source>;

export const triggerDeploy = z.object({
  /**
   * @deprecated r334: IGNORED by `POST /v1/services/:id/deploys` — a manual
   * trigger always builds the configured branch head. Pinning a commit here
   * was never wired (the route reads no body). To redeploy an exact commit,
   * use `deploys.promote` (another lane's running SHA) or `deploys.rollback`.
   */
  commitSha: z.string().optional(),
});
export type TriggerDeploy = z.infer<typeof triggerDeploy>;

/**
 * Every deployment status. `awaiting_approval` (0.16.13) appears only on a
 * deploy into a lane that requires approval: it is not running, not
 * finished, and never claimed by the worker until an admin approves it.
 */
export const DEPLOYMENT_STATUSES = [
  'queued',
  'building',
  'deploying',
  'running',
  'superseded',
  'failed',
  'cancelled',
  'awaiting_approval',
  'awaiting_ci',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** A deploy that has ended: nothing will happen to it on its own any more. */
export const FINISHED_DEPLOYMENT_STATUSES = ['running', 'superseded', 'failed', 'cancelled'] as const;

export const deploymentCiSummary = z.object({
  state: z.enum(['waiting', 'passed', 'failed']),
  reason: z.string(),
  headSha: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime(),
  checks: z.array(z.object({
    path: z.string(), state: z.enum(['missing', 'pending', 'success', 'failure']),
    runId: z.number().nullable(), attempt: z.number().nullable(),
  })),
});

export const deployment = z.object({
  id: z.number().int(),
  status: z.enum(DEPLOYMENT_STATUSES),
  commitSha: z.string().nullable(),
  message: z.string().nullable(),
  author: z.string().nullable(),
  trigger: z.string(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** 0.16.13: who approved or rejected a deploy that waited for approval, and when (absent on older panels; null when it never waited). */
  reviewedBy: z.string().nullable().optional(),
  reviewedAt: z.string().datetime().nullable().optional(),
  ciGate: deploymentCiSummary.nullable().optional(),
  artifact: z.object({ imageId: z.string(), originDeploymentId: z.number().int(), originServerId: z.number().int().positive().optional(), promotionSourceDeploymentId: z.number().int().nullable(), registryRef: z.string().optional() }).nullable().optional(),
});
export type Deployment = z.infer<typeof deployment>;

/**
 * A single row in the global deploy queue (`GET /v1/services/queue`).
 *
 * Same fields as `Deployment` plus the service + project metadata the
 * panel needs to render "what is happening and what is coming next"
 * without a follow-up round-trip. `imageDigest` is populated for image
 * deploys where `commitSha` is null.
 */
export const queueItem = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  serviceName: z.string(),
  status: z.enum(['queued', 'building', 'deploying', 'awaiting_ci']),
  commitSha: z.string().nullable(),
  imageDigest: z.string().nullable(),
  message: z.string().nullable(),
  author: z.string().nullable(),
  trigger: z.string(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type QueueItem = z.infer<typeof queueItem>;

/** 0.16.13: one deploy waiting for approval (`GET /v1/services/approvals`). */
export const approvalItem = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  serviceName: z.string(),
  status: z.literal('awaiting_approval'),
  commitSha: z.string().nullable(),
  imageDigest: z.string().nullable(),
  message: z.string().nullable(),
  author: z.string().nullable(),
  trigger: z.string(),
  createdAt: z.string().datetime(),
  /** True when this caller is an admin of the service's lane and may approve or reject it. */
  mayReview: z.boolean(),
});
export type ApprovalItem = z.infer<typeof approvalItem>;

export const approvalsResponse = z.object({
  items: z.array(approvalItem),
  count: z.number().int(),
});
export type ApprovalsResponse = z.infer<typeof approvalsResponse>;

export const queueResponse = z.object({
  items: z.array(queueItem),
  count: z.number().int(),
  byStatus: z.object({
    queued: z.number().int(),
    building: z.number().int(),
    deploying: z.number().int(),
    awaiting_ci: z.number().int().optional(),
  }),
});
export type QueueResponse = z.infer<typeof queueResponse>;

// ── Domains (Traefik routing) ─────────────────────────────────────────────
export const createDomain = z.object({
  hostname: z.string().min(3).max(253),
  // r473: aligned with the manifest's route.path rule — the consumer strips
  // it downstream anyway, but the boundary should not depend on that.
  path: z.string().min(1).max(200).regex(/^\/.*$/).default('/'),
  // Default matches the DB column default and the CLI (`ssl !== false`):
  // HTTPS everywhere unless explicitly disabled.
  ssl: z.boolean().default(true),
  redirectWww: z.boolean().optional(),
  /** JSON array [{name, value}] of custom response headers. */
  headers: z.string().max(8000).optional(),
  /** Basic Auth credentials (JSON array of "user:htpasswd_hash" or "user:pass"). */
  basicAuth: z.string().max(8000).optional().nullable(),
  /** IP Allowlist (comma-separated CIDRs e.g. "1.2.3.4/32, 10.0.0.0/8"). */
  ipAllowlist: z.string().max(4000).optional().nullable(),
  /** Rate limit: average requests/second. */
  rateLimitAverage: z.number().int().min(0).max(100000).optional().nullable(),
  /** Rate limit: burst peak requests allowed. */
  rateLimitBurst: z.number().int().min(0).max(100000).optional().nullable(),
});
export type CreateDomainInput = z.input<typeof createDomain>;

/**
 * Why a redirect regex cannot go to Traefik, or null. Traefik compiles it
 * with Go's RE2, which has no lookaround and no backreferences — and a regex
 * Traefik refuses takes the whole dynamic config file down with it, so these
 * are refused when saved. The rest is checked by compiling it here.
 */
export function redirectRegexProblem(regex: string): string | null {
  if (/\(\?<?[=!]/.test(regex)) return 'lookahead / lookbehind are not supported (Traefik uses Go RE2)';
  if (/\\[1-9]/.test(regex)) return 'backreferences such as \\1 are not supported (Traefik uses Go RE2)';
  try {
    new RegExp(regex);
  } catch (err) {
    // RegExp only ever throws a SyntaxError here.
    return `not a valid regular expression (${(err as Error).message})`;
  }
  return null;
}

/** 0.16.1 one redirect rule of a domain (Dokploy's "Redirects"): Traefik `redirectRegex`. */
export const redirectRule = z
  .object({
    /** Matched against the full request URL, e.g. `^https://example.com/old/(.*)`. */
    regex: z.string().min(1).max(1000),
    /** The target; `${1}` inserts the first capture group. */
    replacement: z.string().min(1).max(2000).regex(/^[^\r\n]*$/, 'one line'),
    /** 301/308 when true, 302/307 when false. */
    permanent: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    const problem = redirectRegexProblem(r.regex);
    if (problem) ctx.addIssue({ code: 'custom', path: ['regex'], message: problem });
  });
export type RedirectRule = z.infer<typeof redirectRule>;

/** PATCHable routing extras for an existing domain. */
export const domainPatch = z.object({
  ssl: z.boolean().optional(),
  redirectWww: z.boolean().optional(),
  headers: z.string().max(8000).optional().nullable(),
  basicAuth: z.string().max(8000).optional().nullable(),
  ipAllowlist: z.string().max(4000).optional().nullable(),
  rateLimitAverage: z.number().int().min(0).max(100000).optional().nullable(),
  rateLimitBurst: z.number().int().min(0).max(100000).optional().nullable(),
  /** 0.16.1: redirect rules, applied in order; null or [] removes them. */
  redirects: z.array(redirectRule).max(10).optional().nullable(),
});
export type DomainPatch = z.input<typeof domainPatch>;

export const domain = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  hostname: z.string(),
  path: z.string(),
  ssl: z.boolean(),
  redirectWww: z.boolean(),
  headers: z.string(),
  basicAuth: z.string().nullable().optional(),
  ipAllowlist: z.string().nullable().optional(),
  rateLimitAverage: z.number().nullable().optional(),
  rateLimitBurst: z.number().nullable().optional(),
  /** 0.16.1 redirect rules (absent on older panels). */
  redirects: z.array(z.object({ regex: z.string(), replacement: z.string(), permanent: z.boolean() })).optional(),
  status: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Domain = z.infer<typeof domain>;

// ── Webhooks (auto-deploy) ────────────────────────────────────────────────
// Webhook CREATION is validated by `webhookCreate` in management.ts (the
// route's schema). The former duplicate here (r473: `createWebhook`) was used
// by no route and had drifted from the live one — removed rather than left
// as a trap for someone "hardening" the wrong twin.

export const webhook = z.object({
  id: z.number().int(),
  branch: z.string(),
  active: z.boolean(),
  watchPaths: z.string(),
  sourceId: z.number().int().nullable().optional(),
  url: z.string(),
  createdAt: z.string().datetime(),
});
export type Webhook = z.infer<typeof webhook>;

/**
 * Returned once at creation time — the secret is never retrievable again.
 * r334: the create route answers id/branch/active/sourceId/url/secret only;
 * `watchPaths` and `createdAt` come from `webhooks.list`.
 */
export const createdWebhook = webhook.omit({ watchPaths: true, createdAt: true }).extend({ secret: z.string() });
export type CreatedWebhook = z.infer<typeof createdWebhook>;

// ── Managed databases ─────────────────────────────────────────────────────
export const createDatabase = z.object({
  name: z.string().min(1).max(100),
  engine: z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq', 'keydb', 'dragonfly']),
  version: z.string().optional(),
  projectId: z.number().int().optional(),
  /** Hub/template provisioning is retryable: resume a matching database owned
   * by the caller instead of colliding with the globally unique slug. */
  reuseExisting: z.boolean().optional(),
  existingVolume: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  webGuiEnabled: z.boolean().optional(),
  /**
   * Multi-node (additive): the node to run the database on. null or absent =
   * the panel host (today). Operator only when non-null; placement is fixed
   * at create time.
   */
  serverId: z.number().int().positive().nullable().optional(),
});
export type CreateDatabaseInput = z.input<typeof createDatabase>;

export const DATABASE_STUDIO_ENGINES = ['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'keydb', 'dragonfly'] as const;

export const managedDatabase = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  name: z.string(),
  slug: z.string(),
  engine: z.string(),
  version: z.string().nullable(),
  status: z.string(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  username: z.string().nullable(),
  database: z.string().nullable(),
  connectionString: z.string().nullable(),
  webGuiEnabled: z.boolean().optional().default(false),
  webGuiPort: z.number().int().nullable().optional(),
  /** Node Studio lifecycle; no private container identity or credentials. */
  nodeStudioState: z.enum(['preparing', 'ready', 'cleanup_pending']).nullable().optional(),
  extensions: z.array(z.string()).optional().default([]),
  attachedServices: z.array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() })).optional().default([]),
  // ── 0.16 T8 surfaces: the node fields the 0.15.3 routes return (additive) ──
  /** The node the database runs on; null = the panel host. Absent before 0.15.3. */
  serverId: z.number().int().nullable().optional(),
  /** That node's name; null for a panel-host database. */
  serverName: z.string().nullable().optional(),
  /** The node's last reachability probe; null for a panel-host database or a node not probed yet. */
  reachable: z.boolean().nullable().optional(),
  // ── end 0.16 T8 ──
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ManagedDatabase = z.infer<typeof managedDatabase>;

/** Input for attaching a managed database to a service. The env alias, when
 *  provided, must be a valid environment-variable name (trimmed) — it is
 *  injected verbatim into the service's runtime env at deploy time. */
export const createAttachment = z.object({
  databaseId: z.number().int().positive(),
  envAlias: envVarName.optional(),
  reuseExisting: z.boolean().optional(),
});
export type CreateAttachmentInput = z.input<typeof createAttachment>;

export const attachment = z.object({
  id: z.number().int(),
  databaseId: z.number().int(),
  envAlias: z.string(),
  database: z.object({ name: z.string(), engine: z.string(), status: z.string() }).nullable(),
});
export type Attachment = z.infer<typeof attachment>;

// ── Environment variables ──────────────────────────────────────────────────
export const upsertEnvVar = z.object({
  key: envVarName.max(100),
  // r473: same 32 KB cap the Hub deployTemplate path applies — the sink
  // escapes newlines either way, but the twins should not disagree.
  value: z.string().max(32 * 1024),
  isSecret: z.boolean().optional(),
  overwriteExisting: z.boolean().optional(),
});
export type UpsertEnvVarInput = z.input<typeof upsertEnvVar>;

/** .env bulk import — parse the content server-side and upsert each var. */
export const envImport = z.object({
  content: z.string().min(1).max(100_000),
  isSecret: z.boolean().optional(),
  overwriteExisting: z.boolean().optional(),
});
export type EnvImportInput = z.infer<typeof envImport>;

export const envImportResult = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});
export type EnvImportResult = z.infer<typeof envImportResult>;

export const envVar = z.object({
  id: z.number().int(),
  key: z.string(),
  value: z.string(),
  isSecret: z.boolean(),
  /** 0.16.13: true when the service is in a protected lane and the caller is not its admin; `value` is then ''. */
  hidden: z.boolean().optional(),
});
export type EnvVar = z.infer<typeof envVar>;

// ── Service volume attachments ────────────────────────────────────────────
// A service can attach additional named Docker volumes in addition to its
// `volumeMount` primary. Either an existing managed volume (by name) or a
// fresh one created on demand. The volume persists across redeploys and
// container recreations — detaching only removes the link, not the data.
/** Create a new attachment. Exactly one of `volumeName` or `create.label`
 *  must be present — the former attaches an existing managed volume, the
 *  latter provisions a new one (system-generated name) and immediately
 *  attaches it. */
export const createServiceVolumeAttachment = z
  .object({
    // Attach an existing managed volume (must start with nd-svc- / nd-db-).
    volumeName: dockerVolumeName.optional(),
    // Provision a new named volume on attach. The label is a short
    // human-friendly suffix (e.g. "uploads"); the server prepends the
    // service-prefix to produce a unique managed name.
    create: z.object({ label: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/i, 'invalid label') }).optional(),
    containerPath: containerPath,
    readOnly: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.volumeName) !== Boolean(v.create?.label), {
    message: 'Provide exactly one of volumeName or create.label',
  });
export type CreateServiceVolumeAttachmentInput = z.input<typeof createServiceVolumeAttachment>;

/** PATCH shape — path and readOnly are optional, but at least one must change. */
export const updateServiceVolumeAttachment = z
  .object({
    containerPath: containerPath.optional(),
    readOnly: z.boolean().optional(),
  })
  .refine((v) => v.containerPath !== undefined || v.readOnly !== undefined, {
    message: 'Provide at least one of containerPath or readOnly',
  });
export type UpdateServiceVolumeAttachmentInput = z.input<typeof updateServiceVolumeAttachment>;

/** API representation of a service's volume attachment. */
export const serviceVolumeAttachment = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  volumeName: z.string(),
  containerPath: z.string(),
  readOnly: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ServiceVolumeAttachment = z.infer<typeof serviceVolumeAttachment>;

// ── Resource limits ───────────────────────────────────────────────────────
export const setLimits = z.object({
  cpuShares: z.number().int().min(0).max(262144).nullable().optional(),
  memLimitMb: z.number().int().min(0).nullable().optional(),
  /** Hard CPU cap in millicores (500 = 0.5 cores), unlike the relative
   * cpuShares weight. Maps to docker --cpus. */
  cpuLimitMilli: z.number().int().min(0).max(512_000).nullable().optional(),
});
export type SetLimitsInput = z.infer<typeof setLimits>;

// ── Monitoring stats ───────────────────────────────────────────────────────
export const hostStat = z.object({
  cpuCores: z.number().int(),
  load1: z.number(),
  memTotalBytes: z.number().int(),
  memUsedBytes: z.number().int(),
  diskTotalBytes: z.number().int(),
  diskUsedBytes: z.number().int(),
});
export type HostStat = z.infer<typeof hostStat>;

export const containerStat = z.object({
  name: z.string(),
  kind: z.enum(['service', 'database']),
  refId: z.number().int(),
  refName: z.string(),
  engine: z.string().optional(),
  cpuPct: z.number(),
  memMb: z.number(),
  memLimitMb: z.number().int(),
});
export type ContainerStat = z.infer<typeof containerStat>;

export const statsSnapshot = z.object({
  host: hostStat.nullable(),
  containers: z.array(containerStat),
  /** Present only for a single authorized database snapshot. Default monitoring remains local-only. */
  resource: z.object({
    kind: z.literal('database'), id: z.number().int().positive(), serverId: z.number().int().positive().nullable(),
    state: z.enum(['live', 'pending', 'unavailable', 'stale', 'stopped']), sampledAt: z.number().finite().nullable(),
  }).optional(),
});
export type StatsSnapshot = z.infer<typeof statsSnapshot>;
export const statsSnapshotQuery = z.object({ databaseId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });

export const metricSeries = z.object({
  kind: z.string(),
  points: z.array(z.object({ ts: z.string().datetime(), value: z.number() })),
});
export type MetricSeries = z.infer<typeof metricSeries>;

// ── Topology graph ─────────────────────────────────────────────────────────
export const topologyGraph = z.object({
  services: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      slug: z.string(),
      type: z.string(),
      status: z.string(),
      image: z.string().nullable(),
      port: z.number().int().nullable(),
      runtimeId: z.string().nullable(),
      volumeMount: z.string().nullable(),
    }),
  ),
  databases: z.array(z.object({ id: z.number().int(), name: z.string(), engine: z.string(), status: z.string(), host: z.string().nullable() })),
  attachments: z.array(z.object({ id: z.number().int(), serviceId: z.number().int(), databaseId: z.number().int(), envAlias: z.string() })),
  domains: z.array(z.object({ id: z.number().int(), serviceId: z.number().int(), hostname: z.string(), ssl: z.boolean() })),
  /** Managed docker volumes with their owner link (null = orphaned). */
  volumes: z.array(
    z.object({
      name: z.string(),
      owner: z.object({ kind: z.string(), refId: z.number().int(), name: z.string(), engine: z.string().optional() }).nullable(),
    }),
  ),
  /** User-defined docker networks; `containers` is filled for the shared mesh only. */
  networks: z.array(z.object({ name: z.string(), driver: z.string(), containers: z.array(z.string()) })),
  /** The Traefik gateway fronting every routed service. */
  gateway: z.object({ name: z.string(), network: z.string(), running: z.boolean() }),
});
export type TopologyGraph = z.infer<typeof topologyGraph>;

// ── Backups + storage ──────────────────────────────────────────────────────
export const backup = z.object({
  id: z.number().int(),
  // Exactly one of (databaseId, volumeName) is set — encoded by `scope`.
  databaseId: z.number().int().nullable(),
  volumeName: z.string().nullable(),
  scope: z.enum(['db', 'volumes']),
  status: z.string(),
  sizeBytes: z.number().int(),
  /** Snapshot name ('manual', 'schedule-…' or an operator tag); volume rows only. */
  label: z.string().nullable(),
  hasRemoteCopy: z.boolean().optional(),
  createdAt: z.string().datetime(),
});
export type Backup = z.infer<typeof backup>;

export const backupWithDb = backup.extend({ databaseName: z.string().nullable() });
export type BackupWithDb = z.infer<typeof backupWithDb>;

/** Create a new volume backup. The `volumeName` is the route param; the
 *  body only carries the `label` for human-friendly file naming. */
export const createVolumeBackup = z.object({
  label: z.string().min(1).max(80).optional(),
});
export type CreateVolumeBackupInput = z.input<typeof createVolumeBackup>;

// ── Template hub ───────────────────────────────────────────────────────────
export const templateSummary = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  category: z.string(),
  emoji: z.string(),
  featured: z.boolean().optional(),
  runtimeVerified: z.boolean().optional(),
  verifiedAt: z.iso.date().optional(),
});
export type TemplateSummary = z.infer<typeof templateSummary>;

export const template = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  category: z.string(),
  emoji: z.string(),
  image: z.string(),
  port: z.number().int(),
  /** Override for the isolated smoke run's readiness window (seconds).
   *  Upstream images whose cold start legitimately exceeds the 300s default
   *  (model-loading services) set this so re-verification stays honest
   *  instead of timing out a working image. */
  startTimeoutSeconds: z.number().int().min(30).max(1800).optional(),
  volumeMount: z.string().nullable().optional(),
  env: z.array(z.object({ key: z.string(), value: z.string(), secret: z.boolean().optional() })).optional(),
  website: z.string().optional(),
  docs: z.string().optional(),
  featured: z.boolean().optional(),
  /** Set only after the complete template contract has passed an isolated
   * container startup and declared-port smoke test. */
  runtimeVerified: z.boolean().optional(),
  verifiedAt: z.iso.date().optional(),
  /** Human hint about extra setup this template needs (shown in the Hub). */
  requires: z.string().optional(),
  /** When set, the wizard can auto-provision + attach a managed database of
   *  this engine. databaseEnv controls the application-specific injection. */
  dbEngine: z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo', 'clickhouse', 'meilisearch', 'rabbitmq']).optional(),
  /** Map application-specific environment keys to managed database connection
   * fields. Without this, attachments expose only their legacy URL alias. */
  databaseEnv: z.record(
    envVarName,
    z.enum(['url', 'host', 'hostPort', 'port', 'username', 'password', 'database']),
  ).optional(),
  /** Container command (argv) appended after the image — needed by images
   *  whose default entrypoint prints help and exits (e.g. minio). */
  cmd: z.array(z.string()).min(1).optional(),
  /** Bind-mount the host Docker socket into the container (docker control —
   *  only settable from the admin-controlled template registry, never via
   *  the create-service API). */
  dockerSocket: z.boolean().optional(),
  /** Full Docker Compose stack definition. When present the template deploys
   *  as a multi-container compose project (`type: 'compose'`) instead of the
   *  single-container image+port model; `image`/`port` then describe the MAIN
   *  (routed) service for Hub display and health routing. */
  composeContent: z.string().min(1).max(262_144).optional(),
  /** Compose service name the router points at and that owns `# port`. */
  composeService: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).optional(),
}).superRefine((value, ctx) => {
  if (value.dbEngine && !value.databaseEnv) {
    ctx.addIssue({
      code: 'custom',
      path: ['databaseEnv'],
      message: 'databaseEnv is required when dbEngine is set',
    });
  }
  if (value.composeContent && !value.composeService) {
    ctx.addIssue({
      code: 'custom',
      path: ['composeService'],
      message: 'composeService is required when composeContent is set',
    });
  }
});
export type Template = z.infer<typeof template>;

/**
 * Community template contribution (G-13). A `*.json`
 * file dropped into `<dataDir>/community-templates/` is
 * parsed against the `template` schema and surfaced in
 * the `community.list` response. Files that fail to
 * parse are reported in `errors` (one entry per file)
 * so a single bad contribution does not hide the rest.
 */
export const communityTemplateEntrySchema = z.object({
  id: z.string(),
  template: template,
  file: z.string(),
  bytes: z.number().int().nonnegative(),
  mtime: z.number(),
});
export type CommunityTemplateEntry = z.infer<typeof communityTemplateEntrySchema>;

export const communityTemplateListResultSchema = z.object({
  entries: z.array(communityTemplateEntrySchema),
  errors: z.array(z.object({ file: z.string(), error: z.string() })),
  totalBytes: z.number().int().nonnegative(),
});
export type CommunityTemplateListResult = z.infer<typeof communityTemplateListResultSchema>;

/**
 * One canonical Hub installation request. Internal port, volume, command,
 * Docker socket and database mapping are intentionally absent: they are
 * privileged registry-owned fields resolved by the server.
 */
export const deployTemplate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  projectId: z.number().int().positive().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
  healthPath: httpPath.optional(),
  cpuShares: z.number().int().min(0).max(262144).optional(),
  /** Hard CPU cap in millicores (500 = 0.5 cores); maps to docker --cpus. */
  cpuLimitMilli: z.number().int().min(0).max(512_000).optional(),
  memLimitMb: z.number().int().min(0).optional(),
  /** Optional tag override for the template's image — SAME repository only
   *  (e.g. directus/directus:11.5 instead of :latest). Validated server-side
   *  against the template image; digest references and cross-repository
   *  swaps are rejected. */
  image: z.string().trim().min(1).max(500).optional(),
  env: z.array(z.object({
    key: envVarName,
    value: z.string().max(32_768),
    isSecret: z.boolean().optional().default(false),
  })).max(200).optional(),
  /** Reconcile an interrupted caller-owned install with the same slug. */
  reuseExisting: z.boolean().optional().default(true),
});
export type DeployTemplateInput = z.input<typeof deployTemplate>;
export type DeployTemplate = z.infer<typeof deployTemplate>;

/**
 * Dry-run analysis of a pasted compose file. The wizard calls this while the
 * user is still typing so blocking problems, host-privilege warnings, the
 * routable service list and the variables the stack will ask for all appear
 * inline — instead of arriving as a 400 after the service row already exists.
 * Reads only: nothing is written and no service is created.
 */
export const composePreviewRequest = z.object({
  content: z.string().min(1).max(262_144),
  /** The container port the wizard is about to route to, used to pick the
   * main service by port reference. 0/omitted falls back to name heuristics. */
  port: z.number().int().min(1).max(65535).optional(),
});
export type ComposePreviewRequestInput = z.input<typeof composePreviewRequest>;

export const composePreviewResponse = z.object({
  /** False when `reasons` is non-empty — the stack cannot run here at all. */
  ok: z.boolean(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Every service key in the file, in declaration order. */
  services: z.array(z.string()),
  /** Best guess at the routed service; null when the file declares none. */
  suggestedService: z.string().nullable(),
  /** `SERVICE_*` tokens the platform will generate values for. */
  magicTokens: z.array(z.string()),
  /** `${VAR}` references with no default — the user must supply these. */
  openPlaceholders: z.array(z.string()),
  /** `${VAR:-default}` references, offered as prefilled env rows. */
  configurableEnv: z.array(z.object({ key: z.string(), value: z.string() })),
});
export type ComposePreviewResponse = z.infer<typeof composePreviewResponse>;

/**
 * Whether an image reference keeps the template's registry repository while
 * changing only the tag (`directus/directus:latest` → `directus/directus:11.5`).
 * Digest references and cross-repository swaps are refused: the Hub override
 * exists to pin a version, not to run an arbitrary image under a template's name.
 */
export function sameImageRepository(templateImage: string, override: string): boolean {
  if (override.includes('@')) return false;
  const repo = (ref: string): string => {
    const at = ref.lastIndexOf('@');
    if (at > ref.lastIndexOf('/')) return ref.slice(0, at);
    const colon = ref.lastIndexOf(':');
    return colon > ref.lastIndexOf('/') ? ref.slice(0, colon) : ref;
  };
  return repo(templateImage) === repo(override);
}

// ── Domain routing index + volumes ─────────────────────────────────────────
export const domainEntry = z.object({
  id: z.number().int(),
  hostname: z.string(),
  path: z.string(),
  ssl: z.boolean(),
  status: z.string(),
  serviceId: z.number().int(),
  serviceName: z.string().nullable(),
  container: z.string().nullable(),
  port: z.number().int().nullable(),
  certExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DomainEntry = z.infer<typeof domainEntry>;

export const volumeEntry = z.object({
  name: z.string(),
  sizeBytes: z.number().int(),
  owner: z.object({ kind: z.string(), id: z.number().int().optional(), name: z.string(), engine: z.string().optional() }).nullable(),
  /** True when the owner's container is running — deletion is refused (409). */
  inUse: z.boolean(),
});
export type VolumeEntry = z.infer<typeof volumeEntry>;

// ── Volume file manager ────────────────────────────────────────────────────
export const volumeFileEntry = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir']),
  sizeBytes: z.number().int(),
  mode: z.string().nullable().optional(),
  modifiedAt: z.string().datetime().nullable(),
});
export type VolumeFileEntry = z.infer<typeof volumeFileEntry>;

export const volumeFileWrite = z.object({
  /** Relative path inside the volume. */
  path: z.string().min(1).max(1024),
  /** Base64-encoded file content (schemas validate; argv never sees it). */
  contentBase64: z.string().max(8 * 1024 * 1024).refine((value) => {
    const compact = value.replace(/\s/g, '');
    return compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
  }, { message: 'must be valid base64 content' }),
});
export type VolumeFileWriteInput = z.input<typeof volumeFileWrite>;

export const volumePathCreate = z.object({
  path: z.string().min(1).max(1024),
});
export type VolumePathCreateInput = z.input<typeof volumePathCreate>;

// ── Container file manager ─────────────────────────────────────────────────
export const containerFileEntry = volumeFileEntry;
export type ContainerFileEntry = VolumeFileEntry;

export const containerFileWrite = volumeFileWrite;
export type ContainerFileWriteInput = VolumeFileWriteInput;

export const containerPathCreate = volumePathCreate;
export type ContainerPathCreateInput = VolumePathCreateInput;

// ── Docker resource accounting ─────────────────────────────────────────────
export const dockerResources = z.object({
  network: z.string(),
  containers: z.number().int(),
  volumes: z.number().int(),
  imagesSummary: z.object({ total: z.string(), active: z.string(), size: z.string(), reclaimable: z.string() }),
  images: z.array(z.object({ repo: z.string(), tag: z.string(), size: z.string() })),
});
export type DockerResources = z.infer<typeof dockerResources>;

// ── Cloudflare Tunnels ─────────────────────────────────────────────────────
export const createTunnel = z.object({ name: z.string().min(1).max(100), token: z.string().min(1) });
export type CreateTunnelInput = z.input<typeof createTunnel>;

export const tunnelEntry = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  containerName: z.string(),
  createdAt: z.string().datetime(),
});
export type TunnelEntry = z.infer<typeof tunnelEntry>;

// ── Log Drains ─────────────────────────────────────────────────────────────
export const logDrainType = z.enum(['syslog', 'loki', 'vector', 'datadog', 'http']);
export type LogDrainType = z.infer<typeof logDrainType>;

export const logDrainFormat = z.enum(['json', 'raw', 'rfc5424']);
export type LogDrainFormat = z.infer<typeof logDrainFormat>;

export const logDrain = z.object({
  id: z.number().int(),
  name: z.string(),
  type: logDrainType,
  url: z.string(),
  serviceId: z.number().int().nullable(),
  serviceName: z.string().nullable().optional(),
  enabled: z.boolean(),
  format: logDrainFormat,
  headers: z.record(z.string(), z.string()).optional(),
  hasApiKey: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LogDrain = z.infer<typeof logDrain>;

export const logDrainCreate = z.object({
  name: z.string().min(1).max(100),
  type: logDrainType,
  url: z.string().min(1),
  apiKey: z.string().optional(),
  serviceId: z.number().int().optional().nullable(),
  enabled: z.boolean().optional(),
  format: logDrainFormat.optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type LogDrainCreateInput = z.input<typeof logDrainCreate>;

export const logDrainUpdate = logDrainCreate.partial();
export type LogDrainUpdateInput = z.input<typeof logDrainUpdate>;

export const logDrainTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  message: z.string().optional(),
});
export type LogDrainTestResult = z.infer<typeof logDrainTestResult>;

// ── Auto-Prune & Disk Maintenance ──────────────────────────────────────────
export const autoPruneConfig = z.object({
  enabled: z.boolean(),
  thresholdPercent: z.number().min(10).max(99),
  pruneImages: z.boolean(),
  pruneVolumes: z.boolean(),
  pruneContainers: z.boolean(),
  pruneBuildCache: z.boolean(),
  maxAgeHours: z.number().min(1).max(720),
});
export type AutoPruneConfig = z.infer<typeof autoPruneConfig>;

export const autoPruneConfigUpdate = autoPruneConfig.partial();
export type AutoPruneConfigUpdateInput = z.input<typeof autoPruneConfigUpdate>;

export const autoPruneStatus = autoPruneConfig.extend({
  diskUsedPercent: z.number(),
  diskTotalBytes: z.number(),
  diskFreeBytes: z.number(),
  lastPrunedAt: z.string().datetime().nullable(),
  lastFreedBytes: z.number().nullable(),
});
export type AutoPruneStatus = z.infer<typeof autoPruneStatus>;

export const autoPruneRunResult = z.object({
  ok: z.boolean(),
  freedBytes: z.number(),
  diskUsedPercentAfter: z.number(),
  details: z.object({
    imagesFreed: z.string().optional(),
    buildCacheFreed: z.string().optional(),
    containersFreed: z.string().optional(),
    volumesFreed: z.string().optional(),
  }),
});
export type AutoPruneRunResult = z.infer<typeof autoPruneRunResult>;

