import { z } from 'zod';
import { envVarName, httpPath, repoBaseDir, slug } from './common.js';

/**
 * `.ninedeploy` manifest schema — project-side declarative config for how
 * NineDeploy should build, run and route a service. Committed to the repo,
 * so it must NEVER carry secrets, tokens or connection strings; the loader
 * enforces that with a regex scan (see apps/server/src/lib/secretScan.ts).
 *
 * Merge precedence at apply time: panel/DB > manifest > auto-detect. The
 * manifest fills empty panel fields; an operator who explicitly set something
 * in the panel wins.
 */

// ── Runtime ────────────────────────────────────────────────────────────────
export const runtimeType = z.enum([
  'auto',
  'node',
  'python',
  'go',
  'ruby',
  'php',
  'java',
  'rust',
  'static',
]);
export type RuntimeType = z.infer<typeof runtimeType>;

export const runtime = z
  .object({
    type: runtimeType.default('auto'),
    /**
     * Pinned language version. Format `<major>` or `<major>.<minor>` or
     * `<major>.<minor>.<patch>`. For example `20`, `20.18`, `3.12`.
     */
    version: z
      .string()
      .regex(/^\d+(?:\.\d+){0,2}$/, 'must be a numeric version like 20 or 3.12')
      .max(20)
      .optional(),
  })
  .strict();
export type Runtime = z.infer<typeof runtime>;

// ── Build ──────────────────────────────────────────────────────────────────
export const build = z
  .object({
    install: z.string().min(1).max(500).optional(),
    build: z.string().min(1).max(500).optional(),
    start: z.string().min(1).max(500).optional(),
    baseDir: repoBaseDir.optional(),
    dockerfile: z.string().min(1).max(200).optional(),
  })
  .strict();
export type Build = z.infer<typeof build>;

// ── Run ────────────────────────────────────────────────────────────────────
export const restartPolicy = z
  .union([
    z.enum(['no', 'always', 'unless-stopped']),
    z
      .string()
      .regex(
        /^on-failure(?::[1-9]\d{0,2})?$/,
        'must be on-failure or on-failure:N (1-999, no leading zero)',
      ),
  ])
  .optional();
/** Inferred type for the `run.restart` field, exported for consumers. */
export type RestartPolicy = z.infer<typeof restartPolicy>;

export const run = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    healthcheck: httpPath.optional(),
    restart: restartPolicy,
  })
  .strict();
export type Run = z.infer<typeof run>;

// ── Static ─────────────────────────────────────────────────────────────────
const noTraversalSegments = (value: string): boolean =>
  !value.split('/').some((segment) => segment === '..' || segment === '.');

const isRelativePath = (value: string): boolean => !value.startsWith('/');

export const staticConfig = z
  .object({
    spa: z.boolean().default(false),
    root: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._/-]+$/, 'must be a relative path with allowed characters')
      .refine(noTraversalSegments, { message: 'path must not contain . or .. segments' })
      .refine(isRelativePath, { message: 'path must be relative (no leading "/")' })
      .optional(),
  })
  .strict();
export type StaticConfig = z.infer<typeof staticConfig>;

// ── Env ────────────────────────────────────────────────────────────────────
export const env = z
  .object({
    /** Required env var names. Values stay in the panel's env vault. */
    required: z.array(envVarName.max(100)).max(100).default([]),
    /** Managed-DB attach alias: env-key → attachment-env-key. The KEY side is
     *  validated too: free-form keys (`'MY VAR'`, `''`) could never be
     *  referenced by an attachment and corrupt the emitted YAML. */
    aliases: z.record(envVarName, envVarName).optional(),
  })
  .strict();
export type Env = z.infer<typeof env>;

// ── Phases (Nixpacks ince ayar) ────────────────────────────────────────────
export const phases = z
  .object({
    setup: z
      .object({
        pkgs: z.array(z.string().min(1).max(100)).max(50).default([]),
      })
      .strict()
      .optional(),
    build: z
      .object({
        cmds: z.array(z.string().min(1).max(500)).max(20).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Phases = z.infer<typeof phases>;

// ── Resources ──────────────────────────────────────────────────────────────
export const resources = z
  .object({
    cpuShares: z.number().int().min(0).max(262144).optional(),
    /** Hard CPU cap in millicores (500 = 0.5 cores); maps to docker --cpus. */
    cpuLimitMilli: z.number().int().min(0).max(512_000).optional(),
    memMb: z.number().int().min(0).max(1_048_576).optional(),
  })
  .strict();
export type Resources = z.infer<typeof resources>;

// ── Hooks ──────────────────────────────────────────────────────────────────
export const hooks = z
  .object({
    preBuild: z.string().min(1).max(500).optional(),
    postBuild: z.string().min(1).max(500).optional(),
    preStop: z.string().min(1).max(500).optional(),
  })
  .strict();
export type Hooks = z.infer<typeof hooks>;

// ── Watch (monorepo) ──────────────────────────────────────────────────────
export const watch = z
  .object({
    paths: z.array(z.string().min(1).max(200)).max(50).default([]),
  })
  .strict();
export type Watch = z.infer<typeof watch>;

// ── Routes ─────────────────────────────────────────────────────────────────
export const rateLimit = z
  .object({
    average: z.number().int().min(0).max(100_000),
    burst: z.number().int().min(0).max(100_000),
  })
  .strict();
export type RateLimit = z.infer<typeof rateLimit>;

export const route = z
  .object({
    host: z
      .string()
      .min(3)
      .max(253)
      .regex(
        /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/,
        'must be a valid hostname',
      ),
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\/.*$/, 'must start with "/"')
      .default('/'),
    ssl: z.boolean().default(true),
    redirectWww: z.boolean().optional(),
    headers: z.record(z.string().min(1).max(200), z.string().min(1).max(2000)).optional(),
    ipAllowlist: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .regex(/^[\d./]+$/, 'must be a CIDR like 1.2.3.4/32'),
      )
      .max(50)
      .optional(),
    rateLimit: rateLimit.optional(),
  })
  .strict();
export type Route = z.infer<typeof route>;

// ── Previews ──────────────────────────────────────────────────────────────
export const previews = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Hostname template. `{n}` is replaced by the PR number. Example:
     * `pr-{n}.previews.example.com`. Must contain `{n}` when enabled.
     */
    pattern: z
      .string()
      .min(1)
      .max(200)
      .regex(
        /^[A-Za-z0-9._/{}*-]+$/,
        'must be a hostname template (letters, digits, dot, dash, underscore, slash, brace, asterisk)',
      )
      .refine(noTraversalSegments, { message: 'pattern must not contain . or .. segments' })
      .optional(),
    maxActive: z.number().int().min(1).max(50).default(5),
    autoDestroyOnClose: z.boolean().default(true),
  })
  .strict()
  .refine((p) => !p.enabled || (p.pattern != null && p.pattern.includes('{n}')), {
    message: 'previews.pattern must contain {n} when previews.enabled is true',
    path: ['pattern'],
  });
export type Previews = z.infer<typeof previews>;

// ── Volume ────────────────────────────────────────────────────────────────
export const volumeBackups = z
  .object({
    schedule: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[\d*/,\-A-Za-z\s]+$/,
        'must look like a cron expression (digits, *, /, comma, dash, letters, space)',
      ),
    retention: z.number().int().min(1).max(365).default(7),
  })
  .strict();
export type VolumeBackups = z.infer<typeof volumeBackups>;

export const volume = z
  .object({
    mount: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._/-]+$/, 'must be a path inside the container')
      .refine(noTraversalSegments, { message: 'mount must not contain . or .. segments' })
      .optional(),
    backups: volumeBackups.optional(),
  })
  .strict();
export type Volume = z.infer<typeof volume>;

// ── Database (managed DB attach hint) ─────────────────────────────────────
export const database = z
  .object({
    ref: slug,
    env: envVarName,
  })
  .strict();
export type Database = z.infer<typeof database>;

// ── Network ───────────────────────────────────────────────────────────────
export const network = z
  .object({
    publishPort: z.number().int().min(1).max(65535).optional(),
    aliases: z.array(z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/)).max(20).default([]),
  })
  .strict();
export type Network = z.infer<typeof network>;

// ── Notifications (channel-name references) ──────────────────────────────
export const notifications = z
  .object({
    onDeploy: z.array(z.string().min(1).max(100)).max(20).default([]),
    onFailure: z.array(z.string().min(1).max(100)).max(20).default([]),
    onAlert: z.array(z.string().min(1).max(100)).max(20).default([]),
  })
  .strict();
export type Notifications = z.infer<typeof notifications>;

// ── Alerts ────────────────────────────────────────────────────────────────
export const alertWhen = z.enum([
  'deployFailed',
  'restartLoop',
  'highMemory',
  'highCpu',
  'certExpiry',
]);
/** Inferred type for the `alerts[].when` field, exported for consumers. */
export type AlertWhen = z.infer<typeof alertWhen>;

export const alert = z
  .object({
    when: alertWhen,
    channel: z.string().min(1).max(100),
    thresholdPct: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.when !== 'highMemory' && a.when !== 'highCpu' ? true : a.thresholdPct != null,
    {
      message: 'thresholdPct is required for highMemory/highCpu alerts',
      path: ['thresholdPct'],
    },
  );
export type Alert = z.infer<typeof alert>;

// ── Top-level manifest ────────────────────────────────────────────────────
export const ninedeployManifest = z
  .object({
    version: z.literal('1'),
    runtime: runtime.optional(),
    build: build.optional(),
    run: run.optional(),
    static: staticConfig.optional(),
    env: env.optional(),
    phases: phases.optional(),
    resources: resources.optional(),
    hooks: hooks.optional(),
    watch: watch.optional(),
    routes: z.array(route).max(50).optional(),
    previews: previews.optional(),
    volume: volume.optional(),
    database: database.optional(),
    network: network.optional(),
    notifications: notifications.optional(),
    alerts: z.array(alert).max(20).optional(),
  })
  .strict();
export type NinedeployManifest = z.infer<typeof ninedeployManifest>;

/**
 * The list of filenames the loader checks, in priority order. The first one
 * found in the repo root is used.
 */
export const NINEDEPLOY_MANIFEST_FILENAMES = [
  '.ninedeploy',
  '.ninedeploy.yml',
  '.ninedeploy.yaml',
  'ninedeploy.yml',
  'ninedeploy.yaml',
] as const;
export type NinedeployManifestFilename = (typeof NINEDEPLOY_MANIFEST_FILENAMES)[number];

/** Maximum allowed size of a `.ninedeploy` file (bytes). Larger files are refused. */
export const NINEDEPLOY_MANIFEST_MAX_BYTES = 16 * 1024;
