import { z } from 'zod';

// ── R5: CI jobs on enrolled runners ────────────────────────────────────────
// A service's pipeline is one container image and a shell script. A job is
// one run of it at a commit; runners pull jobs over HTTPS with their own token.

const label = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, 'Labels use lowercase letters, digits, dot, dash and underscore');
/**
 * Job variables travel in the docker client's environment on the runner (so
 * values never appear on a command line). Names that steer that client, the
 * dynamic loader or the shell are refused, or a service admin could point the
 * runner's Docker client at another daemon or preload code into it.
 */
export const CI_RESERVED_ENV =
  /^(PATH|HOME|USER|SHELL|TMPDIR|TEMP|TMP|IFS|ENV|BASH_ENV|BASH_FUNC_.*|GCONV_PATH|LOCALPATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|LD_.*|DYLD_.*|DOCKER_.*|BUILDKIT_.*|NODE_.*|NPM_CONFIG_.*|SSL_CERT_.*|CURL_CA_BUNDLE|(HTTP|HTTPS|ALL|NO|FTP)_PROXY|CI|NINEDEPLOY_.*)$/i;

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Not a variable name')
  .refine((n) => !CI_RESERVED_ENV.test(n), 'This name is reserved: it would change the runner, not only the job');
/** A Docker image reference: no whitespace, no option-looking leading dash. */
const imageRef = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-zA-Z0-9._/:@-]*$/, 'Not an image reference');

export const ciPipeline = z
  .object({
    image: imageRef,
    script: z.string().min(1).max(64_000),
    /** A runner must carry every one of these labels to take the job. */
    labels: z.array(label).max(10).default([]),
    /** Service variables handed to the job as environment. Nothing else from the service reaches it. */
    secrets: z.array(envName).max(50).default([]),
    timeoutMinutes: z.number().int().min(1).max(360).default(30),
    /** Attempts in total when a runner is lost mid-job (a failing script is not retried). */
    maxAttempts: z.number().int().min(1).max(5).default(2),
    /** Jobs wait for a service admin to approve them before any runner sees them. */
    requireApproval: z.boolean().default(false),
  })
  .strict();
export type CiPipeline = z.infer<typeof ciPipeline>;

export const ciJobCreate = z
  .object({
    /** A commit or branch of the service's repository; the service branch when left out. */
    ref: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/@-]+$/).optional(),
  })
  .strict();
export type CiJobCreate = z.infer<typeof ciJobCreate>;

export const ciRunnerCreate = z
  .object({
    name: z.string().min(1).max(80),
    labels: z.array(label).max(20).default([]),
    capacity: z.number().int().min(1).max(32).default(1),
  })
  .strict();
export type CiRunnerCreate = z.infer<typeof ciRunnerCreate>;

export const ciJobStatusValues = ['awaiting_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const ciAttemptStatusValues = ['running', 'succeeded', 'failed', 'lost', 'cancelled'] as const;

export interface CiAttemptView {
  id: number;
  number: number;
  runnerId: number | null;
  runnerName: string | null;
  status: (typeof ciAttemptStatusValues)[number];
  exitCode: number | null;
  error: string | null;
  logBytes: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface CiJobView {
  id: number;
  serviceId: number;
  status: (typeof ciJobStatusValues)[number];
  ref: string | null;
  commitSha: string | null;
  image: string;
  labels: string[];
  secretNames: string[];
  trigger: string;
  attempts: number;
  maxAttempts: number;
  timeoutSeconds: number;
  error: string | null;
  createdBy: number | null;
  approvedBy: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CiRunnerView {
  id: number;
  name: string;
  labels: string[];
  capacity: number;
  version: string | null;
  lastSeenAt: string | null;
  online: boolean;
  revokedAt: string | null;
  running: number;
  createdAt: string;
}

// ── The runner protocol (runner → panel) ───────────────────────────────────

export const ciRunnerClaim = z
  .object({
    /** Jobs the runner is running now; it is offered one only below its capacity. */
    running: z.number().int().min(0).max(64),
    version: z.string().max(40).optional(),
  })
  .strict();

export const ciRunnerLog = z
  .object({
    /** 1, 2, 3…: a chunk already stored (a retried POST) is acknowledged, not appended twice. */
    seq: z.number().int().min(1),
    data: z.string().max(256 * 1024),
  })
  .strict();

export const ciRunnerFinish = z
  .object({
    status: z.enum(['succeeded', 'failed']),
    exitCode: z.number().int().nullable(),
    error: z.string().max(2000).optional(),
  })
  .strict();

/** What a claim hands the runner. The lease token authorises everything about this attempt and nothing else. */
export interface CiClaimResponse {
  attemptId: number;
  jobId: number;
  number: number;
  leaseToken: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  image: string;
  script: string;
  timeoutSeconds: number;
  env: Record<string, string>;
  commitSha: string | null;
  /** GET this with the lease token for the checked-out source (tar.gz), when the service has a repository. */
  sourcePath: string | null;
}
