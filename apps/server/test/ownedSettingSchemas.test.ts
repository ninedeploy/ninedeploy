/**
 * S1 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): every per-entity settings
 * prefix declares the shape its writer stores, and a row that does not match
 * reads as unset (logged once) instead of reaching the feature as a cast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const { OWNED_SETTINGS } = await import('../src/lib/ownedSettings.js');
const { OWNED_SETTING_SCHEMAS, ownedSettingPrefixOf, readOwnedSettingJson, resetOwnedSettingWarnings } = await import('../src/lib/ownedSettingSchemas.js');
const { getCommitStatusSetting, setCommitStatusSetting } = await import('../src/lib/gitCommitStatus.js');
const { ingestKeyInfo, ingestKeyMatches, rotateIngestKey } = await import('../src/lib/errorIngest.js');
const { createRegistryHook, getRegistryHook } = await import('../src/lib/registryHooks.js');
const { linkSamlIdentity, linkedSamlUser } = await import('../src/lib/samlLogin.js');
const { setSettingJson } = await import('../src/lib/settings.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const H = 'a'.repeat(64);
const NOW = '2026-11-12T10:00:00.000Z';
const counts = { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 };

/** One value per prefix, as its writer stores it. */
const WRITTEN: Record<string, unknown> = {
  'restart_limit:': { maxRestarts: 3, windowMinutes: 10, trippedAt: null },
  'maintenance:': { title: 'Down', message: 'Back soon', retryAfterSeconds: 300, bypass: [], since: NOW },
  'error_pages:': { pages: { '502': '<h1>x</h1>' } },
  'inline_dockerfile:': 'FROM nginx:1.27\n',
  'commit_status:': { enabled: true },
  'ci_pipeline:': null,
  'sticky_session:': 'true',
  'registry_hook:': { tokenSha256: H, userId: 1, operator: true, createdAt: NOW },
  'error_ingest:': { keyHash: H, createdAt: NOW },
  'pending_changes:': { staging: true, patch: { name: 'x' }, stagedBy: 1, updatedAt: NOW, updatedByUserId: 1 },
  'image_scan:': {
    serviceId: 5, imageId: 'sha256:abc', scannedAt: NOW, trigger: 'deploy', deploymentId: 9, status: 'ok', error: null, os: 'debian 12',
    counts, fixable: counts, findings: [], findingsTruncated: false, blocked: false,
  },
  'service_move:': { state: 'done', from: null, to: 2, step: null, error: null, startedAt: NOW, finishedAt: NOW, deploymentId: 4 },
  'forward_auth:': { minRole: 'viewer' },
  'compose_route:': { service: 'web', port: 80 },
  'backup_replicas:': { replicas: [], copies: {} },
  'github_runners:': {},
  'workspace_2fa:': { required: true, ssoExemptProviders: [] },
  'access_grants.idp_suspended.ws': { '7': [1, 2] },
  'access_grants.admin_suspended.ws': [3, 4],
  'scim.suspended.ws': { '12': 'member' },
  'saml_identity:': { userId: 3, fingerprint: H },
  'oidc.allowed_domains.': ['example.com'],
  'alert_investigation:': { at: NOW, model: 'm', value: 91, analysis: 'cpu bound' },
};
/** A value no writer stores; each schema refuses it. */
const JUNK: Record<string, unknown> = Object.fromEntries(Object.keys(WRITTEN).map((p) => [p, typeof WRITTEN[p] === 'string' ? 42 : 'not a value']));

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  resetOwnedSettingWarnings();
});
afterEach(() => closeMigratedDb(db));

describe('OWNED_SETTING_SCHEMAS', () => {
  it('declares a stored shape for every owned prefix, and nothing else', () => {
    expect(Object.keys(OWNED_SETTING_SCHEMAS).sort()).toEqual(OWNED_SETTINGS.map((d) => d.prefix).sort());
  });

  it('accepts what each writer stores and refuses what none does', () => {
    for (const prefix of Object.keys(OWNED_SETTING_SCHEMAS)) {
      expect(OWNED_SETTING_SCHEMAS[prefix]!.safeParse(WRITTEN[prefix]).success, `${prefix} accepts its written value`).toBe(true);
      expect(OWNED_SETTING_SCHEMAS[prefix]!.safeParse(JUNK[prefix]).success, `${prefix} refuses junk`).toBe(false);
    }
  });

  it('finds the most specific declared prefix of a key', () => {
    expect(ownedSettingPrefixOf('restart_limit:5')).toBe('restart_limit:');
    expect(ownedSettingPrefixOf('access_grants.admin_suspended.ws3')).toBe('access_grants.admin_suspended.ws');
    expect(ownedSettingPrefixOf('image_scan_policy')).toBeNull();
  });
});

describe('readOwnedSettingJson', () => {
  it('returns a valid row, the fallback for a missing one, and refuses an undeclared key', async () => {
    await setSettingJson(db, 'commit_status:5', { enabled: true });
    expect(await readOwnedSettingJson(db, 'commit_status:5', null)).toEqual({ enabled: true });
    expect(await readOwnedSettingJson(db, 'commit_status:6', 'unset')).toBe('unset');
    await expect(readOwnedSettingJson(db, 'image_scan_policy', null)).rejects.toThrow(/No declared settings prefix/);
  });

  it('reads a row that does not match as the fallback and logs it once per key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await db.insert(settings).values({ key: 'error_ingest:5', value: { keyHash: 12 } as unknown as boolean, updatedAt: new Date() });
      expect(await readOwnedSettingJson(db, 'error_ingest:5', null)).toBeNull();
      expect(await readOwnedSettingJson(db, 'error_ingest:5', null)).toBeNull();
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('error_ingest:5'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/does not match the error_ingest: shape; it reads as unset/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('features that used to cast their row', () => {
  it('round-trip through their own writers', async () => {
    await setCommitStatusSetting(db, 5, { enabled: true });
    expect(await getCommitStatusSetting(db, 5)).toEqual({ enabled: true });
    const key = await rotateIngestKey(db, 5);
    expect(await ingestKeyMatches(db, 5, key)).toBe(true);
    expect((await ingestKeyInfo(db, 5))?.createdAt).toMatch(/^\d{4}-/);
    await createRegistryHook(db, 5, { id: 1, isOperator: true });
    expect(await getRegistryHook(db, 5)).toMatchObject({ userId: 1, operator: true });
    await linkSamlIdentity(db, 3, 'subject-a', 7, H);
    expect(await linkedSamlUser(db, 3, 'subject-a', H)).toEqual({ userId: 7 });
  });

  it('treat a corrupt row as unset instead of failing or trusting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const put = (key: string, value: unknown) => db.insert(settings).values({ key, value: value as boolean, updatedAt: new Date() });
      await put('commit_status:5', { enabled: 'yes' });
      // Before S1 a key hash that is not hex reached Buffer.from(…, 'hex') and the comparison threw.
      await put('error_ingest:5', { keyHash: null, createdAt: NOW });
      await put('registry_hook:5', { tokenSha256: 'short', userId: 1 });
      expect(await getCommitStatusSetting(db, 5)).toEqual({ enabled: false });
      expect(await ingestKeyMatches(db, 5, 'f'.repeat(32))).toBe(false);
      expect(await ingestKeyInfo(db, 5)).toBeNull();
      expect(await getRegistryHook(db, 5)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
