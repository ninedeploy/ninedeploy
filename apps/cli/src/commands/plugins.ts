import type { NineDeployClient } from '@ninedeploy/sdk';
import { table } from '../lib/format.js';

export async function pluginsList(client: NineDeployClient): Promise<void> {
  const { plugins } = await client.plugins.list();
  if (plugins.length === 0) {
    console.log('  No plugins installed.');
    return;
  }

  table(
    plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: `v${p.version}`,
      type: p.isOfficial ? 'Official' : 'Community',
      status: p.status,
    })),
    ['id', 'name', 'version', 'type', 'status'],
  );
}

export async function pluginsMarketplace(client: NineDeployClient): Promise<void> {
  const { catalog, live, keyId, fetchedAt } = await client.plugins.marketplace();
  if (catalog.length === 0) {
    console.log('  Marketplace catalog is currently empty.');
    return;
  }

  // Surface the source (live signed index vs. static
  // fallback) so the operator knows whether a planned
  // install was discovered automatically or is a
  // roadmap item.
  const source = live
    ? `live signed index (key=${keyId ?? 'unknown'})`
    : 'static fallback (upstream unreachable or NINEDEPLOY_MARKETPLACE_URL not set)';
  console.log(`  Source: ${source}`);
  if (fetchedAt) {
    const ageMin = Math.max(0, Math.round((Date.now() - fetchedAt) / 60_000));
    console.log(`  Fetched: ${ageMin} min ago`);
  }
  console.log();

  table(
    catalog.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      version: `v${c.version}`,
      type: c.isOfficial ? 'Official' : 'Community',
      status: c.isInstalled ? '✓ Installed' : 'Available',
    })),
    ['id', 'name', 'category', 'version', 'type', 'status'],
  );
}

/** `ninedeploy plugins marketplace refresh` — bypass the
 *  5-minute cache and re-fetch the live signed index. */
export async function pluginsMarketplaceRefresh(client: NineDeployClient): Promise<void> {
  const res = await client.plugins.marketplace({ refresh: true });
  console.log(
    `  ✓ Refreshed (${res.catalog.length} entries, live=${res.live}, keyId=${res.keyId ?? 'n/a'}).`,
  );
}

export async function pluginsInstall(
  client: NineDeployClient,
  target: string,
  opts: { source?: 'marketplace' | 'npm' | 'git' | 'local'; name?: string; version?: string; desc?: string },
): Promise<void> {
  const source = opts.source ?? 'marketplace';
  const res = await client.plugins.install({
    source,
    target,
    name: opts.name,
    version: opts.version,
    description: opts.desc,
  });
  console.log(`  ✓ Installed plugin "${res.id}" (status: ${res.status}).`);
}

export async function pluginsEnable(client: NineDeployClient, id: string): Promise<void> {
  const res = await client.plugins.enable(id);
  console.log(`  ✓ Plugin "${res.id}" enabled.`);
}

export async function pluginsDisable(client: NineDeployClient, id: string): Promise<void> {
  const res = await client.plugins.disable(id);
  console.log(`  ✓ Plugin "${res.id}" disabled.`);
}

export async function pluginsUninstall(client: NineDeployClient, id: string): Promise<void> {
  const res = await client.plugins.uninstall(id);
  console.log(`  ✓ Plugin "${res.id}" uninstalled.`);
}

export async function pluginsInspect(client: NineDeployClient, id: string): Promise<void> {
  const p = await client.plugins.inspect(id);
  console.log(`  Plugin:       ${p.name} (${p.id})`);
  console.log(`  Version:      v${p.version}`);
  console.log(`  Type:         ${p.isOfficial ? 'Official' : 'Community'}`);
  console.log(`  Status:       ${p.status}${p.enabled ? ' (enabled)' : ' (disabled)'}`);
  console.log(`  Author:       ${p.author ?? 'N/A'}`);
  console.log(`  Description:  ${p.description ?? 'N/A'}`);
  console.log(`  Dependencies: ${p.dependencies.length > 0 ? p.dependencies.join(', ') : 'none'}`);
  console.log(`  Tapped Hooks: ${p.hooks.length > 0 ? p.hooks.join(', ') : 'none'}`);
  console.log(`  Backgrounds:  ${p.services.length > 0 ? p.services.join(', ') : 'none'}`);
  console.log(`  Config Keys:  ${p.configSchema.length} registered`);
  console.log(`  Nav Menus:    ${p.menus.length} registered`);
  if (p.error) {
    console.log(`  Error:        ${p.error}`);
  }
  // r286: null = the kernel does not track this per plugin.
  console.log(`  Events Run:   ${p.runtimeStats.eventsHandled ?? 'not tracked'}`);
  console.log(`  Uptime:       ${p.runtimeStats.uptimeSeconds == null ? 'not tracked' : `${p.runtimeStats.uptimeSeconds}s`}`);
}

export async function pluginsReload(client: NineDeployClient, id: string): Promise<void> {
  const res = await client.plugins.reload(id);
  console.log(`  ✓ Plugin "${res.id}" reloaded (status: ${res.status}).`);
}
