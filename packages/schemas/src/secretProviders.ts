import { z } from 'zod';
import { providerBaseUrl } from './common.js';

// ── Secret managers (0.14) ─────────────────────────────────────────────────
// Request and response shapes for `/v1/settings/secret-providers`. HashiCorp
// Vault / OpenBao (KV v2) and AWS Secrets Manager run alongside the existing
// settings-based Infisical / Doppler provider, which is untouched. Credentials
// only ever appear in REQUEST shapes; on update an omitted credential field
// keeps the stored value. The server enforces https (http only with private
// egress) and proves the settings with a test call. Design: DESIGN.md §4.

/**
 * Mirrors `secretProviderKind` in `@ninedeploy/db`. G3.2 added gcp, azure,
 * onepassword and exec (the column is plain text: no migration). Parameter
 * Store (`${{ssm:…}}`) has no kind of its own: it reads with the aws row.
 */
export const secretProviderKind = z.enum(['vault', 'aws', 'gcp', 'azure', 'onepassword', 'exec']);
export type SecretProviderKind = z.infer<typeof secretProviderKind>;

// ── Reference grammar pieces (DESIGN §4.1) ─────────────────────────────────

/**
 * A Vault path relative to the KV v2 mount: segments of `[A-Za-z0-9_.-]+`
 * joined by `/`, no leading or trailing `/`, and no `.` or `..` segment.
 */
export const VAULT_PATH_RE = /^(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+)*$/;
/** A KV v2 field name. */
export const VAULT_FIELD_RE = /^[A-Za-z0-9_.-]+$/;
/** An AWS secret name or full ARN. */
export const AWS_SECRET_ID_RE = /^[A-Za-z0-9/_+=.@:-]{1,2048}$/;
export const AWS_REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
export const AWS_ACCESS_KEY_ID_RE = /^(AKIA|ASIA)[A-Z0-9]{16}$/;

export const vaultPath = z.string().max(1024).regex(VAULT_PATH_RE, 'invalid Vault path');
export const awsSecretId = z.string().regex(AWS_SECRET_ID_RE, 'invalid AWS secret id');

// ── HashiCorp Vault / OpenBao ──────────────────────────────────────────────

export const vaultAuthMethod = z.enum(['token', 'approle']);
export type VaultAuthMethod = z.infer<typeof vaultAuthMethod>;

export const vaultProviderConfig = z
  .object({
    address: providerBaseUrl,
    /** Vault Enterprise / OpenBao namespace (`X-Vault-Namespace`). */
    namespace: vaultPath.optional(),
    mount: vaultPath.default('secret'),
    authMethod: vaultAuthMethod,
    approleMount: vaultPath.default('approle'),
  })
  .strict();
export type VaultProviderConfig = z.input<typeof vaultProviderConfig>;

const vaultSecret = z.string().min(1).max(4096);

export const vaultProviderCredentials = z
  .object({
    token: vaultSecret.optional(),
    roleId: vaultSecret.optional(),
    secretId: vaultSecret.optional(),
  })
  .strict();
export type VaultProviderCredentials = z.infer<typeof vaultProviderCredentials>;

/** PUT /v1/settings/secret-providers/vault. */
export const vaultProviderPut = z
  .object({
    enabled: z.boolean().optional(),
    config: vaultProviderConfig,
    credentials: vaultProviderCredentials.optional(),
  })
  .strict()
  .refine((v) => v.config.authMethod !== 'token' || (v.credentials?.roleId === undefined && v.credentials?.secretId === undefined), {
    message: 'roleId and secretId belong to authMethod "approle"',
    path: ['credentials'],
  })
  .refine((v) => v.config.authMethod !== 'approle' || v.credentials?.token === undefined, {
    message: 'token belongs to authMethod "token"',
    path: ['credentials', 'token'],
  });
export type VaultProviderPut = z.input<typeof vaultProviderPut>;

// ── AWS Secrets Manager ────────────────────────────────────────────────────

export const awsProviderConfig = z
  .object({
    region: z.string().regex(AWS_REGION_RE, 'invalid AWS region'),
    /** VPC endpoint or compatible service; https. */
    endpoint: providerBaseUrl.optional(),
    roleArn: z
      .string()
      .max(2048)
      .regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/, 'invalid IAM role ARN')
      .optional(),
    externalId: z
      .string()
      .min(2)
      .max(1224)
      .regex(/^[\w+=,.@:/-]+$/, 'invalid external id')
      .optional(),
    roleSessionName: z
      .string()
      .regex(/^[\w+=,.@-]{2,64}$/, 'invalid role session name')
      .default('ninedeploy'),
  })
  .strict()
  .refine((v) => v.externalId === undefined || v.roleArn !== undefined, {
    message: 'externalId needs roleArn',
    path: ['externalId'],
  });
export type AwsProviderConfig = z.input<typeof awsProviderConfig>;

export const awsProviderCredentials = z
  .object({
    accessKeyId: z.string().regex(AWS_ACCESS_KEY_ID_RE, 'invalid access key id').optional(),
    secretAccessKey: z.string().min(1).max(256).optional(),
    sessionToken: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type AwsProviderCredentials = z.infer<typeof awsProviderCredentials>;

/** PUT /v1/settings/secret-providers/aws. */
export const awsProviderPut = z
  .object({
    enabled: z.boolean().optional(),
    config: awsProviderConfig,
    credentials: awsProviderCredentials.optional(),
  })
  .strict();
export type AwsProviderPut = z.input<typeof awsProviderPut>;

// ── G3.2: GCP Secret Manager, Azure Key Vault, 1Password Connect, exec ─────

const credential = z.string().min(1).max(16384);

export const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export const gcpProviderConfig = z
  .object({
    /** Defaults to the service account's own project. */
    projectId: z.string().regex(GCP_PROJECT_RE, 'invalid GCP project id').optional(),
  })
  .strict();
export const gcpProviderCredentials = z.object({ serviceAccountJson: credential.optional() }).strict();
export const gcpProviderPut = z
  .object({ enabled: z.boolean().optional(), config: gcpProviderConfig.default({}), credentials: gcpProviderCredentials.optional() })
  .strict();
export type GcpProviderPut = z.input<typeof gcpProviderPut>;

/** Key Vault hosts per Azure cloud; the client secret is only ever sent to Entra ID and these. */
export const AZURE_VAULT_SUFFIXES = ['.vault.azure.net', '.vault.azure.cn', '.vault.usgovcloudapi.net'] as const;
const AZURE_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const azureProviderConfig = z
  .object({
    // providerBaseUrl has already dropped the trailing slash.
    vaultUrl: providerBaseUrl.refine(
      (u) => /^https:\/\/[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])?(\.vault\.azure\.net|\.vault\.azure\.cn|\.vault\.usgovcloudapi\.net)$/i.test(u),
      { message: 'must be https://<name>.vault.azure.net (or the China / US Gov equivalent)' },
    ),
    tenantId: z.string().regex(AZURE_ID_RE, 'tenantId must be a GUID'),
    clientId: z.string().regex(AZURE_ID_RE, 'clientId must be a GUID'),
  })
  .strict();
export const azureProviderCredentials = z.object({ clientSecret: credential.optional() }).strict();
export const azureProviderPut = z
  .object({ enabled: z.boolean().optional(), config: azureProviderConfig, credentials: azureProviderCredentials.optional() })
  .strict();
export type AzureProviderPut = z.input<typeof azureProviderPut>;

export const onePasswordProviderConfig = z.object({ address: providerBaseUrl }).strict();
export const onePasswordProviderCredentials = z.object({ token: credential.optional() }).strict();
export const onePasswordProviderPut = z
  .object({ enabled: z.boolean().optional(), config: onePasswordProviderConfig, credentials: onePasswordProviderCredentials.optional() })
  .strict();
export type OnePasswordProviderPut = z.input<typeof onePasswordProviderPut>;

/** The placeholder replaced by the reference name inside an exec argument. */
export const EXEC_NAME_PLACEHOLDER = '{name}';

export const execProviderConfig = z
  .object({
    /** argv, run without a shell. The first element is an absolute path. */
    command: z
      .array(z.string().min(1).max(1024).regex(/^[^\0\r\n]*$/, 'no NUL or newline'))
      .min(1)
      .max(32)
      .refine((argv) => argv[0]!.startsWith('/'), { message: 'command[0] must be an absolute path' }),
    timeoutSeconds: z.number().int().min(1).max(60).default(10),
  })
  .strict();
export const execProviderPut = z
  .object({ enabled: z.boolean().optional(), config: execProviderConfig, credentials: z.object({}).strict().optional() })
  .strict();
export type ExecProviderPut = z.input<typeof execProviderPut>;

// ── Test and views ─────────────────────────────────────────────────────────

/** POST /v1/settings/secret-providers/:kind/test. Every probe is optional. */
export const secretProviderTestRequest = z
  .object({
    /** vault: also read this path (relative to the mount). */
    probePath: vaultPath.optional(),
    /** aws: also read this secret. */
    probeSecretId: awsSecretId.optional(),
    /** aws: also read this Parameter Store parameter (G3.2). */
    probeParameter: z.string().regex(/^[A-Za-z0-9/_.-]{1,2048}$/, 'invalid parameter name').optional(),
    /** gcp, azure, onepassword, exec: also resolve this reference name (G3.2). */
    probeName: z.string().min(1).max(2048).regex(/^[^}#]*$/, 'invalid reference name').optional(),
  })
  .strict();
export type SecretProviderTestRequest = z.infer<typeof secretProviderTestRequest>;

export const secretProviderTestResult = z.object({
  ok: z.boolean(),
  /** Redacted; response bodies cut to 200 characters. */
  detail: z.string(),
});
export type SecretProviderTestResult = z.infer<typeof secretProviderTestResult>;

/** One element of GET /v1/settings/secret-providers. Never carries a credential. */
export const secretProviderView = z.object({
  kind: secretProviderKind,
  configured: z.boolean(),
  enabled: z.boolean(),
  /** Non-secret settings; `{}` when unconfigured. */
  config: z.record(z.string(), z.unknown()),
  hasCredential: z.boolean(),
  lastTestedAt: z.string().nullable(),
  lastTestError: z.string().nullable(),
});
export type SecretProviderView = z.infer<typeof secretProviderView>;
