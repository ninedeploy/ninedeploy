import { createDb, runMigrations, services, users, configEntries } from '@ninedeploy/db';
import { encrypt } from '../../src/lib/crypto.js';
import { OBSERVABILITY_CONFIG_KEY } from '../../src/lib/observabilitySettings.js';
import { observabilitySettings, type ObservabilityPatch } from '@ninedeploy/schemas';

export async function observabilityDb(url = 'file::memory:') {
  const connection = createDb({ url });
  await connection.ready;
  await runMigrations(connection.db);
  await connection.db.insert(users).values([
    { id: 1, email: 'operator@example.test', passwordHash: 'test', isOperator: true },
    { id: 2, email: 'member@example.test', passwordHash: 'test' },
  ]);
  await connection.db.insert(services).values({
    id: 1, name: 'Web', slug: 'web', ownerUserId: 1, type: 'docker', status: 'running', runtimeId: 'web-7', replicas: 1,
  });
  const configure = async (patch: ObservabilityPatch) => {
    const value = encrypt(JSON.stringify(observabilitySettings.parse(patch)));
    await connection.db.insert(configEntries).values({
      key: OBSERVABILITY_CONFIG_KEY, value, isSecret: true, category: 'monitoring',
    }).onConflictDoUpdate({ target: configEntries.key, set: { value, isSecret: true } });
  };
  return { ...connection, configure, close: () => connection.client!.close() };
}
