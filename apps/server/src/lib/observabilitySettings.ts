import { configEntries, type DB } from '@ninedeploy/db';
import { observabilitySettings, type ObservabilitySettings, type ObservabilityView } from '@ninedeploy/schemas';
import { eq } from 'drizzle-orm';
import { decrypt } from './crypto.js';

export const OBSERVABILITY_CONFIG_KEY = 'observability.settings';
export const OBSERVABILITY_DEFAULTS = observabilitySettings.parse({});

/** The whole record is a config-center secret so token rotation uses the existing keyring path. */
export async function readObservabilitySettings(db: DB): Promise<ObservabilitySettings> {
  const row = await db.query.configEntries.findFirst({ where: eq(configEntries.key, OBSERVABILITY_CONFIG_KEY) });
  if (!row) return { ...OBSERVABILITY_DEFAULTS };
  // Fail closed on an unreadable configured record; never export with a missing credential.
  if (!row.isSecret) throw new Error('Observability settings must be encrypted');
  return observabilitySettings.parse(JSON.parse(decrypt(row.value)));
}

export function publicObservabilitySettings(value: ObservabilitySettings): ObservabilityView {
  const { otlpAuthorization, ...rest } = value;
  return { ...rest, hasOtlpAuthorization: otlpAuthorization.length > 0 };
}
