import type { NineDeployClient } from '@ninedeploy/sdk';
import { table } from '../lib/format.js';

export async function configCenterList(
  client: NineDeployClient,
  opts: { category?: string; plugin?: string; reveal?: boolean },
): Promise<void> {
  const { entries } = await client.config.list({
    category: opts.category,
    pluginId: opts.plugin,
    reveal: opts.reveal,
  });

  if (entries.length === 0) {
    console.log('  No configuration entries found.');
    return;
  }

  table(
    entries.map((e) => ({
      key: e.key,
      category: e.category,
      type: e.type,
      secret: e.isSecret ? 'yes' : 'no',
      value: String(e.value ?? ''),
      status: e.isConfigured ? 'configured' : 'default',
    })),
    ['key', 'category', 'type', 'secret', 'value', 'status'],
  );
}

export async function configCenterGet(client: NineDeployClient, key: string): Promise<void> {
  const item = await client.config.get(key);
  console.log(`  Key:         ${item.key}`);
  console.log(`  Label:       ${item.label}`);
  console.log(`  Category:    ${item.category}`);
  console.log(`  Type:        ${item.type}`);
  console.log(`  Secret:      ${item.isSecret ? 'yes' : 'no'}`);
  console.log(`  Value:       ${String(item.value ?? '')}`);
  console.log(`  Status:      ${item.isConfigured ? 'configured' : 'default'}`);
  if (item.description) console.log(`  Description: ${item.description}`);
  if (item.tags.length > 0) console.log(`  Tags:        ${item.tags.join(', ')}`);
}

export async function configCenterSet(
  client: NineDeployClient,
  key: string,
  value: string,
  opts: { secret?: boolean; desc?: string; tags?: string },
): Promise<void> {
  let parsedValue: unknown = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (!Number.isNaN(Number(value)) && value.trim() !== '') parsedValue = Number(value);

  const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;

  const res = await client.config.set(key, {
    value: parsedValue,
    isSecret: opts.secret,
    description: opts.desc,
    tags,
  });

  console.log(`  ✓ Configuration key "${res.key}" saved.`);
}

export async function configCenterDelete(client: NineDeployClient, key: string): Promise<void> {
  const res = await client.config.delete(key);
  console.log(`  ✓ Configuration key "${res.key}" deleted.`);
}
