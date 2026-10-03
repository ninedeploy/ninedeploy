/**
 * The installable template catalog: curated registry + community imports.
 *
 * r330: `GET /templates` merged community contributions (G-13) into the Hub
 * list, but the detail route, the prepare/deploy route and the worker's
 * dependency reconcile looked up `getTemplates()` alone — a community entry
 * showed in the Hub, then 404'd the moment it was opened or deployed. Every
 * id lookup now goes through this one merge so the list and the lookups
 * cannot disagree again.
 *
 * Precedence is the list's rule: a community entry whose `id` collides with
 * a curated one is dropped (the curated entry wins), so an imported file can
 * never shadow a shipped template.
 */
import type { DB } from '@ninedeploy/db';
import { listCommunityTemplates } from '../lib/communityTemplates.js';
import { getTemplates, type Template } from './registry.js';

export async function getCatalogTemplates(db: DB | null): Promise<Template[]> {
  const curated = await getTemplates(db);
  const curatedIds = new Set(curated.map((t) => t.id));
  const community = (await listCommunityTemplates()).entries
    .filter((e) => !curatedIds.has(e.id))
    .map((e) => e.template);
  return [...curated, ...community];
}

export async function findCatalogTemplate(db: DB | null, id: string): Promise<Template | undefined> {
  return (await getCatalogTemplates(db)).find((t) => t.id === id);
}
