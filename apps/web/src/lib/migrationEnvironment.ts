import { ENV_IMPORT_MAX_CHARS, createAttachment, sourceDatabaseHosts, upsertEnvVar, type ImportPlan } from '@ninedeploy/schemas';
import type { NineDeployClient } from '@ninedeploy/sdk';
import type { PreparedImportService } from './prepareImportResources.js';

export class InvalidMigrationEnvironment extends Error {}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

/** A selected file is data. Only single-line entries, quotes and comments are interpreted. */
export function readMigrationEnvironment(content: string, plan: ImportPlan, target: PreparedImportService) {
  const planned = new Set(target.service.env.map(({ key }) => key));
  const aliases = new Set(target.bindings.map(({ alias }) => alias));
  const sourceHosts = new Set(plan.databases.flatMap((db) => sourceDatabaseHosts(plan.source.kind, db)));
  const sourcePanel = plan.source.kind === 'heroku' ? undefined : parseUrl(plan.source.url)?.hostname.toLowerCase();
  const allKeys = new Set<string>();
  const lines = new Map<string, string>();
  const references: string[] = [];
  const invalid: string[] = [];
  let extra = 0;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const entry = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!entry) throw new InvalidMigrationEnvironment();
    const key = entry[1]!;
    const rawValue = entry[2]!;
    const quoted = /^(["'])(.*?)\1[ \t]*(?:#.*)?$/.exec(rawValue);
    if (/^["']/.test(rawValue) && !quoted) throw new InvalidMigrationEnvironment();
    if (allKeys.has(key)) throw new InvalidMigrationEnvironment();
    allKeys.add(key);
    if (aliases.has(key)) continue;
    if (!planned.has(key)) { extra++; continue; }
    const value = quoted ? quoted[2]! : rawValue.replace(/(?:^|[ \t]+)#.*$/, '').trimEnd();
    if (!upsertEnvVar.safeParse({ key, value }).success || value.includes('\r') || value.includes('\0')) { invalid.push(key); continue; }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? parseUrl(value) : null;
    const host = (url?.hostname ?? value.replace(/:\d+$/, '')).toLowerCase().replace(/^\[|\]$/g, '');
    if (sourceHosts.has(host) || (sourcePanel === host && !/^https?:$/.test(url?.protocol ?? ''))) { references.push(key); continue; }
    // The server strips one pair of matching outer quotes and leaves the value intact.
    lines.set(key, `${key}='${value}'`);
  }
  return { lines, references, invalid, extra, missing: [...planned].filter((key) => !allKeys.has(key) && !aliases.has(key)) };
}

export async function applyMigrationEnvironment(
  api: Pick<NineDeployClient, 'services' | 'databases' | 'attachments' | 'env'>,
  target: PreparedImportService,
  lines: Map<string, string>,
  isActive: () => boolean,
) {
  const ensureActive = () => { if (!isActive()) throw new Error('Migration session changed'); };
  ensureActive();
  const [service, stored, attachments, databases] = await Promise.all([
    api.services.get(target.id), api.env.list(target.id), api.attachments.list(target.id),
    target.bindings.length ? api.databases.list() : Promise.resolve([]),
  ]);
  ensureActive();
  if (service.id !== target.id || service.slug !== target.slug || service.type !== target.service.create.type) throw new Error('Migration target changed');
  const keys = new Set(stored.map(({ key }) => key));
  const occupiedAliases = new Set(attachments.map(({ envAlias }) => envAlias));
  const sameRequest = (alias: string, databaseId: number) => attachments.some((item) => item.envAlias === alias && item.databaseId === databaseId);
  const importedLines = [...lines].filter(([key]) => !keys.has(key) && !occupiedAliases.has(key));
  const content = importedLines.map(([, line]) => line).join('\n');
  if (content.length > ENV_IMPORT_MAX_CHARS) throw new InvalidMigrationEnvironment();
  const retained = lines.size - importedLines.length;
  let imported = 0;
  let skipped = retained;
  let errors = 0;
  let envFailed = false;
  if (content) {
    try {
      const result = await api.env.import(target.id, content, { isSecret: true, overwriteExisting: false });
      imported = result.imported;
      skipped += result.skipped;
      errors = result.errors.length;
    } catch { envFailed = true; }
  }

  const outcomes: Array<{ alias: string; status: 'attached' | 'missing' | 'conflict' | 'failed' }> = [];
  const seen = new Set<string>();
  for (const { alias, database } of target.bindings) {
    ensureActive();
    if (seen.has(alias)) continue;
    seen.add(alias);
    if (target.bindings.some((item) => item.alias === alias && item.database?.id !== database?.id)) {
      outcomes.push({ alias, status: 'conflict' });
      continue;
    }
    const live = database && databases.find(({ id, slug, engine, status }) => id === database.id && slug === database.slug && engine === database.engine && status === 'running');
    if (!live) { outcomes.push({ alias, status: 'missing' }); continue; }
    if (sameRequest(alias, live.id)) { outcomes.push({ alias, status: 'attached' }); continue; }
    if (keys.has(alias) || occupiedAliases.has(alias) || attachments.some(({ databaseId }) => databaseId === live.id)) {
      outcomes.push({ alias, status: 'conflict' });
      continue;
    }
    const input = createAttachment.safeParse({ databaseId: live.id, envAlias: alias });
    if (!input.success) { outcomes.push({ alias, status: 'conflict' }); continue; }
    try {
      const attached = await api.attachments.create(target.id, input.data);
      attachments.push({ ...attached, database: null });
      occupiedAliases.add(attached.envAlias);
      outcomes.push({ alias, status: attached.databaseId === live.id && attached.envAlias === alias ? 'attached' : 'conflict' });
    } catch {
      outcomes.push({ alias, status: 'failed' });
    }
  }
  return { imported, skipped, errors, envFailed, outcomes };
}
