import { z, type ZodType } from 'zod';
import type { DB } from '@ninedeploy/db';
import {
  ciPipeline,
  composeRoute,
  errorPagesInput,
  forwardAuthConfig,
  githubRunnerConfig,
  imageScanResult,
  maintenanceConfig,
  restartLimitConfig,
} from '@ninedeploy/schemas';
import { createLogger } from './log.js';
import { OWNED_SETTINGS } from './ownedSettings.js';
import { getSettingJson } from './settings.js';

/**
 * COMPETITIVE_ROADMAP_2026-11 S1: the stored shape of every per-entity
 * settings prefix declared in lib/ownedSettings.ts, as its writer writes it.
 *
 * A row read through {@link readOwnedSettingJson} that does not match reads
 * as the fallback and is logged once per key, instead of being handed to the
 * feature as whatever it happens to hold (`getSettingJson<T>` only casts).
 * The schemas require what readers rely on and are no stricter than what any
 * release wrote, so an upgrade never turns a valid row into the fallback.
 *
 * Readers with their own zod parse of the same shape (restart limit,
 * maintenance, error pages, CI pipeline, forward auth, compose route, GitHub
 * runners) keep it; the entries below still declare their shape. String rows
 * (`inline_dockerfile:`, `sticky_session:`) are read with getSettingString.
 *
 * test/ownedSettingSchemas.test.ts fails when a declared prefix has no entry.
 */

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const isoish = z.string().min(1).max(64);

export const OWNED_SETTING_SCHEMAS: Readonly<Record<string, ZodType>> = {
  // Services
  'restart_limit:': restartLimitConfig.extend({ trippedAt: z.string().nullable().optional() }),
  'maintenance:': maintenanceConfig.extend({ since: z.string().nullable().optional() }),
  'error_pages:': errorPagesInput,
  'inline_dockerfile:': z.string(),
  'commit_status:': z.object({ enabled: z.boolean() }).passthrough(),
  'ci_pipeline:': ciPipeline.nullable(),
  'sticky_session:': z.string(),
  'registry_hook:': z.object({ tokenSha256: sha256Hex, userId: z.number().int(), operator: z.boolean().optional(), createdAt: isoish.optional(), lastPushAt: z.string().nullable().optional() }).passthrough(),
  'error_ingest:': z.object({ keyHash: sha256Hex, createdAt: isoish }).passthrough(),
  'pending_changes:': z.object({ patch: z.record(z.string(), z.unknown()) }).passthrough(),
  'image_scan:': imageScanResult,
  'service_move:': z.object({ state: z.string() }).passthrough(),
  // Domains
  'forward_auth:': forwardAuthConfig,
  'compose_route:': composeRoute,
  // Databases
  'backup_replicas:': z.object({ replicas: z.array(z.unknown()) }).passthrough(),
  // GitHub Apps
  'github_runners:': githubRunnerConfig.partial(),
  // Workspaces
  'workspace_2fa:': z.object({ required: z.boolean() }).passthrough(),
  'access_grants.idp_suspended.ws': z.record(z.string(), z.array(z.number().int())),
  'access_grants.admin_suspended.ws': z.array(z.number().int()),
  'scim.suspended.ws': z.record(z.string(), z.string()),
  // SSO / OIDC
  'saml_identity:': z.object({ userId: z.number().int(), fingerprint: z.string() }).passthrough(),
  'oidc.allowed_domains.': z.array(z.string()),
  // Alert rules
  'alert_investigation:': z.object({ at: z.string(), analysis: z.string() }).passthrough(),
};

const log = createLogger('settings');
const warned = new Set<string>();

/** For tests. */
export function resetOwnedSettingWarnings(): void {
  warned.clear();
}

/** The declaration a key belongs to (the longest declared prefix it starts with). */
export function ownedSettingPrefixOf(key: string): string | null {
  let best: string | null = null;
  for (const def of OWNED_SETTINGS) if (key.startsWith(def.prefix) && (!best || def.prefix.length > best.length)) best = def.prefix;
  return best;
}

/**
 * Read a JSON row of a declared prefix through its schema. A missing row, or
 * one that does not match, is `fallback`; a mismatch is logged once per key.
 * Throws for a key no prefix declares (a programming error, not data).
 */
export async function readOwnedSettingJson<T>(db: DB, key: string, fallback: T): Promise<T> {
  const prefix = ownedSettingPrefixOf(key);
  const schema = prefix ? OWNED_SETTING_SCHEMAS[prefix] : undefined;
  if (!prefix || !schema) throw new Error(`No declared settings prefix for ${key}`);
  const raw = await getSettingJson<unknown>(db, key, null);
  if (raw === null || raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data as T;
  if (!warned.has(key)) {
    warned.add(key);
    log.warn(`settings row ${key} does not match the ${prefix} shape; it reads as unset (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  }
  return fallback;
}
